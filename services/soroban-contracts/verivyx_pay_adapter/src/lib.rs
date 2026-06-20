//! # Verivyx Pay Adapter
//!
//! Destination-locked settlement entry for non-custodial MCP payments.
//!
//! The adapter performs a **direct 3-way split** of a single resource payment,
//! reading the authoritative on-chain price from `paywall_core`:
//!   1. `creator_share = price − platform_fee` → creator (transfer_from owner).
//!   2. `platform_fee` → platform (transfer_from owner).
//!   3. `fee_atomic` (flat Verivyx service fee, read from storage) → fee treasury
//!      (transfer_from owner).
//!
//! There is NO pooled deposit and NO cross-call to `paywall_core::distribute`:
//! funds move straight from the owner's allowance to their three destinations in
//! one atomic invocation. This eliminates the over-distribution risk of the
//! pooled-balance settlement path (finding I-1) by construction and removes the
//! keeper signature from the money path entirely.
//!
//! The Verivyx fee is **never a caller argument** — it is fixed in adapter
//! instance storage at `init` time and cannot be spoofed or skipped. The resource
//! price + platform fee are read live from `paywall_core` (also not caller args),
//! so a caller cannot under- or over-pay the creator.
//!
//! This crate also re-exports the OpenZeppelin stellar-accounts types used by the
//! P1b spike tests (those tests remain in `test.rs` and continue to pass).
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

// ~120 days at 5s/ledger on Stellar Testnet — mirrors paywall_core's LEDGER_TTL.
// Extended at the start of every public method so the instance entry is never
// archived while the adapter is in active use.
const LEDGER_TTL: u32 = 2_073_600;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Usdc,        // Address — the one permitted USDC token
    Paywall,     // Address — the one permitted paywall_core contract
    FeeTreasury, // Address — Verivyx fee destination
    FeeAtomic,   // i128    — flat service fee in atomic USDC
    Platform,    // Address — platform fee destination (== paywall_core platform_address)
}

// ── Mirror of paywall_core::CreatorData ───────────────────────────────────────
//
// Field-identical (same names, order, and types) to paywall_core's `CreatorData`
// so the `Val` returned by `get_creator` decodes correctly here. We mirror the
// struct rather than importing paywall_core as a runtime dependency just for the
// type — that would pull the whole contract into the adapter's WASM. A
// `#[contracttype]` struct's XDR layout is determined solely by its field
// names/order/types, so this decodes the same wire value.
#[contracttype]
#[derive(Clone)]
pub struct CreatorInfo {
    pub address: Address,
    pub price: i128,
    pub platform_fee: i128,
    pub enabled: bool,
}

// ── Event emitted by pay() ────────────────────────────────────────────────────

#[contractevent]
pub struct PayAdapterEvent {
    #[topic]
    pub domain: String,
    #[topic]
    pub slug: String,
    pub owner: Address,
    pub price: i128,
    pub platform_fee: i128,
    pub fee_atomic: i128,
    pub creator: Address,
}

// ── Production contract ───────────────────────────────────────────────────────

#[contract]
pub struct VerivyxPayAdapter;

#[contractimpl]
impl VerivyxPayAdapter {
    /// Initialize the adapter. Must be called once after deployment.
    ///
    /// - `usdc`: the one SEP-41 USDC token this adapter will use.
    /// - `paywall`: the one `paywall_core` contract this adapter reads the
    ///   authoritative price + platform fee from (via `get_creator`).
    /// - `fee_treasury`: Verivyx treasury address that receives the flat service fee.
    /// - `fee_atomic`: flat Verivyx service fee in atomic USDC (≥ 0). Fixed in
    ///   storage — cannot be changed by callers.
    /// - `platform`: platform fee destination. MUST equal paywall_core's
    ///   `platform_address` (same off-chain env source) so the split credits the
    ///   same platform wallet the on-chain config expects.
    pub fn init(
        env: Env,
        usdc: Address,
        paywall: Address,
        fee_treasury: Address,
        fee_atomic: i128,
        platform: Address,
    ) {
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);
        // Guard double-init
        if env.storage().instance().has(&DataKey::Usdc) {
            panic!("already initialized");
        }
        assert!(fee_atomic >= 0, "fee_atomic must be >= 0");
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.storage().instance().set(&DataKey::Paywall, &paywall);
        env.storage().instance().set(&DataKey::FeeTreasury, &fee_treasury);
        env.storage().instance().set(&DataKey::FeeAtomic, &fee_atomic);
        env.storage().instance().set(&DataKey::Platform, &platform);
    }

    /// Execute a destination-locked, fee-inclusive **direct 3-way split**.
    ///
    /// - `owner`:  the account whose SEP-41 allowance (approved to this adapter) is
    ///             drawn. The owner must have pre-approved this adapter contract as
    ///             the spender for at least `price + fee_atomic`.
    /// - `domain`: domain registered in `paywall_core` (identifies the resource and
    ///             supplies the authoritative price + platform fee).
    /// - `slug`:   article / resource slug (recorded in the emitted event).
    ///
    /// There is no caller `amount`: the price and platform fee are read live from
    /// `paywall_core` and the Verivyx fee is read from adapter storage, so no leg of
    /// the split can be spoofed.
    ///
    /// Atomically (spender = this adapter in every leg):
    ///   1. `transfer_from(adapter, owner, creator,      price − platform_fee)`
    ///   2. `transfer_from(adapter, owner, platform,     platform_fee)`  (if > 0)
    ///   3. `transfer_from(adapter, owner, fee_treasury, fee_atomic)`    (if > 0)
    ///   4. Emits `PayAdapterEvent`.
    ///
    /// Total debited from owner = `price + fee_atomic`.
    pub fn pay(
        env: Env,
        owner: Address,
        domain: String,
        slug: String,
    ) {
        env.storage().instance().extend_ttl(LEDGER_TTL, LEDGER_TTL);

        // ── Delegation gate ──────────────────────────────────────────────────
        // `owner` is the user's OZ smart-account address. Requiring its auth makes
        // the host invoke that smart account's `__check_auth` → `do_check_auth`,
        // which enforces the session signer, the `CallContract(adapter)`
        // destination-lock rule, and the rule's `valid_until` expiry. Without this
        // call there is NO delegation gate — anyone who knew the adapter address
        // and an existing allowance could drain `pay`. This is the single point
        // that binds a settlement to a budget-capped, expiring, destination-locked
        // session signer.
        owner.require_auth();

        let usdc: Address = env.storage().instance().get(&DataKey::Usdc)
            .expect("not initialized");
        let paywall: Address = env.storage().instance().get(&DataKey::Paywall)
            .expect("not initialized");
        let fee_treasury: Address = env.storage().instance().get(&DataKey::FeeTreasury)
            .expect("not initialized");
        let fee_atomic: i128 = env.storage().instance().get(&DataKey::FeeAtomic)
            .expect("not initialized");
        let platform: Address = env.storage().instance().get(&DataKey::Platform)
            .expect("not initialized");

        // ── Read the authoritative on-chain config ──────────────────────────
        // Cross-call paywall_core::get_creator(domain) and decode into the
        // field-identical CreatorInfo mirror. get_creator takes no auth.
        let creator: Option<CreatorInfo> = env.invoke_contract(
            &paywall,
            &Symbol::new(&env, "get_creator"),
            vec![&env, domain.into_val(&env)],
        );
        let cd = creator.expect("domain not registered");
        assert!(cd.enabled, "paywall disabled");

        // price - platform_fee > 0 by paywall_core's register invariant
        // (0 < platform_fee < price). No defensive branch needed.
        let creator_share = cd.price - cd.platform_fee;
        debug_assert!(creator_share > 0);

        let adapter = env.current_contract_address();
        let t = token::Client::new(&env, &usdc);

        // Leg 1: creator share. SEP-41 transfer_from arg order: (spender, from, to, amount).
        t.transfer_from(&adapter, &owner, &cd.address, &creator_share);

        // Leg 2: platform fee (read from chain, not a caller arg).
        if cd.platform_fee > 0 {
            t.transfer_from(&adapter, &owner, &platform, &cd.platform_fee);
        }

        // Leg 3: flat Verivyx service fee (read from storage, not a caller arg).
        if fee_atomic > 0 {
            t.transfer_from(&adapter, &owner, &fee_treasury, &fee_atomic);
        }

        // Emit event
        PayAdapterEvent {
            domain,
            slug,
            owner,
            price: cd.price,
            platform_fee: cd.platform_fee,
            fee_atomic,
            creator: cd.address,
        }.publish(&env);
    }
}

#[cfg(test)]
mod test;
