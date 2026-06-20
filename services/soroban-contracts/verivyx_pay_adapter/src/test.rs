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

// ══════════════════════════════════════════════════════════════════════════════
// P1d LAYER 1 — Delegation gate, proven directly via do_check_auth.
//
// These model the OZ smart account's __check_auth path that adapter.pay() now
// triggers via owner.require_auth(). The rule is destination-locked to the
// adapter address, the only authorized signer is the delegated session key, and
// the rule carries a valid_until expiry. Each test exercises one guard.
// ══════════════════════════════════════════════════════════════════════════════

// TEST P1d-1 — session signer authorized for the adapter (happy path).
// Rule locked to adapter_addr, session signer present, ledger <= valid_until.
#[test]
fn session_signer_authorized_for_adapter() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let adapter_addr = e.register(MockTarget, ()); // stands in for the adapter
    let session_addr = Address::generate(&e);

    e.ledger().set_sequence_number(100);

    e.as_contract(&account_addr, || {
        let session_signer = Signer::Delegated(session_addr.clone());
        let mut signers = Vec::new(&e);
        signers.push_back(session_signer.clone());

        // Rule: destination-locked to the adapter, expires at ledger 200 (future).
        add_context_rule(
            &e,
            &ContextRuleType::CallContract(adapter_addr.clone()),
            &String::from_str(&e, "session-rule"),
            Some(200),
            &signers,
            &Map::new(&e),
        );

        // Auth context for a call to the adapter, while ledger (100) <= valid_until.
        let ctx = pay_context(&e, &adapter_addr);
        let auth_contexts = Vec::from_array(&e, [ctx]);
        let sigs = dummy_signatures(&e, &signers);
        let payload = e.crypto().sha256(&Bytes::from_array(&e, &[7u8; 32]));

        let result = do_check_auth(&e, &payload, &sigs, &auth_contexts);
        assert!(result.is_ok(), "Expected Ok for authorized session signer, got {:?}", result);
    });

    std::println!("[PASS] P1d: session signer authorized for adapter within validity window");
}

// TEST P1d-2 — wrong destination blocked.
// Rule locked to adapter_addr, but auth context targets a DIFFERENT contract.
// Must reject with UnvalidatedContext (#3002) — the destination lock.
#[test]
#[should_panic(expected = "Error(Contract, #3002)")]
fn wrong_destination_blocked() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let adapter_addr = e.register(MockTarget, ());
    let other_addr = Address::generate(&e); // NOT the adapter
    let session_addr = Address::generate(&e);

    e.as_contract(&account_addr, || {
        let session_signer = Signer::Delegated(session_addr.clone());
        let mut signers = Vec::new(&e);
        signers.push_back(session_signer.clone());

        add_context_rule(
            &e,
            &ContextRuleType::CallContract(adapter_addr.clone()),
            &String::from_str(&e, "session-rule"),
            None,
            &signers,
            &Map::new(&e),
        );

        // Context targets a contract the rule does NOT authorize → #3002.
        let ctx = pay_context(&e, &other_addr);
        let auth_contexts = Vec::from_array(&e, [ctx]);
        let sigs = dummy_signatures(&e, &signers);
        let payload = e.crypto().sha256(&Bytes::from_array(&e, &[7u8; 32]));

        let _ = do_check_auth(&e, &payload, &sigs, &auth_contexts);
    });
}

// TEST P1d-3 — expired delegation fails.
// Same rule, but ledger is advanced PAST valid_until → no valid rule → #3002.
#[test]
#[should_panic(expected = "Error(Contract, #3002)")]
fn expired_delegation_fails() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let adapter_addr = e.register(MockTarget, ());
    let session_addr = Address::generate(&e);

    e.ledger().set_sequence_number(100);

    e.as_contract(&account_addr, || {
        let session_signer = Signer::Delegated(session_addr.clone());
        let mut signers = Vec::new(&e);
        signers.push_back(session_signer.clone());

        // valid_until = 200 (future at creation).
        add_context_rule(
            &e,
            &ContextRuleType::CallContract(adapter_addr.clone()),
            &String::from_str(&e, "session-rule"),
            Some(200),
            &signers,
            &Map::new(&e),
        );

        // Advance ledger PAST valid_until — the rule is no longer valid.
        e.ledger().set_sequence_number(201);

        let ctx = pay_context(&e, &adapter_addr);
        let auth_contexts = Vec::from_array(&e, [ctx]);
        let sigs = dummy_signatures(&e, &signers);
        let payload = e.crypto().sha256(&Bytes::from_array(&e, &[7u8; 32]));

        let _ = do_check_auth(&e, &payload, &sigs, &auth_contexts);
    });
}

// TEST P1d-4 — non-session signer cannot pay.
// Signatures are provided for a signer that is NOT in the rule's signer set.
// The rule's authorized signer never signs → context cannot be validated → #3002.
#[test]
#[should_panic(expected = "Error(Contract, #3002)")]
fn non_session_signer_cannot_pay() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let adapter_addr = e.register(MockTarget, ());
    let session_addr = Address::generate(&e); // the authorized session key
    let intruder_addr = Address::generate(&e); // NOT in the rule

    e.as_contract(&account_addr, || {
        // Rule authorizes ONLY the session signer.
        let session_signer = Signer::Delegated(session_addr.clone());
        let mut signers = Vec::new(&e);
        signers.push_back(session_signer.clone());

        add_context_rule(
            &e,
            &ContextRuleType::CallContract(adapter_addr.clone()),
            &String::from_str(&e, "session-rule"),
            None,
            &signers,
            &Map::new(&e),
        );

        // Provide signatures ONLY for an intruder signer not present in the rule.
        let intruder_signer = Signer::Delegated(intruder_addr.clone());
        let mut intruder_set = Vec::new(&e);
        intruder_set.push_back(intruder_signer);

        let ctx = pay_context(&e, &adapter_addr);
        let auth_contexts = Vec::from_array(&e, [ctx]);
        let sigs = dummy_signatures(&e, &intruder_set);
        let payload = e.crypto().sha256(&Bytes::from_array(&e, &[7u8; 32]));

        let _ = do_check_auth(&e, &payload, &sigs, &auth_contexts);
    });
}

// Helper for IntoVal usage
use soroban_sdk::IntoVal;

// ══════════════════════════════════════════════════════════════════════════════
// P1e — REVOCATION TESTS
//
// Prove the owner can revoke a delegated session at will, via two complementary
// mechanisms:
//
//   A. Smart-account revocation: owner removes the session signer (or the whole
//      context rule) — the session key can no longer authorize, so do_check_auth
//      fails with UnvalidatedContext (#3002).
//
//   B. Funds-side revocation: owner sets adapter allowance to 0 via SEP-41
//      approve(..., 0) — even a call that reaches adapter.pay can move no funds.
//      The SAC transfer_from fails with exhausted-allowance (#9).
//
// API signatures used (stellar-accounts 0.5.0):
//   remove_signer(e: &Env, id: u32, signer: &Signer)
//     Removes one signer from the rule identified by `id`.
//     Panics with #3004 (NoSignersAndPolicies) if the signer being removed is
//     the last signer and the rule has no policies. Therefore test P1e-1 adds
//     a second dummy signer before removing the session signer — the rule still
//     has one signer so the removal succeeds.
//   remove_context_rule(e: &Env, id: u32)
//     Removes the entire rule (and all associated storage) identified by `id`.
//     Works regardless of how many signers or policies the rule has.
//   Both functions take the rule id (u32) returned by add_context_rule.
// ══════════════════════════════════════════════════════════════════════════════

use stellar_accounts::smart_account::{remove_context_rule, remove_signer};

// TEST P1e-1 — remove_signer disables the session.
//
// Setup: add a CallContract(adapter) rule with TWO signers (session + dummy).
// A second signer is necessary because remove_signer panics with #3004 when
// asked to remove the last signer and the rule has no policies.
// Step 1: do_check_auth with the session signer → Ok (baseline).
// Step 2: owner calls remove_signer(rule_id, session_signer).
// Step 3: do_check_auth with ONLY the session signer's signature → #3002
//   (UnvalidatedContext): the session signer is no longer in the rule's signer
//   set, so no rule can validate the presented context+signature pair.
//
// NOTE: calling do_check_auth twice in the same as_contract frame causes
// Error(Auth, ExistingValue) — "frame is already authorized". The same issue
// described in the Test 5 note applies here. We therefore split setup, baseline
// check, revoke, and guard check across four separate as_contract frames. State
// written by one frame (e.g. add_context_rule storage) persists in the shared Env.
#[test]
#[should_panic(expected = "Error(Contract, #3002)")]
fn revoke_remove_signer_disables_session() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let adapter_addr = e.register(MockTarget, ()); // stands in for the adapter
    let session_addr = Address::generate(&e);
    let dummy_addr   = Address::generate(&e); // second signer so remove_signer is valid

    // Share state across frames via outer-scope variables.
    let session_signer = Signer::Delegated(session_addr.clone());
    let dummy_signer   = Signer::Delegated(dummy_addr.clone());
    let mut signers = Vec::new(&e);
    signers.push_back(session_signer.clone());
    signers.push_back(dummy_signer.clone());
    let ctx = pay_context(&e, &adapter_addr);
    let auth_contexts = Vec::from_array(&e, [ctx.clone()]);
    let payload = e.crypto().sha256(&Bytes::from_array(&e, &[9u8; 32]));

    // Frame 1: add the context rule; capture the rule id.
    let rule_id = e.as_contract(&account_addr, || {
        let rule = add_context_rule(
            &e,
            &ContextRuleType::CallContract(adapter_addr.clone()),
            &String::from_str(&e, "session-rule"),
            None,
            &signers,
            &Map::new(&e),
        );
        rule.id
    });

    // Frame 2: baseline — session signer can authorize before revoke.
    let sigs_before = dummy_signatures(&e, &signers);
    let ok = e.as_contract(&account_addr, || {
        do_check_auth(&e, &payload, &sigs_before, &auth_contexts)
    });
    assert!(ok.is_ok(), "Baseline: session should be authorized before revoke, got {:?}", ok);

    // Frame 3: owner revokes the session signer.
    // Dummy signer remains → rule stays valid (remove_signer does not error).
    // After this call the rule's signer set is {dummy_signer} only.
    e.as_contract(&account_addr, || {
        remove_signer(&e, rule_id, &session_signer);
    });

    // Frame 4: after revocation, do_check_auth presenting ONLY the session
    // signer's signature must fail with UnvalidatedContext (#3002).
    // The session signer is no longer in the rule, so no rule matches.
    let mut session_only = Vec::new(&e);
    session_only.push_back(session_signer.clone());
    let sigs_after = dummy_signatures(&e, &session_only);
    e.as_contract(&account_addr, || {
        let _ = do_check_auth(&e, &payload, &sigs_after, &auth_contexts);
        // must panic with Error(Contract, #3002)
    });
}

// TEST P1e-2 — remove_context_rule disables the session.
//
// Setup: add a CallContract(adapter) rule with ONE signer (the session key).
// remove_context_rule(rule_id) removes the entire rule (all storage cleared).
// do_check_auth then finds no matching rule → UnvalidatedContext (#3002).
// This is the simpler revocation path when the session is the only signer.
//
// NOTE: same multi-frame split as P1e-1 to avoid Error(Auth, ExistingValue).
#[test]
#[should_panic(expected = "Error(Contract, #3002)")]
fn revoke_remove_context_rule_disables_session() {
    let e = Env::default();
    e.mock_all_auths();

    let account_addr = e.register(MockAccount, ());
    let adapter_addr = e.register(MockTarget, ());
    let session_addr = Address::generate(&e);

    let session_signer = Signer::Delegated(session_addr.clone());
    let mut signers = Vec::new(&e);
    signers.push_back(session_signer.clone());
    let ctx = pay_context(&e, &adapter_addr);
    let auth_contexts = Vec::from_array(&e, [ctx.clone()]);
    let payload = e.crypto().sha256(&Bytes::from_array(&e, &[11u8; 32]));
    let sigs = dummy_signatures(&e, &signers);

    // Frame 1: add rule with a single signer; capture rule id.
    let rule_id = e.as_contract(&account_addr, || {
        let rule = add_context_rule(
            &e,
            &ContextRuleType::CallContract(adapter_addr.clone()),
            &String::from_str(&e, "session-rule"),
            None,
            &signers,
            &Map::new(&e),
        );
        rule.id
    });

    // Frame 2: baseline — session can authorize before rule removal.
    let ok = e.as_contract(&account_addr, || {
        do_check_auth(&e, &payload, &sigs, &auth_contexts)
    });
    assert!(ok.is_ok(), "Baseline: session authorized before rule removal, got {:?}", ok);

    // Frame 3: owner removes the entire context rule — all storage for this
    // rule is cleaned up. Any subsequent do_check_auth for this context has
    // no matching rule.
    e.as_contract(&account_addr, || {
        remove_context_rule(&e, rule_id);
    });

    // Frame 4: after rule removal — no rule covers the adapter context → #3002.
    e.as_contract(&account_addr, || {
        let _ = do_check_auth(&e, &payload, &sigs, &auth_contexts);
        // must panic with Error(Contract, #3002)
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCTION ADAPTER TESTS — DIRECT 3-WAY SPLIT
//
// Verifies the adapter reads the authoritative on-chain price from paywall_core
// (get_creator) and credits creator + platform + Verivyx fee_treasury directly
// from the owner's SEP-41 allowance, in one atomic invocation. There is no pooled
// deposit and no cross-call to distribute — so the over-distribution risk (I-1)
// cannot arise, and there is no keeper signature on the money path.
//
// Numbers (per the brief): price=10_000, platform_fee=1_000, fee_atomic=10_000
//   → creator 9_000, platform 1_000, fee_treasury 10_000, owner −20_000.
// ══════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod adapter_tests {
    extern crate std;

    use soroban_sdk::{
        testutils::Address as _,
        token, Address, Env, String,
    };
    use paywall_core::{PaywallContract, PaywallContractClient};
    use crate::{VerivyxPayAdapter, VerivyxPayAdapterClient};

    fn usdc_balance(env: &Env, usdc_id: &Address, addr: &Address) -> i128 {
        token::Client::new(env, usdc_id).balance(addr)
    }

    // Full fixture exposing every party we assert balances on. Registers token +
    // paywall + adapter + funded owner; the adapter's platform is the SAME address
    // as paywall_core's platform_address (init contract requires they match).
    struct Fixture {
        usdc_id: Address,
        adapter: VerivyxPayAdapterClient<'static>,
        adapter_id: Address,
        owner: Address,
        owner_start: i128,
        creator: Address,
        platform: Address,
        fee_treasury: Address,
        domain: String,
        price: i128,
        pfee: i128,
        fee_atomic: i128,
    }

    fn setup(env: &Env) -> Fixture {
        let usdc_admin = Address::generate(env);
        let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin).address();

        // paywall_core: keeper is irrelevant now (no distribute call), but init
        // still requires one. platform = the shared platform wallet.
        let paywall_admin = Address::generate(env);
        let platform      = Address::generate(env);
        let keeper        = Address::generate(env);
        let paywall_id = env.register(PaywallContract, ());
        let paywall_client = PaywallContractClient::new(env, &paywall_id);
        paywall_client.init(&paywall_admin, &platform, &keeper, &usdc_id);

        // Register domain: price=10_000, platform_fee=1_000 → creator_share 9_000.
        let creator     = Address::generate(env);
        let domain      = String::from_str(env, "example.com");
        let price: i128 = 10_000;
        let pfee: i128  = 1_000;
        paywall_client.register(&creator, &domain, &price, &pfee);

        // adapter: platform MUST equal paywall_core's platform_address.
        let fee_treasury     = Address::generate(env);
        let fee_atomic: i128 = 10_000; // 0.001 USDC
        let adapter_id = env.register(VerivyxPayAdapter, ());
        let adapter = VerivyxPayAdapterClient::new(env, &adapter_id);
        adapter.init(&usdc_id, &paywall_id, &fee_treasury, &fee_atomic, &platform);

        let owner             = Address::generate(env);
        let owner_start: i128 = 1_000_000;
        token::StellarAssetClient::new(env, &usdc_id).mint(&owner, &owner_start);

        Fixture {
            usdc_id, adapter, adapter_id, owner, owner_start,
            creator, platform, fee_treasury, domain, price, pfee, fee_atomic,
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TEST 1 — pay_splits_creator_platform_and_fee
    //
    // Proves the core split: with price=10_000, platform_fee=1_000, fee=10_000 the
    // adapter credits creator 9_000, platform 1_000, fee_treasury 10_000 and debits
    // owner 20_000 — all read from chain/storage, none from a caller amount. Also
    // asserts nothing is held in the adapter or paywall (no pooled balance).
    // ══════════════════════════════════════════════════════════════════════════
    #[test]
    fn pay_splits_creator_platform_and_fee() {
        let env = Env::default();
        // mock_all_auths_allowing_non_root_auth: owner.require_auth() and the
        // SAC transfer_from auth fire at non-root invocation depth.
        env.mock_all_auths_allowing_non_root_auth();

        let f = setup(&env);

        // Approve adapter (spender) for >= price + fee = 20_000.
        let allowance: i128 = f.price + f.fee_atomic; // 20_000
        token::Client::new(&env, &f.usdc_id)
            .approve(&f.owner, &f.adapter_id, &allowance, &(env.ledger().sequence() + 1000));

        let slug = String::from_str(&env, "article-1");
        f.adapter.pay(&f.owner, &f.domain, &slug);

        // creator credited price - platform_fee = 9_000
        assert_eq!(
            usdc_balance(&env, &f.usdc_id, &f.creator),
            f.price - f.pfee,
            "creator share mismatch (expected 9_000)"
        );
        // platform credited platform_fee = 1_000
        assert_eq!(
            usdc_balance(&env, &f.usdc_id, &f.platform),
            f.pfee,
            "platform fee mismatch (expected 1_000)"
        );
        // fee_treasury credited Verivyx fee = 10_000
        assert_eq!(
            usdc_balance(&env, &f.usdc_id, &f.fee_treasury),
            f.fee_atomic,
            "fee_treasury mismatch (expected 10_000)"
        );
        // owner debited price + fee = 20_000
        assert_eq!(
            usdc_balance(&env, &f.usdc_id, &f.owner),
            f.owner_start - f.price - f.fee_atomic,
            "owner debit mismatch (expected -20_000)"
        );
        // No pooled balance anywhere: adapter holds 0.
        assert_eq!(
            usdc_balance(&env, &f.usdc_id, &f.adapter_id),
            0,
            "adapter must hold no funds (direct split, no pool)"
        );

        std::println!("[PASS] pay_splits_creator_platform_and_fee: 9_000 / 1_000 / 10_000, owner -20_000");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TEST 2 — pays_within_budget
    //
    // Allowance is exactly price + fee = 20_000. One pay succeeds and leaves the
    // remaining owner→adapter allowance at exactly 0, proving the three legs
    // consume the whole budget (no leg skipped, no leg double-charged).
    // ══════════════════════════════════════════════════════════════════════════
    #[test]
    fn pays_within_budget() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let f = setup(&env);

        let allowance: i128 = f.price + f.fee_atomic; // 20_000
        token::Client::new(&env, &f.usdc_id)
            .approve(&f.owner, &f.adapter_id, &allowance, &(env.ledger().sequence() + 1000));

        let slug = String::from_str(&env, "article-1");
        f.adapter.pay(&f.owner, &f.domain, &slug);

        // Owner debited exactly price + fee.
        assert_eq!(
            usdc_balance(&env, &f.usdc_id, &f.owner),
            f.owner_start - f.price - f.fee_atomic,
            "owner debited price + fee"
        );
        // Budget fully consumed: remaining allowance is 0.
        let remaining = token::Client::new(&env, &f.usdc_id).allowance(&f.owner, &f.adapter_id);
        assert_eq!(remaining, 0, "allowance (budget) fully consumed to 0");

        std::println!("[PASS] pays_within_budget: allowance exhausted to 0");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TEST 3 — fee_cannot_be_skipped (over-budget on the fee leg)
    //
    // Allowance = 15_000 < price + fee (20_000). The first two legs consume
    // 9_000 (creator) + 1_000 (platform) = 10_000, leaving 5_000. The third leg —
    // the Verivyx fee of 10_000 — exceeds the remaining 5_000 and panics with the
    // SAC exhausted-allowance error (#9). This isolates the fee leg as what blows
    // the cap, proving the fee can never be skipped to fit a smaller budget.
    // ══════════════════════════════════════════════════════════════════════════
    #[test]
    // #9 = SAC/SEP-41 exhausted-allowance error, raised by the fee leg's
    // transfer_from — proving the fee line is what exceeds the budget.
    #[should_panic(expected = "Error(Contract, #9)")]
    fn fee_cannot_be_skipped() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let f = setup(&env);

        // Enough for creator+platform (10_000) but not the fee (needs +10_000).
        let allowance: i128 = 15_000; // < price + fee (20_000)
        token::Client::new(&env, &f.usdc_id)
            .approve(&f.owner, &f.adapter_id, &allowance, &(env.ledger().sequence() + 1000));

        let slug = String::from_str(&env, "article-1");
        // Legs 1+2 consume 10_000; leg 3 (fee 10_000) > remaining 5_000 → #9.
        f.adapter.pay(&f.owner, &f.domain, &slug);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TEST 4 — over_budget_fails (second pay past the cap)
    //
    // Allowance = exactly one price + fee. First pay succeeds and exhausts the
    // allowance to 0 (asserted). The second pay's first leg hits transfer_from
    // with a 0 allowance and panics with #9 — proving the budget cap holds across
    // calls and that funds-side revoke / exhaustion blocks settlement.
    // ══════════════════════════════════════════════════════════════════════════
    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn over_budget_fails() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let f = setup(&env);

        let allowance: i128 = f.price + f.fee_atomic; // 20_000
        token::Client::new(&env, &f.usdc_id)
            .approve(&f.owner, &f.adapter_id, &allowance, &(env.ledger().sequence() + 1000));

        let slug = String::from_str(&env, "article-1");

        // First pay consumes the entire budget — succeeds.
        f.adapter.pay(&f.owner, &f.domain, &slug);
        assert_eq!(
            token::Client::new(&env, &f.usdc_id).allowance(&f.owner, &f.adapter_id),
            0,
            "budget exhausted to 0 after first pay (cap reached)"
        );

        // Second pay: leg 1 transfer_from exceeds the (now 0) allowance → #9.
        f.adapter.pay(&f.owner, &f.domain, &slug);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TEST 5 — unregistered_domain_panics
    //
    // pay() on a domain that get_creator returns None for must panic with
    // "domain not registered" — the adapter refuses to move funds for a domain it
    // has no authoritative price for.
    // ══════════════════════════════════════════════════════════════════════════
    #[test]
    #[should_panic(expected = "domain not registered")]
    fn unregistered_domain_panics() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let f = setup(&env);

        // Generous allowance so the panic is NOT an allowance error.
        let allowance: i128 = f.price + f.fee_atomic;
        token::Client::new(&env, &f.usdc_id)
            .approve(&f.owner, &f.adapter_id, &allowance, &(env.ledger().sequence() + 1000));

        // A domain that was never registered → get_creator returns None.
        let unknown = String::from_str(&env, "not-registered.example");
        let slug = String::from_str(&env, "article-1");
        f.adapter.pay(&f.owner, &unknown, &slug);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // TEST 6 — disabled_domain_panics
    //
    // Register then disable the domain via paywall_core::set_enabled (public,
    // creator-auth — no modification to paywall_core needed). get_creator returns
    // a CreatorData with enabled=false, so the adapter's assert!(cd.enabled) fires
    // with "paywall disabled" and no funds move.
    // ══════════════════════════════════════════════════════════════════════════
    #[test]
    #[should_panic(expected = "paywall disabled")]
    fn disabled_domain_panics() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        // Build a paywall + adapter where we keep the paywall client + creator so
        // we can disable the domain (setup() drops them, so inline the wiring).
        let usdc_admin = Address::generate(&env);
        let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin).address();

        let paywall_admin = Address::generate(&env);
        let platform      = Address::generate(&env);
        let keeper        = Address::generate(&env);
        let paywall_id = env.register(PaywallContract, ());
        let paywall_client = PaywallContractClient::new(&env, &paywall_id);
        paywall_client.init(&paywall_admin, &platform, &keeper, &usdc_id);

        let creator     = Address::generate(&env);
        let domain      = String::from_str(&env, "example.com");
        let price: i128 = 10_000;
        let pfee: i128  = 1_000;
        paywall_client.register(&creator, &domain, &price, &pfee);

        // Disable the domain — creator authorizes (mock auth covers it).
        paywall_client.set_enabled(&creator, &domain, &false);

        let fee_treasury     = Address::generate(&env);
        let fee_atomic: i128 = 10_000;
        let adapter_id = env.register(VerivyxPayAdapter, ());
        let adapter = VerivyxPayAdapterClient::new(&env, &adapter_id);
        adapter.init(&usdc_id, &paywall_id, &fee_treasury, &fee_atomic, &platform);

        let owner = Address::generate(&env);
        token::StellarAssetClient::new(&env, &usdc_id).mint(&owner, &1_000_000);
        token::Client::new(&env, &usdc_id)
            .approve(&owner, &adapter_id, &(price + fee_atomic), &(env.ledger().sequence() + 1000));

        let slug = String::from_str(&env, "article-1");
        // get_creator returns enabled=false → assert!(cd.enabled) panics.
        adapter.pay(&owner, &domain, &slug);
    }
}
