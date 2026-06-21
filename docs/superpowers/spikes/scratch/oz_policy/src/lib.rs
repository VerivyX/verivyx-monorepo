#![no_std]
//! A deployable OZ `spending_limit` Policy contract for the standard-transfer spike.
//! Wraps the OZ `spending_limit` module free functions behind the `Policy` trait so
//! it can be `add_policy`'d to a smart-account context rule and meter USDC.transfer.
//!
//! install_param shape (the `Val` passed to add_policy) =
//!   SpendingLimitAccountParams { spending_limit: i128, period_ledgers: u32 }
//! which serializes as an ScMap { period_ledgers: u32, spending_limit: i128 }.
//!
//! SPIKE ONLY — not production code.
use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Val, Vec};
use stellar_accounts::{
    policies::{
        spending_limit::{
            can_enforce as sl_can_enforce, enforce as sl_enforce, install as sl_install,
            SpendingLimitAccountParams,
        },
        Policy,
    },
    smart_account::{ContextRule, Signer},
};

#[contract]
pub struct SpendingLimitPolicyContract;

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

    fn enforce(e: &Env, ctx: Context, signers: Vec<Signer>, rule: ContextRule, sa: Address) {
        sl_enforce(e, &ctx, &signers, &rule, &sa)
    }

    fn install(e: &Env, params: SpendingLimitAccountParams, rule: ContextRule, sa: Address) {
        sl_install(e, &params, &rule, &sa)
    }

    fn uninstall(_e: &Env, _rule: ContextRule, _sa: Address) {}
}
