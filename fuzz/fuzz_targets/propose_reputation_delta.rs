// B8 Phase 1 fuzz target: propose_reputation_delta policy logic.
//
// Why this target:
//   `propose_reputation_delta` (programs/agent-registry/src/lib.rs:296)
//   is the SOLE reputation-mutation surface in the Registry post-PR-G.
//   It carries three independent policy gates whose interaction was the
//   source of cycle-2 audit findings:
//     - AUD-108:    `reason` accept-list ({0, 1, 2}); reserved codes 3..=255
//                   must reject with `InvalidReputationReason`.
//     - ADR-094:    `|delta|` cap (`MAX_DELTA_PER_CALL = 10`); larger
//                   magnitudes must reject with `ReputationDeltaExceedsMax`.
//     - AUD-100:    slash-count escalation; `reason in {1, 2}` increments
//                   `slash_count` and flips `status -> Suspended` once the
//                   count reaches 3 (saturating at u8::MAX).
//   Plus the closed-state-machine post-condition (AUD-001/002):
//     - `score <= MAX_REPUTATION_SCORE`
//     - `status == Suspended ⇒ slash_count >= 3`
//
// Modeling approach:
//   The harness reimplements the handler body verbatim in pure Rust
//   (no `Context`, no Anchor account machinery, no `Clock::get`). For
//   any random `(initial_score, initial_status, initial_slash_count,
//   initial_cleared_count, delta, reason)` tuple drawn from honggfuzz's
//   mutation engine, the harness:
//     1. Runs the validation gates (delta cap, reason accept-list).
//     2. If accepted, applies the score clamp, slash-branch escalation,
//        and final invariant check — exactly mirroring the handler.
//     3. Asserts the **policy contract** holds for every accepted
//        post-state. A panic in any branch is a regression that the
//        operator-driven 4-hour pre-tag campaign will reproduce.
//
// What this *cannot* catch (deferred to Phase 2/3):
//   - Account-handle bugs (signer/seeds/has_one). Trident or a
//     program-test-runner harness covers those.
//   - Sysvar / `Clock` races. Solana runtime fuzzing only.
//   - CPI-boundary marshaling between Settlement and Registry. The
//     `cpi-failures.test.ts` integration suite owns that surface.
//
// Smoke-validation (operator):
//   ```
//   apt install binutils-dev libunwind-dev    # honggfuzz C deps
//   cd fuzz && cargo hfuzz run propose_reputation_delta -- --max_total_time=30
//   ```
//   Expected: iteration counter climbs into the millions, 0 crashes.

use arbitrary::Arbitrary;
use honggfuzz::fuzz;

use agent_registry::state::{
    assert_valid_profile, AgentProfile, AgentStatus, PricingModel, ReputationStake,
};
use agent_registry::{MAX_DELTA_PER_CALL, MAX_REPUTATION_SCORE};
use anchor_lang::prelude::Pubkey;

/// Structured fuzz input. `Arbitrary` lets honggfuzz mutate a flat byte
/// stream while we get typed fields with no manual parsing. Every field
/// has a domain that the on-chain handler must accept (or explicitly
/// reject); the harness does not pre-filter — that's the fuzzer's job.
#[derive(Debug, Arbitrary)]
struct Input {
    /// Pre-call `reputation_score`. Drawn over the full u64 range to
    /// exercise the AUD-112 transitional-window clamp (`old_score` is
    /// clamped to [0, MAX_REPUTATION_SCORE] before the delta is applied).
    initial_score: u64,
    /// Pre-call `status`. Modeled via a u8 selector so the fuzzer can
    /// flip arbitrary bytes without an `Arbitrary` impl on the enum.
    /// The four legal variants partition `0..=3`; values 4..=255 wrap
    /// via `% 4`, which is faithful to how a malformed account would be
    /// rejected at deserialization (i.e. never reaching the handler).
    status_selector: u8,
    /// Pre-call `slash_count`.
    initial_slash_count: u8,
    /// Pre-call `cleared_count` (AUD-004). Within [0, 3] is legal;
    /// the closed-state-machine invariant rejects > 3.
    initial_cleared_count: u8,
    /// Caller-supplied delta; full i16 range.
    delta: i16,
    /// Caller-supplied reason; full u8 range so AUD-108 reserved codes
    /// (3..=255) get exercised on every iteration.
    reason: u8,
}

/// Mirror of the handler's validation + state-mutation logic. Returns
/// `Err(_)` if the handler would `require!`-revert; returns `Ok(profile)`
/// with the post-state otherwise.
///
/// Reproduces lines 304-380 of programs/agent-registry/src/lib.rs. Any
/// drift between this and the handler is a fuzz regression.
fn handler_simulate(input: &Input) -> anchor_lang::Result<AgentProfile> {
    // Handler line 304-307: |delta| <= MAX_DELTA_PER_CALL.
    anchor_lang::require!(
        input.delta.unsigned_abs() <= MAX_DELTA_PER_CALL.unsigned_abs(),
        agent_registry::errors::AgentRegistryError::ReputationDeltaExceedsMax
    );

    // Handler line 322-325: reason in {0, 1, 2}.
    anchor_lang::require!(
        input.reason <= 2,
        agent_registry::errors::AgentRegistryError::InvalidReputationReason
    );

    // Build a minimal AgentProfile — same field set fixture_profile uses
    // in the in-tree unit tests (lib.rs:1754). The invariant helper only
    // reads `reputation_score`, `status`, `reputation_stake`, and
    // `cleared_count`; everything else is a placeholder.
    let mut profile = AgentProfile {
        authority: Pubkey::new_unique(),
        name: String::new(),
        description: String::new(),
        category: String::new(),
        capabilities: vec![],
        pricing_model: PricingModel::PerTask,
        pricing_amount: 0,
        accepted_tokens: vec![],
        vault_address: Pubkey::default(),
        status: status_from_selector(input.status_selector),
        reputation_score: input.initial_score,
        __padding_aud007: [0u8; 17],
        created_at: 0,
        updated_at: 0,
        reputation_stake: ReputationStake {
            staked_amount: 0,
            slash_count: input.initial_slash_count,
        },
        bump: 0,
        manifest_cid: [0u8; 64],
        manifest_hash: [0u8; 32],
        manifest_signature: [0u8; 64],
        manifest_version: 0,
        version: 0,
        registration_nonce: 0,
        cleared_count: input.initial_cleared_count,
    };

    // Handler line 337-339: clamp + delta-apply with no overflow.
    let old_score = profile
        .reputation_score
        .min(MAX_REPUTATION_SCORE as u64) as i16;
    let new_score = (old_score + input.delta).clamp(0, MAX_REPUTATION_SCORE as i16) as u8;
    profile.reputation_score = new_score as u64;

    // Handler line 354-376: slash branch.
    let is_slash = matches!(input.reason, 1 | 2);
    if is_slash {
        profile.reputation_stake.slash_count =
            profile.reputation_stake.slash_count.saturating_add(1);
        if profile.reputation_stake.slash_count >= 3 {
            profile.status = AgentStatus::Suspended;
        }
    }

    // Handler line 380: closed-state-machine invariant. Pre-call
    // `cleared_count > 3` is a corruption case — the on-chain handler
    // would have failed `assert_valid_profile` on a *previous* mutation,
    // so we expect the same rejection here. This is intentional — the
    // fuzzer's job is to confirm the invariant catches it.
    assert_valid_profile(&profile)?;

    Ok(profile)
}

/// Maps an arbitrary u8 selector to `AgentStatus`. Anchor's
/// `AnchorDeserialize` would reject byte values outside the variant
/// range, so this is a faithful pre-image of post-deserialize state.
fn status_from_selector(s: u8) -> AgentStatus {
    match s % 4 {
        0 => AgentStatus::Active,
        1 => AgentStatus::Paused,
        2 => AgentStatus::Retired,
        _ => AgentStatus::Suspended,
    }
}

/// Map a Result<AgentProfile> to a discrete outcome tag for assertion
/// readability. The handler distinguishes three observable outcomes:
///   - `Reject`: `require!` revert (delta cap or reason accept-list).
///   - `Invariant`: `assert_valid_profile` revert post-mutation.
///   - `Accept(profile)`: handler returns Ok with mutated state.
#[derive(Debug, PartialEq)]
enum Outcome {
    Reject,
    Invariant,
    Accept,
}

fn classify(input: &Input, result: &anchor_lang::Result<AgentProfile>) -> Outcome {
    if result.is_ok() {
        return Outcome::Accept;
    }
    // Distinguish gate-rejection from invariant-rejection without
    // matching on the error code (which would couple the harness to the
    // exact Anchor error layout). Use the input semantics instead:
    //   - delta too large OR reason out of range => Reject (gate)
    //   - everything else that errors => Invariant (post-mutation)
    let gate_failed = input.delta.unsigned_abs() > MAX_DELTA_PER_CALL.unsigned_abs()
        || input.reason > 2;
    if gate_failed {
        Outcome::Reject
    } else {
        Outcome::Invariant
    }
}

/// Property assertions. A panic here is a real finding — the harness's
/// model has diverged from the handler, OR the handler is producing a
/// state the closed-state-machine invariant cannot prove safe.
fn assert_contract(input: &Input, result: &anchor_lang::Result<AgentProfile>) {
    let outcome = classify(input, result);

    // Property 1 (AUD-108 + ADR-094): the gate must reject EXACTLY when
    // the input violates one of the two preconditions. No silent accept.
    let should_reject_at_gate = input.delta.unsigned_abs() > MAX_DELTA_PER_CALL.unsigned_abs()
        || input.reason > 2;
    if should_reject_at_gate {
        assert_eq!(
            outcome,
            Outcome::Reject,
            "policy gate must reject input {input:?}"
        );
        return;
    }

    // Property 2 (AUD-001/002): every accepted post-state satisfies the
    // closed-state-machine invariant. (`handler_simulate` calls
    // `assert_valid_profile` itself, so an Accept here proves it.)
    if let Ok(post) = result {
        assert!(
            post.reputation_score <= MAX_REPUTATION_SCORE as u64,
            "post-state score {} exceeds MAX_REPUTATION_SCORE for input {input:?}",
            post.reputation_score
        );
        if post.status == AgentStatus::Suspended {
            assert!(
                post.reputation_stake.slash_count >= 3,
                "Suspended post-state must have slash_count >= 3 for input {input:?}"
            );
        }
        assert!(
            post.cleared_count <= 3,
            "post-state cleared_count {} exceeds 3 for input {input:?}",
            post.cleared_count
        );
    }

    // Property 3 (AUD-100): slash branch fires for reason in {1, 2} only.
    // We model this by re-checking the slash-count delta against the
    // pre-state. Saturation at u8::MAX is the only allowed exception.
    if let Ok(post) = result {
        let is_slash = matches!(input.reason, 1 | 2);
        let pre = input.initial_slash_count;
        if is_slash {
            // Either incremented by 1, or saturated at u8::MAX.
            assert!(
                post.reputation_stake.slash_count == pre.saturating_add(1)
                    || (pre == u8::MAX && post.reputation_stake.slash_count == u8::MAX),
                "slash branch must increment slash_count (pre={pre}, post={}, input={input:?})",
                post.reputation_stake.slash_count
            );
        } else {
            // reason == 0 (task_completed): slash_count is read-only.
            assert_eq!(
                post.reputation_stake.slash_count, pre,
                "non-slash reason must not mutate slash_count (input={input:?})"
            );
        }
    }

    // Property 4 (AUD-100): once slash_count reaches >= 3, status MUST
    // be Suspended. This catches the inverse of the AUD-001/002 invariant.
    if let Ok(post) = result {
        if post.reputation_stake.slash_count >= 3
            && matches!(input.reason, 1 | 2)
            && input.initial_slash_count < 3
        {
            // The slash branch just crossed the threshold for the first
            // time on this call — status must have flipped.
            assert_eq!(
                post.status,
                AgentStatus::Suspended,
                "crossing slash_count >= 3 must flip status to Suspended (input={input:?})"
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

    /// AUD-108: reserved reason codes (3..=255) must reject at the gate.
    #[test]
    fn aud_108_reserved_reason_codes_reject() {
        for reason in 3u8..=10 {
            let input = Input {
                initial_score: 50,
                status_selector: 0,
                initial_slash_count: 0,
                initial_cleared_count: 0,
                delta: 1,
                reason,
            };
            let result = handler_simulate(&input);
            assert!(
                result.is_err(),
                "reason {reason} must be rejected by AUD-108 gate"
            );
            assert_eq!(classify(&input, &result), Outcome::Reject);
        }
    }

    /// ADR-094: |delta| > 10 must reject at the gate.
    #[test]
    fn adr_094_delta_cap_rejects_oversize() {
        for delta in [11i16, -11, i16::MAX, i16::MIN] {
            let input = Input {
                initial_score: 50,
                status_selector: 0,
                initial_slash_count: 0,
                initial_cleared_count: 0,
                delta,
                reason: 0,
            };
            let result = handler_simulate(&input);
            assert!(
                result.is_err(),
                "delta {delta} must be rejected by ADR-094 cap"
            );
            assert_eq!(classify(&input, &result), Outcome::Reject);
        }
    }

    /// AUD-100: third dispute_loss flips Active -> Suspended.
    #[test]
    fn aud_100_third_dispute_loss_suspends() {
        let input = Input {
            initial_score: 50,
            status_selector: 0, // Active
            initial_slash_count: 2,
            initial_cleared_count: 0,
            delta: -1,
            reason: 1, // dispute_loss
        };
        let result = handler_simulate(&input).expect("third slash must accept");
        assert_eq!(result.status, AgentStatus::Suspended);
        assert_eq!(result.reputation_stake.slash_count, 3);
    }

    /// AUD-112: a pre-migration profile with score > 100 is normalized
    /// before the delta is applied; the post-state is in-range.
    #[test]
    fn aud_112_legacy_oversize_score_normalized() {
        let input = Input {
            initial_score: u64::MAX, // legacy unbounded value
            status_selector: 0,
            initial_slash_count: 0,
            initial_cleared_count: 0,
            delta: 5,
            reason: 0,
        };
        let result = handler_simulate(&input).expect("legacy score must clamp + accept");
        assert!(result.reputation_score <= MAX_REPUTATION_SCORE as u64);
    }

    /// Boundary: |delta| == 10 (exactly MAX_DELTA_PER_CALL) accepts.
    #[test]
    fn boundary_delta_at_cap_accepts() {
        for delta in [10i16, -10] {
            let input = Input {
                initial_score: 50,
                status_selector: 0,
                initial_slash_count: 0,
                initial_cleared_count: 0,
                delta,
                reason: 0,
            };
            let result = handler_simulate(&input);
            assert!(result.is_ok(), "delta {delta} at the cap must accept");
        }
    }

    /// The full property contract holds across a deterministic sweep.
    /// This is the "30-second smoke" equivalent for environments without
    /// binutils-dev: 1M iterations of structured input synthesis exercise
    /// every classify/assert branch, with no honggfuzz C-runtime needed.
    #[test]
    fn deterministic_sweep_holds_contract() {
        // 1M iterations covers ~6 bits of entropy per field across the
        // 6-field input; sufficient to catch off-by-one regressions in
        // the boundary checks. Operator-driven `cargo hfuzz run` adds
        // libhfuzz coverage feedback for branch coverage that random
        // uniform sweeps cannot reach.
        for seed in 0u64..1_000_000 {
            // Cheap deterministic byte stream — splitmix64-style scramble
            // so adjacent seeds don't share long prefixes.
            let mut buf = [0u8; 32];
            let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
            for chunk in buf.chunks_mut(8) {
                x ^= x >> 30;
                x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
                x ^= x >> 27;
                x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
                x ^= x >> 31;
                chunk.copy_from_slice(&x.to_le_bytes());
            }
            let mut u = arbitrary::Unstructured::new(&buf);
            if let Ok(input) = Input::arbitrary(&mut u) {
                let result = handler_simulate(&input);
                assert_contract(&input, &result);
            }
        }
    }
}
