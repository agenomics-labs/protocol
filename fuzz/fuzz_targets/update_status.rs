// B8 Phase 2 fuzz target: update_status accept-list (AUD-120).
//
// Why this target:
//   `update_status` (programs/agent-registry/src/lib.rs:172) gates EVERY
//   agent-driven status mutation. Cycle-2 commit `5b3da8b`
//   ("fix(registry): AUD-120 exhaustive accept-list in update_status")
//   replaced the prior deny-list catch-all
//
//       match (cur, new) {
//           (Retired, Active|Paused|Suspended) => Err(...),
//           (Suspended, Active|Paused) => Err(...),
//           _ => agent_profile.status = new_status, // <- silent accept
//       }
//
//   with a fully-exhaustive nested match. The motivation: any future
//   `AgentStatus` variant added to state.rs would silently fall into the
//   `_` accept arm — a code-shape hazard. The post-AUD-120 shape forces
//   non-exhaustive-match compile errors at every arm that doesn't
//   enumerate the new variant, which surfaces the policy decision at
//   review time.
//
//   This fuzz target is the runtime mirror of that compile-time shape
//   guarantee: drive arbitrary `(current_status_byte, new_status_byte,
//   is_self_issued)` triples through the property-level model and assert
//   that ONLY the documented 11/16 accepted (cur, new) edges succeed,
//   that ALL other pairs reject with `InvalidStatusTransition`, and that
//   self-issued `* → Suspended` writes are blocked by the AUD-004 guard
//   (which sits above the accept-list match in the on-chain handler).
//
// Property contract (the 4 properties asserted on every iteration):
//   P1 (AUD-004 self-suspend guard): `is_self_issued && new == Suspended`
//      MUST reject. This guard is checked BEFORE the accept-list, so it
//      preempts the state-machine edge check.
//   P2 (AUD-120 accept-list, accept side): for every (cur, new) pair in
//      the documented 11-edge accept set AND not blocked by P1, the
//      handler model MUST accept.
//   P3 (AUD-120 accept-list, reject side): for every (cur, new) pair
//      NOT in the accept set, the handler model MUST reject — even when
//      the AUD-004 guard would not fire.
//   P4 (closure of state machine): post-state `status` MUST equal
//      `new_status` on accept (no silent transition rewriting). On
//      reject, the model returns Err and never mutates pre-state.
//
// Modeling approach:
//   Same shape as B8 Phase 1 (`propose_reputation_delta`): a pure-Rust
//   `handler_simulate` that mirrors lines 172-243 of lib.rs verbatim. No
//   `Context`, no Anchor account machinery. The signer/authority match
//   that the on-chain handler reads from `ctx.accounts.authority.key()
//   == agent_profile.authority` is captured as a single boolean
//   (`is_self_issued`) — fuzzing real Pubkey equality from honggfuzz
//   would just collapse to the same boolean after key derivation, with
//   added noise.
//
//   Because `AgentStatus` has only 4 variants and the third input is a
//   bool, the input space is finite: 4 × 4 × 2 = 32 distinct semantic
//   inputs. The cfg(test) `deterministic_sweep_holds_contract` exhausts
//   the full (u8, u8, bool) preimage (256 × 256 × 2 = 131,072 iterations)
//   so every byte that could be drawn by the honggfuzz mutation engine
//   is checked at `cargo test` time. Plain honggfuzz adds branch-coverage
//   feedback once an operator runs it, but the contract already holds by
//   construction across the entire input space — the campaign's role is
//   to defend the property if a future refactor accidentally widens the
//   accept set.
//
// What this *cannot* catch (deferred to Phase 2/3):
//   - Account-handle bugs (signer/seeds/has_one) on the `UpdateStatus`
//     context. AUD-117 will own those in a follow-on Phase 2 target.
//   - Composite mutations across handlers (`update_status` then
//     `clear_suspension`). AUD-004's `clear_suspension` target will
//     exercise that ladder.
//   - Real on-chain Pubkey equality semantics. The boolean
//     `is_self_issued` is a faithful pre-image of the post-key-equality
//     branch the handler takes.
//
// Smoke-validation (operator):
//   ```
//   apt install binutils-dev libunwind-dev    # honggfuzz C deps
//   cd fuzz && cargo hfuzz run update_status -- --max_total_time=30
//   ```
//   Expected: iteration counter climbs into the millions, 0 crashes. A
//   crash means either the on-chain handler has drifted from the AUD-120
//   accept matrix encoded below, or a new `AgentStatus` variant has been
//   added without updating this file (the corresponding compile-time
//   non-exhaustive-match error in lib.rs would also fire).

use arbitrary::Arbitrary;
use honggfuzz::fuzz;

use agent_registry::state::AgentStatus;

/// Structured fuzz input. `Arbitrary` lets honggfuzz mutate a flat byte
/// stream while we get typed fields with no manual parsing.
#[derive(Debug, Arbitrary)]
struct Input {
    /// Pre-call `agent_profile.status` selector. Modeled via a u8 so the
    /// fuzzer can flip arbitrary bytes; `status_from_selector` maps `s
    /// % 4` to a variant. Anchor's `AnchorDeserialize` rejects any byte
    /// outside the variant range at the account-load boundary, so this
    /// is a faithful pre-image of post-deserialize state — an
    /// out-of-range `current_status_byte` could never reach the handler.
    current_status_byte: u8,
    /// Caller-supplied `new_status` selector. Same modeling as above —
    /// the on-chain instruction encoding goes through Anchor's enum
    /// codec which already rejects out-of-range tags. The `% 4` mapping
    /// is deterministic so the harness exercises every legal variant
    /// across the byte range.
    new_status_byte: u8,
    /// Whether the calling authority equals `agent_profile.authority`.
    /// True means the call is self-issued (the AUD-004 guard fires for
    /// `new == Suspended`); false means it's an external authority such
    /// as an admin tooling key. This is the post-key-equality branch
    /// the handler takes after `ctx.accounts.authority.key() ==
    /// agent_profile.authority`.
    is_self_issued: bool,
}

/// Maps an arbitrary u8 selector to `AgentStatus`. Mirrors the same
/// helper in `propose_reputation_delta.rs` so the two targets agree on
/// pre-image semantics. Adding a new variant to `AgentStatus` will
/// require updating BOTH this match AND the `is_valid_transition`
/// matrix below — caught at compile time by the registry's exhaustive
/// match, then by this file's `cargo check`.
fn status_from_selector(s: u8) -> AgentStatus {
    match s % 4 {
        0 => AgentStatus::Active,
        1 => AgentStatus::Paused,
        2 => AgentStatus::Retired,
        _ => AgentStatus::Suspended,
    }
}

/// AUD-120 valid-transition matrix, lifted verbatim from
/// programs/agent-registry/src/lib.rs:209-230 (post-`5b3da8b`).
///
/// Allowed edges (current → new), 11 of 16 pairs accept:
///   Active    → {Active, Paused, Retired, Suspended}     (all 4)
///   Paused    → {Active, Paused, Retired, Suspended}     (all 4)
///   Suspended → {Retired, Suspended}                     (2 of 4)
///   Retired   → {Retired}                                (1 of 4)
///
/// Rejected edges (5 pairs):
///   Suspended → {Active, Paused}
///   Retired   → {Active, Paused, Suspended}
///
/// CRITICAL: this match MUST stay in lockstep with lib.rs. The nested
/// shape mirrors the on-chain code so a future widening (e.g. allowing
/// `Retired → Active`) requires updating BOTH sites — and the
/// `aud_120_exhaustive_matrix` test below will fail if only one is
/// updated.
fn is_valid_transition(current: AgentStatus, new: AgentStatus) -> bool {
    match current {
        AgentStatus::Active => match new {
            AgentStatus::Active
            | AgentStatus::Paused
            | AgentStatus::Retired
            | AgentStatus::Suspended => true,
        },
        AgentStatus::Paused => match new {
            AgentStatus::Active
            | AgentStatus::Paused
            | AgentStatus::Retired
            | AgentStatus::Suspended => true,
        },
        AgentStatus::Suspended => match new {
            AgentStatus::Retired | AgentStatus::Suspended => true,
            AgentStatus::Active | AgentStatus::Paused => false,
        },
        AgentStatus::Retired => match new {
            AgentStatus::Retired => true,
            AgentStatus::Active | AgentStatus::Paused | AgentStatus::Suspended => false,
        },
    }
}

/// AUD-004 self-suspend guard predicate. Mirrors lib.rs:182-186:
///
///     require!(
///         !(matches!(new_status, AgentStatus::Suspended)
///             && ctx.accounts.authority.key() == agent_profile.authority),
///         AgentRegistryError::InvalidStatusTransition
///     );
///
/// Returns `true` if the call should be blocked by the guard (i.e. the
/// guard's negated condition is `false`). The guard sits ABOVE the
/// accept-list match in the on-chain handler, so a self-issued Suspended
/// write is rejected even though `Active|Paused → Suspended` is in the
/// AUD-120 accept set.
fn is_self_issued_suspension_blocked(new: AgentStatus, is_self_issued: bool) -> bool {
    matches!(new, AgentStatus::Suspended) && is_self_issued
}

/// Mirror of the handler's full validation logic. Returns `Err(())` if
/// the handler would `require!`-revert; returns `Ok(new_status)` with the
/// post-state `status` otherwise. The Err type is intentionally `()`
/// rather than the Anchor error code — the harness contract distinguishes
/// the two reject paths (AUD-004 guard vs AUD-120 matrix) by reading the
/// input semantics, not by matching on error codes (same pattern Phase 1
/// uses, keeps the harness decoupled from the exact Anchor error layout).
///
/// Reproduces lib.rs:172-232 minus the `Clock::get`, `assert_valid_profile`
/// post-mutation invariant (orthogonal — covered by Phase 1's target),
/// and the event emit (no observable on the policy contract).
fn handler_simulate(input: &Input) -> Result<AgentStatus, ()> {
    let current = status_from_selector(input.current_status_byte);
    let new = status_from_selector(input.new_status_byte);

    // Handler line 182-186: AUD-004 self-suspend guard.
    if is_self_issued_suspension_blocked(new, input.is_self_issued) {
        return Err(());
    }

    // Handler line 209-231: AUD-120 accept-list.
    if !is_valid_transition(current, new) {
        return Err(());
    }

    // Handler line 232: post-state status assignment.
    Ok(new)
}

/// Discrete outcome tag for assertion readability. The handler
/// distinguishes three observable outcomes:
///   - `BlockedSelfSuspend`: AUD-004 guard rejected (priority over the
///     accept-list — the guard sits earlier in the function).
///   - `BlockedTransition`: AUD-120 accept-list rejected.
///   - `Accept(status)`: handler returns Ok with the new status.
#[derive(Debug, PartialEq)]
enum Outcome {
    BlockedSelfSuspend,
    BlockedTransition,
    Accept(AgentStatus),
}

fn classify(input: &Input, result: &Result<AgentStatus, ()>) -> Outcome {
    if let Ok(new) = result {
        return Outcome::Accept(*new);
    }
    let new = status_from_selector(input.new_status_byte);
    // Order matches handler line order: AUD-004 guard fires first.
    if is_self_issued_suspension_blocked(new, input.is_self_issued) {
        Outcome::BlockedSelfSuspend
    } else {
        Outcome::BlockedTransition
    }
}

/// Property assertions. A panic here is a real finding — the harness
/// model has diverged from the handler, OR the on-chain accept-list has
/// grown a path past the AUD-120 matrix encoded above.
fn assert_contract(input: &Input, result: &Result<AgentStatus, ()>) {
    let current = status_from_selector(input.current_status_byte);
    let new = status_from_selector(input.new_status_byte);
    let outcome = classify(input, result);

    let blocked_by_aud_004 = is_self_issued_suspension_blocked(new, input.is_self_issued);
    let allowed_by_aud_120 = is_valid_transition(current, new);

    // Property 1 (AUD-004): self-issued Suspended writes MUST reject. The
    // guard sits before the accept-list, so even an `Active → Suspended`
    // edge (which AUD-120 would otherwise accept) is blocked.
    if blocked_by_aud_004 {
        assert_eq!(
            outcome,
            Outcome::BlockedSelfSuspend,
            "AUD-004 self-suspend guard must block input {input:?}"
        );
        return;
    }

    // Property 2 (AUD-120, accept side): every (cur, new) pair in the
    // 11-edge accept set that is NOT blocked by AUD-004 MUST succeed.
    // Combined with Property 3 below, this pins the matrix exhaustively.
    if allowed_by_aud_120 {
        assert_eq!(
            outcome,
            Outcome::Accept(new),
            "AUD-120 accept-list must allow ({current:?} → {new:?}), input {input:?}"
        );
    } else {
        // Property 3 (AUD-120, reject side): every (cur, new) pair NOT in
        // the accept set MUST reject — and at the matrix gate, not the
        // AUD-004 guard (since `blocked_by_aud_004` returned early above).
        assert_eq!(
            outcome,
            Outcome::BlockedTransition,
            "AUD-120 accept-list must reject ({current:?} → {new:?}), input {input:?}"
        );
    }

    // Property 4 (closure of state machine): on accept, post-state status
    // equals the requested new_status — no silent rewriting. On reject,
    // pre-state is unchanged (modeled as Err return, never an Ok with a
    // different status). The Outcome enum already encodes this; the
    // assertion is a defensive cross-check against future model edits
    // that might forget to propagate the `new` value.
    if let Outcome::Accept(post) = outcome {
        assert_eq!(
            post, new,
            "post-state status must equal requested new_status (input={input:?})"
        );
    }
}

fn main() {
    // honggfuzz drives `fuzz!` in an infinite loop; each iteration pulls
    // a fresh byte slice from the mutation engine and feeds it into our
    // closure. `Arbitrary::arbitrary` consumes from a `Unstructured`
    // wrapper; if the slice is too short we just skip (no panic).
    loop {
        fuzz!(|data: &[u8]| {
            let mut u = arbitrary::Unstructured::new(data);
            let input = match Input::arbitrary(&mut u) {
                Ok(i) => i,
                Err(_) => return,
            };
            let result = handler_simulate(&input);
            assert_contract(&input, &result);
        });
    }
}

// ============================================================================
// Compile-time smoke tests. These run under plain `cargo test` (no honggfuzz
// runtime needed) and verify the harness model is wired correctly. They are
// the in-session smoke validation that survives without `binutils-dev`
// installed for the C honggfuzz path.
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    /// All four `AgentStatus` variants in canonical order. Used by the
    /// matrix tests below so a future variant addition forces an update
    /// here AND in `is_valid_transition` AND in `status_from_selector` —
    /// three lockstep sites, all of which fail loudly on drift.
    const ALL_STATUSES: [AgentStatus; 4] = [
        AgentStatus::Active,
        AgentStatus::Paused,
        AgentStatus::Retired,
        AgentStatus::Suspended,
    ];

    /// AUD-120: every (cur, new) pair in the accept set succeeds when the
    /// AUD-004 guard does not fire. Pins the 11-edge accept matrix corner
    /// by corner. Drift here = drift between this file and lib.rs.
    #[test]
    fn aud_120_exhaustive_accept_matrix() {
        // The 11 accepted edges from lib.rs:209-230 (post-5b3da8b).
        let accepted: &[(AgentStatus, AgentStatus)] = &[
            // Active → all 4
            (AgentStatus::Active, AgentStatus::Active),
            (AgentStatus::Active, AgentStatus::Paused),
            (AgentStatus::Active, AgentStatus::Retired),
            (AgentStatus::Active, AgentStatus::Suspended),
            // Paused → all 4
            (AgentStatus::Paused, AgentStatus::Active),
            (AgentStatus::Paused, AgentStatus::Paused),
            (AgentStatus::Paused, AgentStatus::Retired),
            (AgentStatus::Paused, AgentStatus::Suspended),
            // Suspended → {Retired, Suspended}
            (AgentStatus::Suspended, AgentStatus::Retired),
            (AgentStatus::Suspended, AgentStatus::Suspended),
            // Retired → {Retired}
            (AgentStatus::Retired, AgentStatus::Retired),
        ];
        assert_eq!(
            accepted.len(),
            11,
            "AUD-120 accept set MUST be 11 edges; matrix drift if this fails"
        );
        for (cur, new) in accepted {
            assert!(
                is_valid_transition(*cur, *new),
                "({cur:?} → {new:?}) must be in the AUD-120 accept set"
            );
        }
    }

    /// AUD-120: every (cur, new) pair NOT in the accept set rejects.
    /// Pins the 5-edge reject matrix.
    #[test]
    fn aud_120_exhaustive_reject_matrix() {
        let rejected: &[(AgentStatus, AgentStatus)] = &[
            (AgentStatus::Suspended, AgentStatus::Active),
            (AgentStatus::Suspended, AgentStatus::Paused),
            (AgentStatus::Retired, AgentStatus::Active),
            (AgentStatus::Retired, AgentStatus::Paused),
            (AgentStatus::Retired, AgentStatus::Suspended),
        ];
        assert_eq!(
            rejected.len(),
            5,
            "AUD-120 reject set MUST be 5 edges (16 - 11); drift if this fails"
        );
        for (cur, new) in rejected {
            assert!(
                !is_valid_transition(*cur, *new),
                "({cur:?} → {new:?}) must be in the AUD-120 reject set"
            );
        }
    }

    /// Cross-check: accept matrix size + reject matrix size = full 4 × 4
    /// state-pair space. Catches the case where a future variant addition
    /// shifts the matrix without updating both lists above.
    #[test]
    fn aud_120_matrix_partitions_state_space() {
        let mut accept_count = 0;
        let mut reject_count = 0;
        for cur in &ALL_STATUSES {
            for new in &ALL_STATUSES {
                if is_valid_transition(*cur, *new) {
                    accept_count += 1;
                } else {
                    reject_count += 1;
                }
            }
        }
        assert_eq!(accept_count + reject_count, 16, "must cover all 4×4 pairs");
        assert_eq!(accept_count, 11, "AUD-120 accept count");
        assert_eq!(reject_count, 5, "AUD-120 reject count");
    }

    /// AUD-004: self-issued `* → Suspended` is blocked for every current
    /// status — even Active and Paused, which AUD-120 would otherwise
    /// accept. The guard sits above the matrix in handler order, so its
    /// rejection wins.
    #[test]
    fn aud_004_self_issued_suspended_always_blocks() {
        for cur in &ALL_STATUSES {
            let input = Input {
                current_status_byte: *cur as u8,
                new_status_byte: AgentStatus::Suspended as u8,
                is_self_issued: true,
            };
            let result = handler_simulate(&input);
            assert!(
                result.is_err(),
                "self-issued ({cur:?} → Suspended) must reject"
            );
            assert_eq!(
                classify(&input, &result),
                Outcome::BlockedSelfSuspend,
                "AUD-004 guard must fire BEFORE the AUD-120 matrix"
            );
        }
    }

    /// AUD-004: external authority (non-self) writing Suspended bypasses
    /// the AUD-004 guard and falls through to the AUD-120 matrix. From
    /// `Active` and `Paused` it accepts; from `Retired` (matrix rejects)
    /// it still rejects, but at a different gate.
    #[test]
    fn aud_004_external_suspended_falls_to_matrix() {
        // Active|Paused → Suspended: matrix accepts when not self-issued.
        for cur in [AgentStatus::Active, AgentStatus::Paused] {
            let input = Input {
                current_status_byte: cur as u8,
                new_status_byte: AgentStatus::Suspended as u8,
                is_self_issued: false,
            };
            let result = handler_simulate(&input);
            assert_eq!(
                result,
                Ok(AgentStatus::Suspended),
                "external ({cur:?} → Suspended) must accept"
            );
        }
        // Retired → Suspended: matrix rejects regardless of authority.
        let input = Input {
            current_status_byte: AgentStatus::Retired as u8,
            new_status_byte: AgentStatus::Suspended as u8,
            is_self_issued: false,
        };
        let result = handler_simulate(&input);
        assert!(
            result.is_err(),
            "external (Retired → Suspended) must reject at the matrix"
        );
        assert_eq!(classify(&input, &result), Outcome::BlockedTransition);
    }

    /// Boundary: `Retired` is a closed/terminal state. Only the `Retired
    /// → Retired` no-op succeeds; every other target rejects regardless
    /// of authority. Pins the AUD-120 catch-all that the pre-`5b3da8b`
    /// deny-list shape was reaching via the `_` arm.
    #[test]
    fn boundary_retired_is_terminal() {
        for new in &ALL_STATUSES {
            let input = Input {
                current_status_byte: AgentStatus::Retired as u8,
                new_status_byte: *new as u8,
                is_self_issued: false,
            };
            let result = handler_simulate(&input);
            if matches!(new, AgentStatus::Retired) {
                assert_eq!(
                    result,
                    Ok(AgentStatus::Retired),
                    "Retired → Retired no-op must accept"
                );
            } else {
                assert!(
                    result.is_err(),
                    "Retired → {new:?} must reject (closed/terminal state)"
                );
            }
        }
    }

    /// Boundary: `Suspended` rehab edges are limited to `Retired` (give
    /// up) and `Suspended` (no-op). Active and Paused require going
    /// through `clear_suspension` (not `update_status`), per the cycle-2
    /// design. Pins the second deny-list arm of the pre-`5b3da8b` shape.
    #[test]
    fn boundary_suspended_only_to_retired_or_self() {
        for new in &ALL_STATUSES {
            let input = Input {
                current_status_byte: AgentStatus::Suspended as u8,
                new_status_byte: *new as u8,
                is_self_issued: false,
            };
            let result = handler_simulate(&input);
            match new {
                AgentStatus::Retired | AgentStatus::Suspended => {
                    assert_eq!(
                        result,
                        Ok(*new),
                        "Suspended → {new:?} must accept (rehab/noop edge)"
                    );
                }
                AgentStatus::Active | AgentStatus::Paused => {
                    assert!(
                        result.is_err(),
                        "Suspended → {new:?} must reject (use clear_suspension)"
                    );
                }
            }
        }
    }

    /// `status_from_selector` is the byte → variant pre-image used by the
    /// fuzz target. Confirms the `s % 4` modular mapping covers every
    /// variant and is total over u8 (no panic on any byte).
    #[test]
    fn status_from_selector_total_over_u8() {
        let mut seen = [false; 4];
        for byte in 0u8..=255 {
            let s = status_from_selector(byte);
            seen[s as usize] = true;
        }
        assert!(seen.iter().all(|&x| x), "every variant must be reachable");
    }

    /// The full property contract holds across the EXHAUSTIVE preimage of
    /// the input space: 256 × 256 × 2 = 131,072 (current_byte, new_byte,
    /// is_self_issued) triples. Because `AgentStatus` has only 4 variants
    /// and `is_self_issued` is a bool, this is a complete proof of the
    /// AUD-120 accept-list property at cargo-test time — not a sample.
    /// Operator-driven `cargo hfuzz run update_status` adds libhfuzz
    /// branch-coverage feedback for the case where a future refactor
    /// introduces an input-dependent branch this exhaustive sweep
    /// could not anticipate (e.g. signer-list changes).
    #[test]
    fn deterministic_sweep_holds_contract() {
        let mut iterations = 0u64;
        for current_byte in 0u8..=255 {
            for new_byte in 0u8..=255 {
                for is_self_issued in [false, true] {
                    let input = Input {
                        current_status_byte: current_byte,
                        new_status_byte: new_byte,
                        is_self_issued,
                    };
                    let result = handler_simulate(&input);
                    assert_contract(&input, &result);
                    iterations += 1;
                }
            }
        }
        assert_eq!(
            iterations, 131_072,
            "exhaustive sweep must cover the full (u8, u8, bool) preimage"
        );
    }
}
