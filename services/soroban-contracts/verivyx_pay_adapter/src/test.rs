/// # Spike Test: OZ Stellar smart-account delegation flow
///
/// Verifies:
/// 1. stellar-accounts 0.5.0 compiles against soroban-sdk 23.5.3
/// 2. ContextRuleType::CallContract(addr) restricts auth to ONLY that contract
///    (destination-lock confirmed)
/// 3. Signer::Delegated(session_addr) with valid_until expiry works
/// 4. spending_limit module interface: install / can_enforce / enforce
/// 5. spending_limit blocks calls that exceed budget
/// 6. Expired context rules are skipped (valid_until enforcement)
///
/// SPIKE ONLY — not production code.
#[cfg(test)]
extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger},
    Address, Bytes, Env, Map, String, Val, Vec,
};

use stellar_accounts::{
    policies::{
        spending_limit::{
            can_enforce as sl_can_enforce, enforce as sl_enforce, install as sl_install,
            SpendingLimitAccountParams,
        },
        Policy,
    },
    smart_account::{
        add_context_rule, do_check_auth, ContextRule, ContextRuleType, Signatures, Signer,
    },
};

// ── Minimal mock contracts needed to register addresses ──────────────────────

/// A plain mock contract so we can register it and get an address.
#[contract]
struct MockAccount;

#[contractimpl]
impl MockAccount {
    pub fn noop() {}
}

/// Target contract – represents the paywall contract in production.
#[contract]
struct MockTarget;

#[contractimpl]
impl MockTarget {
    pub fn pay() {}
}

/// A mock policy contract that always allows (used for destination-lock test).
#[contract]
struct AlwaysAllowPolicy;

#[contractimpl]
impl Policy for AlwaysAllowPolicy {
    type AccountParams = Val;
    fn can_enforce(
        _e: &Env,
        _ctx: Context,
        signers: Vec<Signer>,
        _rule: ContextRule,
        _sa: Address,
    ) -> bool {
        !signers.is_empty()
    }
    fn enforce(
        _e: &Env,
        _ctx: Context,
        _signers: Vec<Signer>,
        _rule: ContextRule,
        _sa: Address,
    ) {
    }
    fn install(_e: &Env, _p: Val, _rule: ContextRule, _sa: Address) {}
    fn uninstall(_e: &Env, _rule: ContextRule, _sa: Address) {}
}

/// A policy contract that wraps the OZ spending_limit free functions.
#[contract]
struct SpendingLimitPolicyContract;

#[contractimpl]
impl Policy for SpendingLimitPolicyContract {
    type AccountParams = SpendingLimitAccountParams;

    fn can_enforce(
        e: &Env,
        ctx: Context,
        signers: Vec<Signer>,
        rule: ContextRule,
        sa: Address,
    ) -> bool {
        sl_can_enforce(e, &ctx, &signers, &rule, &sa)
    }

    fn enforce(
        e: &Env,
        ctx: Context,
        signers: Vec<Signer>,
        rule: ContextRule,
        sa: Address,
    ) {
        sl_enforce(e, &ctx, &signers, &rule, &sa)
    }

    fn install(e: &Env, params: SpendingLimitAccountParams, rule: ContextRule, sa: Address) {
        sl_install(e, &params, &rule, &sa)
    }

    fn uninstall(_e: &Env, _rule: ContextRule, _sa: Address) {}
}

// ── Helper: build a fake transfer Context ────────────────────────────────────

fn transfer_context(e: &Env, token_addr: &Address, amount: i128) -> Context {
    let from = Address::generate(e);
    let to = Address::generate(e);
    let mut args = Vec::new(e);
    args.push_back(from.into_val(e));
    args.push_back(to.into_val(e));
    args.push_back(amount.into_val(e));
    Context::Contract(ContractContext {
        contract: token_addr.clone(),
        fn_name: symbol_short!("transfer"),
        args,
    })
}

fn pay_context(e: &Env, target_addr: &Address) -> Context {
    Context::Contract(ContractContext {
        contract: target_addr.clone(),
        fn_name: symbol_short!("pay"),
        args: Vec::new(e),
    })
}

fn dummy_signatures(e: &Env, signers: &Vec<Signer>) -> Signatures {
    let mut m = Map::new(e);
    for s in signers.iter() {
        m.set(s, Bytes::new(e));
    }
    Signatures(m)
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 1 — Destination-lock: CallContract(target) ACCEPTS call to target
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_destination_lock_correct_target_succeeds() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let target_addr = e.register(MockTarget, ());
    let session_addr = Address::generate(&e);

    e.as_contract(&account_addr, || {
        let session_signer = Signer::Delegated(session_addr.clone());
        let mut signers = Vec::new(&e);
        signers.push_back(session_signer.clone());

        // Add a context rule locked to target_addr
        add_context_rule(
            &e,
            &ContextRuleType::CallContract(target_addr.clone()),
            &String::from_str(&e, "pay-rule"),
            None, // no expiry
            &signers,
            &Map::new(&e),
        );

        // Build auth context for a call to target_addr
        let ctx = pay_context(&e, &target_addr);
        let auth_contexts = Vec::from_array(&e, [ctx]);
        let sigs = dummy_signatures(&e, &signers);
        let payload = e.crypto().sha256(&Bytes::from_array(&e, &[1u8; 32]));

        // MUST succeed: session signer is authorized for target_addr
        let result = do_check_auth(&e, &payload, &sigs, &auth_contexts);
        assert!(result.is_ok(), "Expected Ok, got {:?}", result);
    });

    std::println!("[PASS] destination-lock: correct target accepted");
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 2 — Destination-lock: CallContract(target) REJECTS call to OTHER addr
// ══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "Error(Contract, #3002)")]
fn test_destination_lock_wrong_target_rejected() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let target_addr = e.register(MockTarget, ());
    let other_addr = Address::generate(&e); // not the registered target
    let session_addr = Address::generate(&e);

    e.as_contract(&account_addr, || {
        let session_signer = Signer::Delegated(session_addr.clone());
        let mut signers = Vec::new(&e);
        signers.push_back(session_signer.clone());

        // Rule locked to target_addr
        add_context_rule(
            &e,
            &ContextRuleType::CallContract(target_addr.clone()),
            &String::from_str(&e, "pay-rule"),
            None,
            &signers,
            &Map::new(&e),
        );

        // Auth context for a call to OTHER addr — must fail (#3002 UnvalidatedContext)
        let ctx = pay_context(&e, &other_addr);
        let auth_contexts = Vec::from_array(&e, [ctx]);
        let sigs = dummy_signatures(&e, &signers);
        let payload = e.crypto().sha256(&Bytes::from_array(&e, &[1u8; 32]));

        let _ = do_check_auth(&e, &payload, &sigs, &auth_contexts);
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 3 — valid_until: expired rule is skipped → UnvalidatedContext
// ══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "Error(Contract, #3002)")]
fn test_expired_rule_rejected() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let target_addr = e.register(MockTarget, ());
    let session_addr = Address::generate(&e);

    // Set ledger to sequence 100 so we can set valid_until in the past later
    e.ledger().set_sequence_number(100);

    e.as_contract(&account_addr, || {
        let session_signer = Signer::Delegated(session_addr.clone());
        let mut signers = Vec::new(&e);
        signers.push_back(session_signer.clone());

        // valid_until = 200 (future at time of creation)
        add_context_rule(
            &e,
            &ContextRuleType::CallContract(target_addr.clone()),
            &String::from_str(&e, "time-limited-rule"),
            Some(200),
            &signers,
            &Map::new(&e),
        );

        // Advance ledger PAST valid_until
        e.ledger().set_sequence_number(201);

        // Now call should fail: rule expired → no valid rule → #3002
        let ctx = pay_context(&e, &target_addr);
        let auth_contexts = Vec::from_array(&e, [ctx]);
        let sigs = dummy_signatures(&e, &signers);
        let payload = e.crypto().sha256(&Bytes::from_array(&e, &[1u8; 32]));

        let _ = do_check_auth(&e, &payload, &sigs, &auth_contexts);
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 4 — spending_limit install / can_enforce within budget
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_spending_limit_within_budget() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let token_addr = Address::generate(&e); // simulated token contract
    let smart_account = Address::generate(&e);

    let signers = {
        let mut v = Vec::new(&e);
        v.push_back(Signer::Delegated(Address::generate(&e)));
        v
    };
    let rule = ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(token_addr.clone()),
        name: String::from_str(&e, "spend-rule"),
        signers: signers.clone(),
        policies: Vec::new(&e),
        valid_until: None,
    };

    // Budget: 1_000_000 stroops over 100 ledgers
    let params = SpendingLimitAccountParams { spending_limit: 1_000_000, period_ledgers: 100 };

    e.as_contract(&account_addr, || {
        sl_install(&e, &params, &rule, &smart_account);

        let ctx = transfer_context(&e, &token_addr, 500_000);
        let can = sl_can_enforce(&e, &ctx, &signers, &rule, &smart_account);
        assert!(can, "Expected spending within limit to be allowed");
    });

    std::println!("[PASS] spending_limit: within budget allowed");
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 5 — spending_limit: after enforce, can_enforce returns false on overspend
//
// NOTE on the test design: sl_enforce calls smart_account.require_auth() and
// sl_install also calls it. Calling require_auth on the same non-contract address
// twice in one contract frame causes Error(Auth, ExistingValue) in soroban test
// env. We separate install and enforce into distinct as_contract invocations so
// each require_auth is in its own frame. State persists across frames in Env.
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_spending_limit_enforce_then_can_enforce_blocked() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let token_addr = Address::generate(&e);
    let smart_account = Address::generate(&e);

    let signers = {
        let mut v = Vec::new(&e);
        v.push_back(Signer::Delegated(Address::generate(&e)));
        v
    };
    let rule = ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(token_addr.clone()),
        name: String::from_str(&e, "spend-rule"),
        signers: signers.clone(),
        policies: Vec::new(&e),
        valid_until: None,
    };
    let params = SpendingLimitAccountParams { spending_limit: 1_000_000, period_ledgers: 100 };

    // Frame 1: install (require_auth once)
    e.as_contract(&account_addr, || {
        sl_install(&e, &params, &rule, &smart_account);
    });

    // Frame 2: enforce 600_000 (require_auth once — separate frame)
    e.as_contract(&account_addr, || {
        let ctx1 = transfer_context(&e, &token_addr, 600_000);
        sl_enforce(&e, &ctx1, &signers, &rule, &smart_account);
    });

    // Frame 3: can_enforce for 500_000 (read-only, no auth) — 600_000+500_000>1_000_000 → false
    e.as_contract(&account_addr, || {
        let ctx2 = transfer_context(&e, &token_addr, 500_000);
        let can = sl_can_enforce(&e, &ctx2, &signers, &rule, &smart_account);
        assert!(!can, "Expected follow-up amount exceeding budget to be blocked");
    });

    std::println!("[PASS] spending_limit: enforce writes state; subsequent can_enforce correctly blocked");
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 6 — spending_limit: enforce panics when single call exceeds full budget
//
// Proves that enforce itself enforces the limit (not just can_enforce).
// ══════════════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "Error(Contract, #3221)")]
fn test_spending_limit_enforce_panics_single_overlimit() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let token_addr = Address::generate(&e);
    let smart_account = Address::generate(&e);

    let signers = {
        let mut v = Vec::new(&e);
        v.push_back(Signer::Delegated(Address::generate(&e)));
        v
    };
    let rule = ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(token_addr.clone()),
        name: String::from_str(&e, "spend-rule"),
        signers: signers.clone(),
        policies: Vec::new(&e),
        valid_until: None,
    };
    // Budget: 1_000_000; single call: 1_500_000 → must panic with #3221
    let params = SpendingLimitAccountParams { spending_limit: 1_000_000, period_ledgers: 100 };

    // Frame 1: install (require_auth once)
    e.as_contract(&account_addr, || {
        sl_install(&e, &params, &rule, &smart_account);
    });

    // Frame 2: enforce with amount > budget → must panic #3221
    e.as_contract(&account_addr, || {
        let ctx = transfer_context(&e, &token_addr, 1_500_000);
        sl_enforce(&e, &ctx, &signers, &rule, &smart_account); // must panic #3221
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST 7 — full do_check_auth flow with AlwaysAllow policy (no-signer rule)
//          confirms the policy hook path works end-to-end
// ══════════════════════════════════════════════════════════════════════════════

#[test]
fn test_do_check_auth_with_policy_succeeds() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let target_addr = e.register(MockTarget, ());
    let policy_addr = e.register(AlwaysAllowPolicy, ());
    let session_addr = Address::generate(&e);

    e.as_contract(&account_addr, || {
        let session_signer = Signer::Delegated(session_addr.clone());
        let mut signers = Vec::new(&e);
        signers.push_back(session_signer.clone());

        // Map policy address to void install_param
        let mut policies_map: Map<Address, Val> = Map::new(&e);
        policies_map.set(policy_addr.clone(), Val::from_void().into());

        add_context_rule(
            &e,
            &ContextRuleType::CallContract(target_addr.clone()),
            &String::from_str(&e, "policy-rule"),
            None,
            &signers,
            &policies_map,
        );

        let ctx = pay_context(&e, &target_addr);
        let auth_contexts = Vec::from_array(&e, [ctx]);
        let sigs = dummy_signatures(&e, &signers);
        let payload = e.crypto().sha256(&Bytes::from_array(&e, &[1u8; 32]));

        let result = do_check_auth(&e, &payload, &sigs, &auth_contexts);
        assert!(result.is_ok());
    });

    std::println!("[PASS] do_check_auth with policy: session signer + policy succeeds");
}

// Helper for IntoVal usage
use soroban_sdk::IntoVal;
