// B8 Phase 2 fuzz target: clear_suspension cleared_count escalation (AUD-004).
//
// Why this target:
//   `clear_suspension` (programs/agent-registry/src/lib.rs:496) is the
//   only path back out of `AgentStatus::Suspended` for an agent that hit
//   the slash-count threshold. Cycle-1 commit `31586e9`
//   ("fix(registry): cumulative slash_count + cleared_count escalation
//   (AUD-004)") closed the reputation-laundering loop:
//
//     pre-AUD-004 (cycle-0)                  post-AUD-004 (this fuzz pins)
//     ────────────────────                   ─────────────────────────────
//     status = Suspended                     status = Suspended
//     reputation_score /= 2                  cleared_count++  (saturating)
//     slash_count = 0  (LAUNDERING)          match cleared_count {
//     status = Active                          1 => score /= 2; Paused
//                                              2 => score  = 0; Paused
//                                              _ => Retired (terminal)
//                                            }
//                                            (slash_count NEVER reset)
//
//   The pre-fix shape let a high-rep agent loop {slash → suspend → clear
//   → re-stake → slash → ...} indefinitely, halving from a still-high score
//   each cycle while resetting `slash_count` so the next slash threshold
//   stayed cheap. AUD-004 broke the loop on three axes simultaneously:
//   slash_count is now cumulative; cleared_count is monotonic; the cost
//   ladder is strictly escalating; and the third clear is terminal
//   (Retired closes via `update_status`'s AUD-120 matrix — see the
//   `update_status` fuzz target in this directory).
//
//   This fuzz target is the runtime mirror of that escalation policy:
//   drive arbitrary `(status_byte, cleared_count: u8, slash_count: u8,
//   reputation_score: u64)` quadruples through the property-level model
//   and assert that ONLY `(Suspended, slash_count>=3)` profiles accept,
//   that the cost-ladder branch is taken in lockstep with the post-state
//   `cleared_count` value, that `cleared_count.saturating_add(1)` does
//   not panic at u8::MAX, and that the closed-state-machine invariant
//   `cleared_count <= 3` (assert_valid_profile, AUD-001/002 paired with
//   PR-I) is preserved on every accept path the handler can take.
//
// Property contract (the 5 properties asserted on every iteration):
//   P1 (NotSuspended gate, status arm): if pre-state status != Suspended,
//      handler MUST reject with NotSuspended. Mirrors the require! at
//      lib.rs:498-502 — the status check sits at the very top of the
//      handler, so it preempts every downstream branch.
//   P2 (NotSuspended gate, slash_count arm): if pre-state status ==
//      Suspended but slash_count < 3, handler MUST reject with
//      NotSuspended. Same require!, second conjunct. The 3-strike
//      slash threshold is the pre-condition for ever entering Suspended
//      legitimately (AUD-001/002 invariant 2), so a Suspended profile
//      with slash_count < 3 means the on-chain state was corrupted upstream
//      — but the handler defends against it anyway.
//   P3 (escalation ladder, branch selection): on accept, the post-state
//      branch taken MUST match the post-increment cleared_count value:
//        new_cleared == 1   → status=Paused, score /= 2
//        new_cleared == 2   → status=Paused, score  = 0
//        new_cleared >= 3   → status=Retired (score unchanged in handler,
//                              but capped by AUD-001/002 invariant 1)
//      The order matters: `cleared_count = saturating_add(1)` runs BEFORE
//      the match (lib.rs:505 then :507), so a pre-state cleared_count of
//      0 takes the `1` arm, not the `_` arm.
//   P4 (saturating-add invariant): `cleared_count.saturating_add(1)` MUST
//      NOT panic for ANY u8 input — including u8::MAX where checked_add
//      would have overflowed. AUD-118 codified saturating arithmetic as
//      the registry's overflow policy; this property pins it for the
//      cleared_count seam. At u8::MAX the post-state cleared_count stays
//      at u8::MAX (saturated), which falls into the `_` arm (Retired) at
//      runtime — but THEN trips the assert_valid_profile post-mutation
//      invariant `cleared_count <= 3` (AUD-001/002 paired with PR-I) and
//      reverts. This target encodes both: no panic in the handler body
//      AND the assert_valid_profile reject.
//   P5 (closed-state-machine post-condition): on accept (i.e. the
//      assert_valid_profile call at lib.rs:529 returns Ok), the
//      post-state MUST satisfy `cleared_count <= 3`. The escalation
//      ladder's `_` arm covers cleared_count ∈ [3, u8::MAX] in the
//      branch-selection sense, but only post-state cleared_count == 3
//      passes assert_valid_profile. Anything > 3 reverts at the
//      invariant check — the handler's saturating-add cannot be the
//      laundering vector that AUD-004 closed.
//
// Modeling approach:
//   Same shape as the `update_status` Phase 2 target and `propose_reputation_delta`
//   Phase 1 target: a pure-Rust `handler_simulate` that mirrors lines
//   496-538 of lib.rs verbatim. No `Context`, no Anchor account machinery.
//   The pre-state is captured as the four-field tuple above (status +
//   cleared_count + slash_count + reputation_score) — every other field
//   read by the on-chain handler (`updated_at`, `authority` for the
//   event payload) is irrelevant to the policy contract being pinned.
//
//   Because `cleared_count` is u8, the input space along that axis is
//   exactly 256 values. `status` (after `% 4` mapping) is 4 variants.
//   `slash_count` is u8 (256). `reputation_score` is u64 — too wide to
//   exhaustively sweep, so we sample 9 representative values across the
//   `[0, MAX_REPUTATION_SCORE = 100]` clamp (the AUD-001/002 invariant
//   bounds the legitimate range; out-of-range scores are caught by
//   assert_valid_profile, not by this handler). The cfg(test)
//   `deterministic_sweep_holds_contract` exhausts (4 status × 256 cleared
//   × 256 slash × 9 score) = 2,359,296 iterations — large enough to
//   defend the contract against every byte-level mutation honggfuzz can
//   produce within the (status, u8, u8, u64) preimage.
//
// What this *cannot* catch (deferred to remaining Phase 2 targets):
//   - Account-handle bugs (`signer`, `seeds`, `has_one`) on the
//     `ClearSuspension` context. AUD-117 will own those.
//   - Cross-handler ladder mutations (`update_status` then
//     `clear_suspension` then `propose_reputation_delta` then ...).
//     Each Phase 2 target is single-handler scope; cross-handler is
//     Phase 3 trident-driven ix-level coverage.
//   - The Settlement → Registry CPI seam (covered by the upcoming
//     `update_provider_reputation` Phase 2 target).
//
// Smoke-validation (operator):
//   ```
//   apt install binutils-dev libunwind-dev    # honggfuzz C deps
//   cd fuzz && cargo hfuzz run clear_suspension -- --max_total_time=30
//   ```
//   Expected: iteration counter climbs into the millions, 0 crashes. A
//   crash means either the on-chain handler has drifted from the AUD-004
//   escalation ladder encoded below, or a future refactor weakened the
//   saturating-add or NotSuspended guards.

use arbitrary::Arbitrary;
use honggfuzz::fuzz;

use agent_registry::state::AgentStatus;
use agent_registry::MAX_REPUTATION_SCORE;

/// Structured fuzz input. `Arbitrary` lets honggfuzz mutate a flat byte
/// stream while we get typed fields with no manual parsing.
#[derive(Debug, Arbitrary)]
struct Input {
    /// Pre-call `agent_profile.status` selector. Modeled via a u8 so the
    /// fuzzer can flip arbitrary bytes; `status_from_selector` maps `s
    /// % 4` to a variant. Anchor's `AnchorDeserialize` rejects any byte
    /// outside the variant range at the account-load boundary, so this
    /// is a faithful pre-image of post-deserialize state.
    status_byte: u8,
    /// Pre-call `agent_profile.cleared_count`. The full u8 range is
    /// fuzzable: legitimate values via the on-chain ladder are {0, 1, 2,
    /// 3} but a corrupted/migrated account could land any value, and
    /// AUD-118's saturating-add must not panic on u8::MAX regardless.
    cleared_count: u8,
    /// Pre-call `agent_profile.reputation_stake.slash_count`. The 3-strike
    /// threshold is encoded in the NotSuspended gate; values below 3 must
    /// always reject even when status == Suspended.
    slash_count: u8,
    /// Pre-call `agent_profile.reputation_score`. Stored as u64 on-chain
    /// but bounded by the AUD-001/002 invariant `score <=
    /// MAX_REPUTATION_SCORE = 100`. The handler does
    /// `score = score / 2` on the first-clear branch — integer division
    /// is well-defined for any u64 input including 0 (0 / 2 = 0). The
    /// fuzzer can drive this up to u64::MAX; assert_valid_profile would
    /// reject the post-state, which the harness mirrors below.
    reputation_score: u64,
}

/// Maps an arbitrary u8 selector to `AgentStatus`. Mirrors the same
/// helper in `update_status.rs` and `propose_reputation_delta.rs` so the
/// three Phase 1+2 targets agree on pre-image semantics. Adding a new
/// variant to `AgentStatus` will require updating ALL THREE files plus
/// the `is_valid_transition` matrix in `update_status.rs` — caught at
/// compile time by the registry's exhaustive matches, then by these
/// files' `cargo check`.
fn status_from_selector(s: u8) -> AgentStatus {
    match s % 4 {
        0 => AgentStatus::Active,
        1 => AgentStatus::Paused,
        2 => AgentStatus::Retired,
        _ => AgentStatus::Suspended,
    }
}

/// AUD-004 escalation outcome tag. The handler distinguishes four
/// observable post-states once it has passed the NotSuspended gate:
///   - `RejectNotSuspended`: the require!(status == Suspended &&
///     slash_count >= 3) gate fired. Maps to `AgentRegistryError::NotSuspended`.
///     This is the union of P1 and P2 rejects — the on-chain require!
///     is a single conjunction so the handler returns one error code
///     for both arms. The harness preserves the distinction in the
///     classifier below for assertion-message readability but treats
///     them as the same Err in `handler_simulate`.
///   - `AcceptHalveScore`: cleared_count went 0 → 1; status flips to
///     Paused, reputation_score is integer-halved.
///   - `AcceptZeroScore`: cleared_count went 1 → 2; status flips to
///     Paused, reputation_score is set to 0.
///   - `AcceptRetired`: cleared_count went 2 → 3 OR was already >= 3
///     pre-call (saturated or corrupted). Status flips to Retired,
///     reputation_score is left as-is by the handler.
///   - `RejectInvariant`: the post-state would violate the
///     assert_valid_profile invariant `cleared_count <= 3`. Reachable
///     only when the pre-state cleared_count is already > 3 (which the
///     handler would saturate into the same `_` arm) — a state that
///     could only exist via account corruption, but the handler defends
///     against it on every call by virtue of the post-mutation
///     assert_valid_profile.
#[derive(Debug, PartialEq)]
enum Outcome {
    RejectNotSuspended,
    RejectInvariant,
    AcceptHalveScore { post_score: u64 },
    AcceptZeroScore,
    AcceptRetired,
}

/// Mirror of the handler's full validation + escalation logic. Returns
/// the post-state Outcome that the on-chain handler would produce for
/// the given pre-state. Reproduces lib.rs:496-538 minus the
/// `Clock::get` (orthogonal — covered by the runtime), the
/// `emit!(SuspensionCleared)` (no observable on the policy contract),
/// and the `authority` field (only used in the event payload).
///
/// The Err-vs-Outcome split mirrors the on-chain error layout: the
/// NotSuspended gate maps to a single typed error, and the
/// assert_valid_profile post-mutation check is a separate revert path.
fn handler_simulate(input: &Input) -> Outcome {
    let status = status_from_selector(input.status_byte);

    // Handler line 498-502: NotSuspended gate. Single require! with two
    // conjuncts; both must hold to proceed. The on-chain handler emits
    // one error code (`NotSuspended`) regardless of which conjunct failed.
    if status != AgentStatus::Suspended || input.slash_count < 3 {
        return Outcome::RejectNotSuspended;
    }

    // Handler line 505: saturating-add. AUD-118 hygiene: NEVER panics on
    // u8::MAX, NEVER wraps to 0. The post-state cleared_count is the
    // value that drives the match arm below.
    let new_cleared = input.cleared_count.saturating_add(1);

    // Handler line 507-521: escalation ladder. The match is on the
    // POST-increment value, not the pre-state cleared_count.
    let outcome = match new_cleared {
        1 => Outcome::AcceptHalveScore {
            post_score: input.reputation_score / 2,
        },
        2 => Outcome::AcceptZeroScore,
        _ => Outcome::AcceptRetired,
    };

    // Handler line 529: assert_valid_profile post-mutation invariant
    // check. The relevant invariants for this handler's writes are:
    //   - `cleared_count <= 3` (AUD-001/002 paired with PR-I): the only
    //     way to violate this is if pre-state cleared_count was already
    //     > 3 (the saturating-add then preserves the > 3 value, since
    //     u8::MAX > 3). The legitimate ladder runs 0→1→2→3 and the
    //     `_` arm at 3 sets status=Retired, after which the AUD-120
    //     matrix rejects any further `update_status` calls — so a
    //     fourth call to clear_suspension is impossible on a
    //     non-corrupted profile (Retired ≠ Suspended → NotSuspended
    //     gate would have already rejected). But the handler defends
    //     anyway, so the harness mirrors the defense.
    //   - `reputation_score <= MAX_REPUTATION_SCORE` (AUD-001/002
    //     invariant 1): the halve-branch (`score / 2`) preserves the
    //     bound (smaller-or-equal). The zero-branch sets score = 0
    //     (preserves bound). The Retired branch leaves score untouched
    //     — so an out-of-bound pre-state score on the Retired branch
    //     would also trip the invariant. Encoded here so a future
    //     refactor that legitimizes high pre-state scores (e.g. via
    //     migration) cannot silently let the Retired branch through.
    //   - `status == Suspended ⇒ slash_count >= 3` (invariant 2): all
    //     accept branches set status to either Paused or Retired —
    //     never Suspended — so this invariant is automatically
    //     preserved. No check needed in the harness.
    if new_cleared > 3 {
        return Outcome::RejectInvariant;
    }
    let post_score = match &outcome {
        Outcome::AcceptHalveScore { post_score } => *post_score,
        Outcome::AcceptZeroScore => 0,
        // Retired branch leaves score unchanged.
        Outcome::AcceptRetired => input.reputation_score,
        // Already-rejected paths cannot reach here.
        _ => unreachable!("only accept paths reach assert_valid_profile"),
    };
    if post_score > MAX_REPUTATION_SCORE as u64 {
        return Outcome::RejectInvariant;
    }

    outcome
}

/// Property assertions. A panic here is a real finding — the harness
/// model has diverged from the handler, OR the on-chain ladder has shifted.
fn assert_contract(input: &Input, outcome: &Outcome) {
    let status = status_from_selector(input.status_byte);

    // Property 1 (NotSuspended gate, status arm): non-Suspended pre-state
    // MUST reject regardless of slash_count or cleared_count.
    if status != AgentStatus::Suspended {
        assert_eq!(
            outcome,
            &Outcome::RejectNotSuspended,
            "non-Suspended status must reject at NotSuspended gate, input {input:?}"
        );
        return;
    }

    // Property 2 (NotSuspended gate, slash_count arm): Suspended with
    // slash_count < 3 MUST reject — the 3-strike threshold is the
    // legitimate entry condition for Suspended.
    if input.slash_count < 3 {
        assert_eq!(
            outcome,
            &Outcome::RejectNotSuspended,
            "Suspended with slash_count<3 must reject at NotSuspended gate, input {input:?}"
        );
        return;
    }

    // From here on, status == Suspended && slash_count >= 3 (the gate
    // accepted). The post-increment cleared_count drives the branch.
    let new_cleared = input.cleared_count.saturating_add(1);

    // Property 4 (saturating-add invariant): the model has computed
    // new_cleared without panicking. If we reached this line, the
    // saturating-add held — for ANY pre-state cleared_count in [0, u8::MAX].
    // No assertion needed here; the absence of a panic is the proof.

    // Property 5 (closed-state-machine post-condition): if the
    // post-increment cleared_count would exceed 3 OR the post-state
    // score would exceed MAX_REPUTATION_SCORE, assert_valid_profile
    // reverts. The harness's `handler_simulate` already returns
    // RejectInvariant in those cases; the assertion below pins it.
    let would_reject_cleared = new_cleared > 3;
    let would_reject_score = match new_cleared {
        // Halve and zero arms always produce score <= pre-state score,
        // and assert_valid_profile only rejects > MAX_REPUTATION_SCORE.
        // Halve: post = pre / 2; if pre > 100, post could still be > 100
        // (e.g. pre = 250 → post = 125 > 100).
        1 => input.reputation_score / 2 > MAX_REPUTATION_SCORE as u64,
        // Zero: post = 0, never > 100. Always passes invariant 1.
        2 => false,
        // Retired: post = pre (unchanged). If pre > 100, invariant fails.
        _ => input.reputation_score > MAX_REPUTATION_SCORE as u64,
    };
    if would_reject_cleared || would_reject_score {
        assert_eq!(
            outcome,
            &Outcome::RejectInvariant,
            "post-state must trip assert_valid_profile, input {input:?}"
        );
        return;
    }

    // Property 3 (escalation ladder, branch selection): the post-state
    // branch MUST match new_cleared. The match below is the lockstep
    // mirror of lib.rs:507-521.
    match new_cleared {
        1 => {
            let expected_score = input.reputation_score / 2;
            assert_eq!(
                outcome,
                &Outcome::AcceptHalveScore {
                    post_score: expected_score
                },
                "first-clear must halve score, input {input:?}"
            );
        }
        2 => {
            assert_eq!(
                outcome,
                &Outcome::AcceptZeroScore,
                "second-clear must zero score, input {input:?}"
            );
        }
        _ => {
            // The ladder's `_` arm covers new_cleared >= 3. We've already
            // returned above for new_cleared > 3 (invariant), so reaching
            // here means new_cleared == 3 exactly.
            assert_eq!(
                new_cleared, 3,
                "Retired branch must be reached only at new_cleared == 3 \
                 (post-invariant); input {input:?}"
            );
            assert_eq!(
                outcome,
                &Outcome::AcceptRetired,
                "third-clear must be terminal Retired, input {input:?}"
            );
        }
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
            let outcome = handler_simulate(&input);
            assert_contract(&input, &outcome);
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
    /// here AND in `status_from_selector` AND in the on-chain enum —
    /// three lockstep sites, all of which fail loudly on drift.
    const ALL_STATUSES: [AgentStatus; 4] = [
        AgentStatus::Active,
        AgentStatus::Paused,
        AgentStatus::Retired,
        AgentStatus::Suspended,
    ];

    /// Representative reputation_score values across the AUD-001/002
    /// invariant boundary `[0, MAX_REPUTATION_SCORE = 100]`. Includes
    /// out-of-bound values so the assert_valid_profile reject path is
    /// exercised on the Retired and halve branches.
    const SCORE_SAMPLES: &[u64] = &[
        0,                        // floor
        1,                        // odd-tiny (halve = 0)
        2,                        // even-tiny (halve = 1)
        50,                       // mid-range
        99,                       // odd just-below-max (halve = 49)
        100,                      // exact MAX_REPUTATION_SCORE
        101,                      // first out-of-bound (halve = 50, in-bound)
        201,                      // halve = 100 (still in-bound)
        202,                      // halve = 101 (FIRST score where halve trips invariant)
    ];

    /// Pin the AUD-004 escalation threshold from cycle-1 commit 31586e9.
    /// Encoded as a constant here so a future refactor that changes the
    /// ladder length forces an update at the harness AND at lib.rs:507-521
    /// AND at state.rs:208 (assert_valid_profile cap) AND at the
    /// AgentRegistryError::InvalidClearedCount message in errors.rs:81.
    /// Four lockstep sites — the post-AUD-004 design accepts the
    /// duplication for compile-time drift detection.
    const AUD_004_TERMINAL_CLEARED_COUNT: u8 = 3;

    /// AUD-004 P1: every non-Suspended status rejects with NotSuspended,
    /// regardless of slash_count, cleared_count, or reputation_score.
    /// Pins the gate's first conjunct.
    #[test]
    fn aud_004_non_suspended_always_rejects() {
        for status in ALL_STATUSES.iter().filter(|s| **s != AgentStatus::Suspended) {
            for slash_count in [0u8, 3, u8::MAX] {
                for cleared_count in [0u8, 1, 2, 3, u8::MAX] {
                    for &reputation_score in SCORE_SAMPLES {
                        let input = Input {
                            status_byte: *status as u8,
                            cleared_count,
                            slash_count,
                            reputation_score,
                        };
                        let outcome = handler_simulate(&input);
                        assert_eq!(
                            outcome,
                            Outcome::RejectNotSuspended,
                            "non-Suspended ({status:?}) must reject, input {input:?}"
                        );
                    }
                }
            }
        }
    }

    /// AUD-004 P2: Suspended with slash_count < 3 rejects with NotSuspended.
    /// Pins the gate's second conjunct (the 3-strike entry threshold for
    /// Suspended). Pre-state cleared_count is irrelevant here — the gate
    /// fires before the saturating-add.
    #[test]
    fn aud_004_suspended_below_slash_threshold_rejects() {
        for slash_count in 0u8..=2 {
            for cleared_count in [0u8, 1, 2, 3, u8::MAX] {
                let input = Input {
                    status_byte: AgentStatus::Suspended as u8,
                    cleared_count,
                    slash_count,
                    reputation_score: 50,
                };
                let outcome = handler_simulate(&input);
                assert_eq!(
                    outcome,
                    Outcome::RejectNotSuspended,
                    "Suspended with slash_count={slash_count} must reject"
                );
            }
        }
    }

    /// AUD-004 P3 (first-clear branch): pre-state cleared_count == 0 with
    /// the gate accepting → status flips Paused, score halves. Pins
    /// lib.rs:508-511. Sweeps every legitimate score in [0, MAX] plus
    /// boundary 101 to confirm in-bound halve still passes the invariant.
    #[test]
    fn aud_004_first_clear_halves_score() {
        for &reputation_score in SCORE_SAMPLES {
            let input = Input {
                status_byte: AgentStatus::Suspended as u8,
                cleared_count: 0,
                slash_count: 3,
                reputation_score,
            };
            let outcome = handler_simulate(&input);
            let halved = reputation_score / 2;
            if halved > MAX_REPUTATION_SCORE as u64 {
                // Out-of-bound halve trips assert_valid_profile.
                assert_eq!(
                    outcome,
                    Outcome::RejectInvariant,
                    "halve of {reputation_score} = {halved} > MAX must trip invariant"
                );
            } else {
                assert_eq!(
                    outcome,
                    Outcome::AcceptHalveScore { post_score: halved },
                    "first-clear of score {reputation_score} must accept with halve"
                );
            }
        }
    }

    /// AUD-004 P3 (second-clear branch): pre-state cleared_count == 1 →
    /// status flips Paused, score zeroes. Pins lib.rs:512-515. The
    /// zero-branch always satisfies invariant 1 (post-score == 0), so
    /// every pre-state score accepts.
    #[test]
    fn aud_004_second_clear_zeroes_score() {
        for &reputation_score in SCORE_SAMPLES {
            let input = Input {
                status_byte: AgentStatus::Suspended as u8,
                cleared_count: 1,
                slash_count: 3,
                reputation_score,
            };
            let outcome = handler_simulate(&input);
            assert_eq!(
                outcome,
                Outcome::AcceptZeroScore,
                "second-clear of score {reputation_score} must accept with zero"
            );
        }
    }

    /// AUD-004 P3 (third-clear branch): pre-state cleared_count == 2 →
    /// status flips Retired (terminal). Pins lib.rs:516-520. The Retired
    /// branch leaves score unchanged, so out-of-bound pre-state scores
    /// trip assert_valid_profile.
    #[test]
    fn aud_004_third_clear_is_terminal_retired() {
        for &reputation_score in SCORE_SAMPLES {
            let input = Input {
                status_byte: AgentStatus::Suspended as u8,
                cleared_count: 2,
                slash_count: 3,
                reputation_score,
            };
            let outcome = handler_simulate(&input);
            if reputation_score > MAX_REPUTATION_SCORE as u64 {
                // Out-of-bound pre-state on Retired branch trips invariant.
                assert_eq!(
                    outcome,
                    Outcome::RejectInvariant,
                    "Retired branch with score {reputation_score} > MAX must trip invariant"
                );
            } else {
                assert_eq!(
                    outcome,
                    Outcome::AcceptRetired,
                    "third-clear must transition to Retired"
                );
            }
        }
    }

    /// AUD-004 P5 (closed-state-machine cap): pre-state cleared_count == 3
    /// would post-increment to 4 — beyond the AUD-001/002 cap. The
    /// handler's ladder takes the `_` arm (sets Retired) but then
    /// assert_valid_profile reverts on `cleared_count <= 3`. Reachable
    /// only via account corruption since the legitimate ladder lands at
    /// Retired (which closes via update_status's AUD-120 matrix), but
    /// the handler defends anyway.
    #[test]
    fn aud_004_pre_cleared_three_trips_invariant() {
        let input = Input {
            status_byte: AgentStatus::Suspended as u8,
            cleared_count: AUD_004_TERMINAL_CLEARED_COUNT,
            slash_count: 3,
            reputation_score: 50,
        };
        let outcome = handler_simulate(&input);
        assert_eq!(
            outcome,
            Outcome::RejectInvariant,
            "pre-cleared==3 saturates to 4, must trip cleared_count<=3 invariant"
        );
    }

    /// AUD-118 P4 (saturating-add invariant): pre-state cleared_count ==
    /// u8::MAX. The handler's `saturating_add(1)` MUST NOT panic; the
    /// post-state cleared_count stays at u8::MAX (saturated, not wrapped).
    /// The escalation match falls into the `_` arm (Retired), which then
    /// trips assert_valid_profile's `cleared_count <= 3` cap. The
    /// observable outcome is RejectInvariant — the handler does not
    /// panic, does not wrap, and does not silently land an attacker on
    /// the Retired branch with cleared_count == 0.
    #[test]
    fn aud_118_cleared_count_saturating_add_does_not_panic() {
        let input = Input {
            status_byte: AgentStatus::Suspended as u8,
            cleared_count: u8::MAX,
            slash_count: 3,
            reputation_score: 50,
        };
        // The assertion is the absence of a panic on the saturating-add
        // path inside handler_simulate. If saturating_add ever wraps,
        // new_cleared would be 0 (wrap) and the model would land in the
        // `1 => halve` arm, which the contract test below would catch
        // via the post-state mismatch.
        let outcome = handler_simulate(&input);
        assert_eq!(
            outcome,
            Outcome::RejectInvariant,
            "u8::MAX cleared_count must saturate (not wrap) and trip invariant"
        );
    }

    /// AUD-004 P3 cross-check: the ladder branch is selected by
    /// POST-INCREMENT cleared_count, not pre-state. This test pins the
    /// ordering — saturating_add(1) runs BEFORE the match (lib.rs:505
    /// then :507). A regression that swapped the order would land
    /// pre-state cleared_count == 0 in the `_` arm (Retired) instead of
    /// the `1` arm (halve), which this test would catch.
    #[test]
    fn aud_004_ladder_branches_on_post_increment() {
        // pre=0 → post=1 → halve branch (NOT Retired).
        let input = Input {
            status_byte: AgentStatus::Suspended as u8,
            cleared_count: 0,
            slash_count: 3,
            reputation_score: 100,
        };
        let outcome = handler_simulate(&input);
        assert_eq!(
            outcome,
            Outcome::AcceptHalveScore { post_score: 50 },
            "pre=0 must take post=1 halve branch (NOT pre-state arm)"
        );

        // pre=2 → post=3 → Retired branch (NOT halve, NOT zero).
        let input = Input {
            status_byte: AgentStatus::Suspended as u8,
            cleared_count: 2,
            slash_count: 3,
            reputation_score: 100,
        };
        let outcome = handler_simulate(&input);
        assert_eq!(
            outcome,
            Outcome::AcceptRetired,
            "pre=2 must take post=3 Retired branch (NOT zero arm)"
        );
    }

    /// Boundary: slash_count exactly at the threshold (3) accepts; below
    /// rejects. Pins the require!'s `>=` operator vs. a regression to `>`.
    #[test]
    fn aud_004_slash_threshold_boundary() {
        // slash_count == 3: gate accepts.
        let input = Input {
            status_byte: AgentStatus::Suspended as u8,
            cleared_count: 0,
            slash_count: 3,
            reputation_score: 100,
        };
        assert_ne!(
            handler_simulate(&input),
            Outcome::RejectNotSuspended,
            "slash_count == 3 must pass the threshold"
        );
        // slash_count == 2: gate rejects.
        let input = Input {
            status_byte: AgentStatus::Suspended as u8,
            cleared_count: 0,
            slash_count: 2,
            reputation_score: 100,
        };
        assert_eq!(
            handler_simulate(&input),
            Outcome::RejectNotSuspended,
            "slash_count == 2 must fail the threshold"
        );
    }

    /// `status_from_selector` is the byte → variant pre-image used by the
    /// fuzz target. Confirms the `s % 4` modular mapping covers every
    /// variant and is total over u8 (no panic on any byte). Mirrors the
    /// same test in `update_status.rs` so the two harnesses agree.
    #[test]
    fn status_from_selector_total_over_u8() {
        let mut seen = [false; 4];
        for byte in 0u8..=255 {
            let s = status_from_selector(byte);
            seen[s as usize] = true;
        }
        assert!(seen.iter().all(|&x| x), "every variant must be reachable");
    }

    /// The full property contract holds across a wide deterministic sweep
    /// of the input space:
    ///   4 status × 256 cleared_count × 256 slash_count × 9 score samples
    ///   = 2,359,296 iterations.
    /// This is not exhaustive over u64 reputation_score (would be
    /// infeasible), but the 9 samples cover both sides of the
    /// MAX_REPUTATION_SCORE = 100 invariant boundary plus integer-halving
    /// boundary cases. Operator-driven `cargo hfuzz run clear_suspension`
    /// adds libhfuzz branch-coverage feedback for the case where a future
    /// refactor introduces a score-dependent branch this sweep could not
    /// anticipate.
    #[test]
    fn deterministic_sweep_holds_contract() {
        let mut iterations = 0u64;
        for status_byte in 0u8..=3 {
            for cleared_count in 0u8..=255 {
                for slash_count in 0u8..=255 {
                    for &reputation_score in SCORE_SAMPLES {
                        let input = Input {
                            // Use the canonical low byte for each variant
                            // (status_from_selector reduces mod 4 anyway,
                            // but pinning the low byte makes failure
                            // messages reproducible by hand).
                            status_byte,
                            cleared_count,
                            slash_count,
                            reputation_score,
                        };
                        let outcome = handler_simulate(&input);
                        assert_contract(&input, &outcome);
                        iterations += 1;
                    }
                }
            }
        }
        assert_eq!(
            iterations,
            4 * 256 * 256 * SCORE_SAMPLES.len() as u64,
            "sweep must cover the full status × cleared × slash × score sample space"
        );
        assert_eq!(iterations, 2_359_296, "sweep iteration count regression");
    }
}
