//! # Verivyx Pay Adapter — SPIKE ONLY
//!
//! This is a research scratch crate. It exists solely to verify that the
//! OpenZeppelin `stellar-accounts 0.5.0` API compiles against soroban-sdk
//! 23.5.3 and that the delegation + destination-lock flow works as expected.
//!
//! NOT production code. Will be replaced by the real adapter in Plan 1 Task 2.
#![no_std]

// Re-export types used in tests so the test module can import them cleanly.
pub use stellar_accounts::smart_account::{
    add_context_rule, add_policy, add_signer, do_check_auth, ContextRule, ContextRuleType,
    Signatures, Signer,
};
pub use stellar_accounts::policies::spending_limit::SpendingLimitAccountParams;

#[cfg(test)]
mod test;
