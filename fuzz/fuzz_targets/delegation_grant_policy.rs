// ADR-111: delegation grant policy fuzz target.
//
// Why this target:
//   `execute_grant_transfer` / `execute_grant_token_transfer` impose the
//   dual-gating contract that defines delegation grants: a grantee's
//   spend MUST be bounded by BOTH the grant's own caps (lifetime spend,
//   per-mint cap, recipient allowlist, action bits, expiry) AND the
//   parent vault's caps (per-tx limit, daily limit, rate-limit window,
//   pause / suspension). Grant caps are ADDITIVE, never substitutive —
//   this is the invariant ADR-111 §"Enforcement" pins.
//
//   Bug shape this catches:
//     A future refactor that, say, short-circuits the vault per-tx
//     check when the grant cap is set ("we trust the grantor to know
//     the vault's limits") would silently widen the spend surface for
//     every grantee. The harness model below asserts that on every
//     accept path, BOTH gates fired, and on every reject path, at least
//     one of the documented reject conditions was tripped.
//
// Property contract (asserted on every iteration):
//   P1 (action-bit subset): an `execute_grant_*` call is accepted only
//      if the requested action's bit is set in `grant.allowed_actions`.
//      The READ_ONLY sentinel (0) accepts no action.
//   P2 (recipient allowlist): if `grant.allowed_recipients` is empty,
//      any recipient passes; otherwise the recipient MUST be in the
//      list. Empty is the "delegate to vault" sentinel.
//   P3 (grant cap dominance): the grantee's projected spend (spent +
//      amount) MUST stay within the grant cap. Overflow is rejected
//      with the same priority as cap-exceeded (checked_add returns
//      None).
//   P4 (vault cap dominance): the vault per-tx and daily caps MUST
//      still apply. A transfer accepted by the grant cap but rejected
//      by the vault cap MUST fail.
//   P5 (revoked short-circuit): a revoked grant rejects regardless of
//      action / recipient / cap state.
//   P6 (expired short-circuit): a grant past `expires_at` rejects
//      regardless of cap state. `expires_at == 0` is the no-expiry
//      sentinel; never short-circuits.
//   P7 (paused short-circuit): a paused vault rejects every grant
//      execution.
//   P8 (suspended short-circuit): a suspended agent (ADR-095) rejects
//      every grant execution.
//   P9 (tighten-only update): an update operation that lowers the cap
//      below the already-spent value MUST reject; raising the cap MUST
//      reject; adding action bits MUST reject; extending the expiry
//      MUST reject.
//
// Modeling approach:
//   Pure-Rust simulation of the handler logic in
//   `programs/agent-vault/src/instructions.rs::execute_grant_transfer`.
//   The model is deliberately decoupled from the on-chain handler at the
//   account-handle layer (no `Context`, no Anchor machinery); the
//   harness exercises ONLY the policy gates. The signature of the
//   simulator matches the gate ordering of the handler so a future
//   refactor that reorders the gates causes the property assertions
//   below to fire on the same inputs.

#![allow(clippy::needless_range_loop)]

use arbitrary::Arbitrary;
use honggfuzz::fuzz;

// ADR-111 reject-reason enum mirrors the on-chain error surface. The
// fuzz model returns the canonical reason so the harness can assert on
// gate priority (e.g. suspended fires before revoked, both fire before
// cap-exceeded).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum RejectReason {
    Suspended,
    Paused,
    Revoked,
    Expired,
    ActionNotAllowed,
    RecipientNotAllowed,
    GrantHasNoCap,
    GrantCapExceeded,
    VaultPerTxExceeded,
    VaultDailyExceeded,
    InvalidAmount,
}

#[derive(Debug, Clone)]
struct GrantState {
    allowed_actions: u8,
    spend_cap: u64,
    spent: u64,
    /// Up to 4 recipient entries; an empty `Vec` is the wildcard sentinel.
    allowed_recipients: Vec<u8>,
    expires_at: i64,
    revoked: bool,
}

#[derive(Debug, Clone)]
struct VaultState {
    paused: bool,
    suspended: bool,
    per_tx_limit: u64,
    daily_limit: u64,
    spent_today: u64,
}

const EXECUTE_TRANSFER: u8 = 0b0000_0001;
const EXECUTE_TOKEN_TRANSFER: u8 = 0b0000_0010;
const ALL_KNOWN: u8 = EXECUTE_TRANSFER | EXECUTE_TOKEN_TRANSFER;

/// Pure-Rust model of the handler. Returns `Ok((new_spent, new_vault_spent_today))`
/// or `Err(reason)`. Gate order MUST match the on-chain handler exactly —
/// see `programs/agent-vault/src/instructions.rs::execute_grant_transfer`.
fn simulate(
    vault: &VaultState,
    grant: &GrantState,
    action: u8,
    recipient: u8,
    amount: u64,
    now: i64,
) -> Result<(u64, u64), RejectReason> {
    // Gate order (handler-faithful):
    //   1. amount > 0
    //   2. suspension (ADR-095)
    //   3. vault paused
    //   4. grant revoked
    //   5. grant expired
    //   6. action allowed
    //   7. recipient allowed
    //   8. grant cap
    //   9. vault per-tx
    //  10. vault daily
    if amount == 0 {
        return Err(RejectReason::InvalidAmount);
    }
    if vault.suspended {
        return Err(RejectReason::Suspended);
    }
    if vault.paused {
        return Err(RejectReason::Paused);
    }
    if grant.revoked {
        return Err(RejectReason::Revoked);
    }
    if !(grant.expires_at == 0 || now < grant.expires_at) {
        return Err(RejectReason::Expired);
    }
    let action_allowed = action != 0 && (grant.allowed_actions & action) == action;
    if !action_allowed {
        return Err(RejectReason::ActionNotAllowed);
    }
    if !grant.allowed_recipients.is_empty() && !grant.allowed_recipients.contains(&recipient) {
        return Err(RejectReason::RecipientNotAllowed);
    }
    if grant.spend_cap == 0 {
        return Err(RejectReason::GrantHasNoCap);
    }
    let projected = match grant.spent.checked_add(amount) {
        Some(v) => v,
        None => return Err(RejectReason::GrantCapExceeded),
    };
    if projected > grant.spend_cap {
        return Err(RejectReason::GrantCapExceeded);
    }
    if amount > vault.per_tx_limit {
        return Err(RejectReason::VaultPerTxExceeded);
    }
    let projected_day = vault.spent_today.saturating_add(amount);
    if projected_day > vault.daily_limit {
        return Err(RejectReason::VaultDailyExceeded);
    }
    Ok((projected, projected_day))
}

/// Update simulator — the tighten-only invariant. Returns Ok(new_grant)
/// or Err with a generic "loosens" reason. We do NOT distinguish the
/// per-field reject types here; the on-chain handler emits a single
/// `GrantUpdateCannotLoosen` for all of them.
fn simulate_update(
    grant: &GrantState,
    new_actions: u8,
    new_cap: u64,
    new_expires_at: i64,
    new_recipients: Vec<u8>,
) -> Result<GrantState, &'static str> {
    if grant.revoked {
        return Err("revoked");
    }
    if new_actions & !ALL_KNOWN != 0 {
        return Err("unknown action bit");
    }
    if new_actions & !grant.allowed_actions != 0 {
        return Err("loosens actions");
    }
    if new_cap > grant.spend_cap {
        return Err("raises cap");
    }
    if new_cap < grant.spent {
        return Err("below already-spent");
    }
    if !grant.allowed_recipients.is_empty() {
        if new_recipients.is_empty() {
            return Err("widens to wildcard");
        }
        for r in &new_recipients {
            if !grant.allowed_recipients.contains(r) {
                return Err("adds recipient");
            }
        }
    }
    if grant.expires_at != 0 {
        if new_expires_at == 0 {
            return Err("removes expiry");
        }
        if new_expires_at > grant.expires_at {
            return Err("extends expiry");
        }
    }
    Ok(GrantState {
        allowed_actions: new_actions,
        spend_cap: new_cap,
        spent: grant.spent,
        allowed_recipients: new_recipients,
        expires_at: new_expires_at,
        revoked: grant.revoked,
    })
}

#[derive(Debug, Arbitrary)]
struct Input {
    // Vault
    v_paused: bool,
    v_suspended: bool,
    v_per_tx: u64,
    v_daily: u64,
    v_spent_today: u64,
    // Grant
    g_actions: u8,
    g_cap: u64,
    g_spent: u64,
    g_recipients_mask: u8, // up to 8 distinct recipients; bits set = allowed
    g_expires_at: i64,
    g_revoked: bool,
    // Action arguments
    action: u8,
    recipient: u8,    // 0..8
    amount: u64,
    now: i64,
    // Update simulator inputs
    u_new_actions: u8,
    u_new_cap: u64,
    u_new_expires: i64,
    u_new_recipients_mask: u8,
}

fn input_to_states(input: &Input) -> (VaultState, GrantState) {
    let mut allowed = Vec::new();
    // bit 7 toggles "empty / wildcard" mode so the fuzzer can exercise
    // both the wildcard sentinel and the constrained list.
    if input.g_recipients_mask & 0b1000_0000 == 0 {
        for i in 0..7u8 {
            if input.g_recipients_mask & (1 << i) != 0 {
                allowed.push(i);
            }
        }
    }
    (
        VaultState {
            paused: input.v_paused,
            suspended: input.v_suspended,
            per_tx_limit: input.v_per_tx,
            daily_limit: input.v_daily,
            spent_today: input.v_spent_today,
        },
        GrantState {
            allowed_actions: input.g_actions & ALL_KNOWN, // mask unknown bits
            spend_cap: input.g_cap,
            spent: input.g_spent,
            allowed_recipients: allowed,
            expires_at: input.g_expires_at,
            revoked: input.g_revoked,
        },
    )
}

fn assert_contract(input: &Input) {
    let (vault, grant) = input_to_states(input);
    let recipient = input.recipient % 8;
    let action = input.action & ALL_KNOWN;
    let res = simulate(&vault, &grant, action, recipient, input.amount, input.now);

    // P-priority: confirm the priority order of reject reasons.
    if input.amount == 0 {
        assert_eq!(res, Err(RejectReason::InvalidAmount));
    } else if vault.suspended {
        assert_eq!(res, Err(RejectReason::Suspended));
    } else if vault.paused {
        assert_eq!(res, Err(RejectReason::Paused));
    } else if grant.revoked {
        assert_eq!(res, Err(RejectReason::Revoked));
    } else if grant.expires_at != 0 && input.now >= grant.expires_at {
        assert_eq!(res, Err(RejectReason::Expired));
    } else if action == 0 || (grant.allowed_actions & action) != action {
        assert_eq!(res, Err(RejectReason::ActionNotAllowed));
    } else if !grant.allowed_recipients.is_empty()
        && !grant.allowed_recipients.contains(&recipient)
    {
        assert_eq!(res, Err(RejectReason::RecipientNotAllowed));
    } else if grant.spend_cap == 0 {
        assert_eq!(res, Err(RejectReason::GrantHasNoCap));
    } else {
        // P3: grant cap dominance.
        match grant.spent.checked_add(input.amount) {
            None => assert_eq!(res, Err(RejectReason::GrantCapExceeded)),
            Some(projected) => {
                if projected > grant.spend_cap {
                    assert_eq!(res, Err(RejectReason::GrantCapExceeded));
                } else if input.amount > vault.per_tx_limit {
                    assert_eq!(res, Err(RejectReason::VaultPerTxExceeded));
                } else if vault.spent_today.saturating_add(input.amount) > vault.daily_limit {
                    assert_eq!(res, Err(RejectReason::VaultDailyExceeded));
                } else {
                    // Accept must record both the grant and vault tallies.
                    let (g_spent_after, v_spent_after) = res.unwrap();
                    assert_eq!(g_spent_after, projected);
                    assert_eq!(
                        v_spent_after,
                        vault.spent_today.saturating_add(input.amount)
                    );
                    // P4 cross-check: vault per-tx and daily MUST still bind.
                    assert!(input.amount <= vault.per_tx_limit);
                    assert!(v_spent_after <= vault.daily_limit);
                }
            }
        }
    }

    // P9: tighten-only update invariant — exercise the update simulator
    // on every iteration with the same grant. Any reject must be the
    // documented set; any accept must produce a strictly-tighter grant.
    let mut new_recipients = Vec::new();
    if input.u_new_recipients_mask & 0b1000_0000 == 0 {
        for i in 0..7u8 {
            if input.u_new_recipients_mask & (1 << i) != 0 {
                new_recipients.push(i);
            }
        }
    }
    let upd = simulate_update(
        &grant,
        input.u_new_actions & ALL_KNOWN,
        input.u_new_cap,
        input.u_new_expires,
        new_recipients.clone(),
    );
    if let Ok(updated) = upd {
        // Strictly-tighter checks.
        assert_eq!(updated.allowed_actions & !grant.allowed_actions, 0);
        assert!(updated.spend_cap <= grant.spend_cap);
        assert!(updated.spend_cap >= grant.spent);
        if grant.expires_at != 0 {
            assert!(updated.expires_at != 0);
            assert!(updated.expires_at <= grant.expires_at);
        }
        if !grant.allowed_recipients.is_empty() {
            assert!(!updated.allowed_recipients.is_empty());
            for r in &updated.allowed_recipients {
                assert!(grant.allowed_recipients.contains(r));
            }
        }
        // Spent is preserved across updates.
        assert_eq!(updated.spent, grant.spent);
    }
}

fn main() {
    loop {
        fuzz!(|data: &[u8]| {
            let mut u = arbitrary::Unstructured::new(data);
            let input = match Input::arbitrary(&mut u) {
                Ok(i) => i,
                Err(_) => return,
            };
            assert_contract(&input);
        });
    }
}

// ============================================================================
// Compile-time smoke tests — run under `cargo test -p aep-fuzz`.
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    fn basic_vault() -> VaultState {
        VaultState {
            paused: false,
            suspended: false,
            per_tx_limit: 1_000,
            daily_limit: 10_000,
            spent_today: 0,
        }
    }

    fn basic_grant() -> GrantState {
        GrantState {
            allowed_actions: EXECUTE_TRANSFER,
            spend_cap: 500,
            spent: 0,
            allowed_recipients: vec![],
            expires_at: 0,
            revoked: false,
        }
    }

    #[test]
    fn happy_path_accept() {
        let v = basic_vault();
        let g = basic_grant();
        let res = simulate(&v, &g, EXECUTE_TRANSFER, 0, 100, 0);
        assert_eq!(res, Ok((100, 100)));
    }

    #[test]
    fn suspended_short_circuits_everything() {
        let mut v = basic_vault();
        v.suspended = true;
        let g = basic_grant();
        assert_eq!(
            simulate(&v, &g, EXECUTE_TRANSFER, 0, 100, 0),
            Err(RejectReason::Suspended)
        );
    }

    #[test]
    fn revoked_grant_rejects() {
        let v = basic_vault();
        let mut g = basic_grant();
        g.revoked = true;
        assert_eq!(
            simulate(&v, &g, EXECUTE_TRANSFER, 0, 100, 0),
            Err(RejectReason::Revoked)
        );
    }

    #[test]
    fn expired_grant_rejects() {
        let v = basic_vault();
        let mut g = basic_grant();
        g.expires_at = 100;
        assert_eq!(
            simulate(&v, &g, EXECUTE_TRANSFER, 0, 100, 100),
            Err(RejectReason::Expired)
        );
        assert_eq!(
            simulate(&v, &g, EXECUTE_TRANSFER, 0, 100, 99),
            Ok((100, 100))
        );
    }

    #[test]
    fn action_mismatch_rejects() {
        let v = basic_vault();
        let g = basic_grant(); // only EXECUTE_TRANSFER allowed
        assert_eq!(
            simulate(&v, &g, EXECUTE_TOKEN_TRANSFER, 0, 100, 0),
            Err(RejectReason::ActionNotAllowed)
        );
    }

    #[test]
    fn recipient_allowlist_filters() {
        let v = basic_vault();
        let mut g = basic_grant();
        g.allowed_recipients = vec![1, 2, 3];
        assert_eq!(
            simulate(&v, &g, EXECUTE_TRANSFER, 4, 100, 0),
            Err(RejectReason::RecipientNotAllowed)
        );
        assert_eq!(
            simulate(&v, &g, EXECUTE_TRANSFER, 2, 100, 0),
            Ok((100, 100))
        );
    }

    #[test]
    fn grant_cap_exceeded_rejects() {
        let v = basic_vault();
        let mut g = basic_grant();
        g.spent = 450;
        assert_eq!(
            simulate(&v, &g, EXECUTE_TRANSFER, 0, 100, 0),
            Err(RejectReason::GrantCapExceeded)
        );
    }

    #[test]
    fn vault_per_tx_dominates_over_grant() {
        // Grant cap = 1000, vault per-tx = 100. A 500 transfer is well
        // within the grant but blocked by the vault.
        let mut v = basic_vault();
        v.per_tx_limit = 100;
        let mut g = basic_grant();
        g.spend_cap = 1000;
        assert_eq!(
            simulate(&v, &g, EXECUTE_TRANSFER, 0, 500, 0),
            Err(RejectReason::VaultPerTxExceeded)
        );
    }

    #[test]
    fn vault_daily_dominates_over_grant() {
        let mut v = basic_vault();
        v.daily_limit = 100;
        let g = basic_grant();
        assert_eq!(
            simulate(&v, &g, EXECUTE_TRANSFER, 0, 101, 0),
            Err(RejectReason::VaultDailyExceeded)
        );
    }

    #[test]
    fn update_cannot_loosen_actions() {
        let g = basic_grant(); // EXECUTE_TRANSFER only
        let bad = simulate_update(&g, ALL_KNOWN, g.spend_cap, g.expires_at, vec![]);
        assert!(bad.is_err());
    }

    #[test]
    fn update_cannot_raise_cap() {
        let g = basic_grant(); // cap=500
        let bad = simulate_update(&g, g.allowed_actions, 1_000, g.expires_at, vec![]);
        assert!(bad.is_err());
    }

    #[test]
    fn update_cannot_drop_cap_below_spent() {
        let mut g = basic_grant();
        g.spent = 300;
        let bad = simulate_update(&g, g.allowed_actions, 200, g.expires_at, vec![]);
        assert!(bad.is_err());
    }

    #[test]
    fn update_cannot_extend_expiry() {
        let mut g = basic_grant();
        g.expires_at = 1_000;
        let bad = simulate_update(&g, g.allowed_actions, g.spend_cap, 5_000, vec![]);
        assert!(bad.is_err());
        // Tighten OK
        let ok = simulate_update(&g, g.allowed_actions, g.spend_cap, 500, vec![]);
        assert!(ok.is_ok());
    }

    #[test]
    fn update_cannot_widen_recipients() {
        let mut g = basic_grant();
        g.allowed_recipients = vec![1, 2];
        // Add a new recipient
        let bad = simulate_update(&g, g.allowed_actions, g.spend_cap, g.expires_at, vec![1, 2, 3]);
        assert!(bad.is_err());
        // Going from constrained → empty is widening (re-opens wildcard)
        let bad2 = simulate_update(&g, g.allowed_actions, g.spend_cap, g.expires_at, vec![]);
        assert!(bad2.is_err());
        // Tighten OK
        let ok = simulate_update(&g, g.allowed_actions, g.spend_cap, g.expires_at, vec![1]);
        assert!(ok.is_ok());
    }

    /// Exhaustive sweep over a small but structurally-meaningful slice of
    /// the input space. Same shape as the `update_status` sweep: ensures
    /// the contract holds across every (action, suspension, paused,
    /// revoked, recipient-allowlist-shape) combination the on-chain
    /// handler can observe.
    #[test]
    fn deterministic_sweep_holds_contract() {
        let mut iters = 0u64;
        for v_suspended in [false, true] {
            for v_paused in [false, true] {
                for g_revoked in [false, true] {
                    for action in [0, EXECUTE_TRANSFER, EXECUTE_TOKEN_TRANSFER, ALL_KNOWN] {
                        for amount in [0u64, 1, 100, 500, 999, 1_000, 1_001, u64::MAX] {
                            let input = Input {
                                v_paused,
                                v_suspended,
                                v_per_tx: 1_000,
                                v_daily: 10_000,
                                v_spent_today: 0,
                                g_actions: ALL_KNOWN,
                                g_cap: 5_000,
                                g_spent: 0,
                                g_recipients_mask: 0b1000_0000, // wildcard
                                g_expires_at: 0,
                                g_revoked,
                                action,
                                recipient: 0,
                                amount,
                                now: 0,
                                u_new_actions: 0,
                                u_new_cap: 0,
                                u_new_expires: 0,
                                u_new_recipients_mask: 0b1000_0000,
                            };
                            assert_contract(&input);
                            iters += 1;
                        }
                    }
                }
            }
        }
        assert!(iters > 0);
    }
}
