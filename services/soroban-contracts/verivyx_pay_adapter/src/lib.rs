//! # Verivyx Pay Adapter
//!
//! Destination-locked settlement entry for non-custodial MCP payments.
//!
//! The adapter atomically:
//!   1. Pulls `amount` (resource price) from the owner into `paywall_core` via SEP-41 `transfer_from`.
//!   2. Pulls `fee_atomic` (flat Verivyx service fee, read from storage) from the owner into the
//!      fee treasury via `transfer_from`.
//!   3. Calls `paywall_core::distribute` to split the resource funds to creator + platform.
//!
//! The fee is **never a caller argument** — it is fixed in adapter instance storage at `init` time
//! and cannot be spoofed or skipped.
//!
//! This crate also re-exports the OpenZeppelin stellar-accounts types used by the P1b spike tests
//! (those tests remain in `test.rs` and continue to pass).
#![no_std]

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype,
    token, vec, Address, Env, IntoVal, String, Symbol,
};

// ── Re-exports for the P1b OZ spike (test.rs uses them directly) ──────────────
pub use stellar_accounts::smart_account::{
    add_context_rule, add_policy, add_signer, do_check_auth, ContextRule, ContextRuleType,
    Signatures, Signer,
};
pub use stellar_accounts::policies::spending_limit::SpendingLimitAccountParams;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Usdc,        // Address — the one permitted USDC token
    Paywall,     // Address — the one permitted paywall_core contract
    FeeTreasury, // Address — Verivyx fee destination
    FeeAtomic,   // i128    — flat service fee in atomic USDC
}

// ── Event emitted by pay() ────────────────────────────────────────────────────

#[contractevent]
pub struct PayAdapterEvent {
    #[topic]
    pub domain: String,
    #[topic]
    pub slug: String,
    pub owner: Address,
    pub amount: i128,
    pub fee_atomic: i128,
}

// ── Production contract ───────────────────────────────────────────────────────

#[contract]
pub struct VerivyxPayAdapter;

#[contractimpl]
impl VerivyxPayAdapter {
    /// Initialize the adapter. Must be called once after deployment.
    ///
    /// - `usdc`: the one SEP-41 USDC token this adapter will use.
    /// - `paywall`: the one `paywall_core` contract this adapter routes resource
    ///   payments through.
    /// - `fee_treasury`: Verivyx treasury address that receives the flat service fee.
    /// - `fee_atomic`: flat Verivyx service fee in atomic USDC (≥ 0). Fixed in
    ///   storage — cannot be changed by callers.
    pub fn init(
        env: Env,
        usdc: Address,
        paywall: Address,
        fee_treasury: Address,
        fee_atomic: i128,
    ) {
        // Guard double-init
        if env.storage().instance().has(&DataKey::Usdc) {
            panic!("already initialized");
        }
        assert!(fee_atomic >= 0, "fee_atomic must be >= 0");
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.storage().instance().set(&DataKey::Paywall, &paywall);
        env.storage().instance().set(&DataKey::FeeTreasury, &fee_treasury);
        env.storage().instance().set(&DataKey::FeeAtomic, &fee_atomic);
    }

    /// Execute a destination-locked, fee-inclusive settlement.
    ///
    /// - `owner`:  the account whose SEP-41 allowance (approved to this adapter) is
    ///             drawn. The owner must have pre-approved this adapter contract as the
    ///             spender for at least `amount + fee_atomic`.
    /// - `domain`: domain registered in `paywall_core` (identifies the resource).
    /// - `slug`:   article / resource slug (recorded in the emitted event; not
    ///             forwarded to `distribute` which does not accept a slug arg).
    /// - `amount`: resource price in atomic USDC — must be > 0.
    ///
    /// Atomically:
    ///   1. `transfer_from(spender=adapter, from=owner, to=paywall, amount)` — resource funds land in paywall.
    ///   2. `transfer_from(spender=adapter, from=owner, to=fee_treasury, fee_atomic)` — Verivyx fee collected.
    ///   3. `paywall.distribute(domain, usdc, amount)` — paywall splits to creator + platform.
    ///   4. Emits `PayAdapterEvent`.
    pub fn pay(
        env: Env,
        owner: Address,
        domain: String,
        slug: String,
        amount: i128,
    ) {
        assert!(amount > 0, "amount must be > 0");

        let usdc: Address = env.storage().instance().get(&DataKey::Usdc)
            .expect("not initialized");
        let paywall: Address = env.storage().instance().get(&DataKey::Paywall)
            .expect("not initialized");
        let fee_treasury: Address = env.storage().instance().get(&DataKey::FeeTreasury)
            .expect("not initialized");
        let fee_atomic: i128 = env.storage().instance().get(&DataKey::FeeAtomic)
            .expect("not initialized");

        let adapter = env.current_contract_address();
        let t = token::Client::new(&env, &usdc);

        // Step 1: move resource price from owner into paywall_core.
        // spender = adapter (this contract), from = owner, to = paywall.
        // SEP-41 transfer_from arg order: (spender, from, to, amount)
        t.transfer_from(&adapter, &owner, &paywall, &amount);

        // Step 2: move flat Verivyx fee from owner into fee treasury.
        // Fee is read from storage — cannot be spoofed by the caller.
        if fee_atomic > 0 {
            t.transfer_from(&adapter, &owner, &fee_treasury, &fee_atomic);
        }

        // Step 3: trigger paywall_core distribute via cross-contract call.
        // distribute(domain, usdc_token, amount) — keeper.require_auth() fires inside;
        // in production the keeper/relayer signs the top-level tx; under mock_all_auths
        // in tests all require_auth() calls are satisfied automatically.
        let () = env.invoke_contract(
            &paywall,
            &Symbol::new(&env, "distribute"),
            vec![
                &env,
                domain.into_val(&env),
                usdc.into_val(&env),
                amount.into_val(&env),
            ],
        );

        // Step 4: emit event
        PayAdapterEvent {
            domain,
            slug,
            owner,
            amount,
            fee_atomic,
        }.publish(&env);
    }
}

#[cfg(test)]
mod test;
