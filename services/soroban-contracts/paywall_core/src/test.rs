#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, storage::Persistent as _},
    token, Address, Env, String,
};

// ── helper ─────────────────────────────────────────────────────────────────

/// Returns (env, contract_id, admin, platform, usdc_id) with init already called.
/// A keeper address is generated internally and registered for `distribute`.
/// usdc_id is the official USDC token registered at init.
fn setup() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PaywallContract, ());
    let admin       = Address::generate(&env);
    let platform    = Address::generate(&env);
    let keeper      = Address::generate(&env);
    let usdc_admin  = Address::generate(&env);
    let usdc_id     = env.register_stellar_asset_contract_v2(usdc_admin).address();

    let client = PaywallContractClient::new(&env, &contract_id);
    client.init(&admin, &platform, &keeper, &usdc_id);

    (env, contract_id, admin, platform, usdc_id)
}

fn mint(env: &Env, usdc_id: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, usdc_id).mint(to, &amount);
}

// ── init ───────────────────────────────────────────────────────────────────

#[test]
fn test_init_double_fails() {
    let (env, contract_id, admin, platform, usdc_id) = setup();
    let client = PaywallContractClient::new(&env, &contract_id);
    let keeper = Address::generate(&env);

    assert_eq!(
        client.try_init(&admin, &platform, &keeper, &usdc_id),
        Err(Ok(ContractError::AlreadyInitialized))
    );
}

// ── register ───────────────────────────────────────────────────────────────

#[test]
fn test_register_stores_data() {
    let (env, contract_id, _, _, _) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "example.com");

    client.register(&creator, &domain, &50_000, &500);

    let data = client.get_creator(&domain).expect("creator not found");
    assert_eq!(data.address,      creator);
    assert_eq!(data.price,        50_000);
    assert_eq!(data.platform_fee, 500);
    assert!(data.enabled);
}

#[test]
fn test_register_overwrite() {
    let (env, contract_id, _, _, _) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "update.com");

    client.register(&creator, &domain, &10_000, &100);
    client.register(&creator, &domain, &20_000, &200);

    let data = client.get_creator(&domain).unwrap();
    assert_eq!(data.price,        20_000);
    assert_eq!(data.platform_fee, 200);
}

#[test]
fn test_register_price_zero_rejected() {
    let (env, contract_id, _, _, _) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "bad.com");

    assert_eq!(
        client.try_register(&creator, &domain, &0, &0),
        Err(Ok(ContractError::InvalidPrice))
    );
}

#[test]
fn test_register_fee_equals_price_rejected() {
    let (env, contract_id, _, _, _) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "feq.com");

    assert_eq!(
        client.try_register(&creator, &domain, &1_000, &1_000),
        Err(Ok(ContractError::InvalidPrice))
    );
}

#[test]
fn test_register_negative_fee_rejected() {
    let (env, contract_id, _, _, _) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "neg.com");

    assert_eq!(
        client.try_register(&creator, &domain, &1_000, &-1),
        Err(Ok(ContractError::InvalidPrice))
    );
}

// ── get_creator ────────────────────────────────────────────────────────────

#[test]
fn test_get_creator_missing_returns_none() {
    let (env, contract_id, _, _, _) = setup();
    let client = PaywallContractClient::new(&env, &contract_id);
    let domain = String::from_str(&env, "ghost.com");
    assert!(client.get_creator(&domain).is_none());
}

// ── pay ────────────────────────────────────────────────────────────────────

#[test]
fn test_pay_splits_correctly() {
    let (env, contract_id, _, platform, usdc_id) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let payer   = Address::generate(&env);
    let domain  = String::from_str(&env, "pay.com");

    let price:        i128 = 50_000;
    let platform_fee: i128 = 500;
    let creator_share       = price - platform_fee;

    client.register(&creator, &domain, &price, &platform_fee);
    mint(&env, &usdc_id, &payer, 1_000_000);

    client.pay(&payer, &domain, &usdc_id);

    let usdc = token::Client::new(&env, &usdc_id);
    assert_eq!(usdc.balance(&payer),    1_000_000 - price);
    assert_eq!(usdc.balance(&creator),  creator_share);
    assert_eq!(usdc.balance(&platform), platform_fee);
}

#[test]
fn test_pay_domain_not_registered() {
    let (env, contract_id, _, _, usdc_id) = setup();
    let client = PaywallContractClient::new(&env, &contract_id);
    let payer  = Address::generate(&env);
    let domain = String::from_str(&env, "ghost.com");

    assert_eq!(
        client.try_pay(&payer, &domain, &usdc_id),
        Err(Ok(ContractError::DomainNotRegistered))
    );
}

#[test]
fn test_pay_disabled_domain() {
    let (env, contract_id, _, _, usdc_id) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let payer   = Address::generate(&env);
    let domain  = String::from_str(&env, "off.com");

    client.register(&creator, &domain, &10_000, &100);
    client.set_enabled(&creator, &domain, &false);

    assert_eq!(
        client.try_pay(&payer, &domain, &usdc_id),
        Err(Ok(ContractError::PaywallDisabled))
    );
}

// ── register_by_keeper ──────────────────────────────────────────────────────

#[test]
fn test_register_by_keeper_stores_data() {
    let (env, contract_id, _, _, _) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "keeper-reg.com");

    client.register_by_keeper(&domain, &creator, &500_000, &10_000);

    let data = client.get_creator(&domain).expect("creator not found");
    assert_eq!(data.address,      creator);
    assert_eq!(data.price,        500_000);
    assert_eq!(data.platform_fee, 10_000);
    assert!(data.enabled);
}

#[test]
fn test_register_by_keeper_invalid_price_rejected() {
    let (env, contract_id, _, _, _) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "kbad.com");

    assert_eq!(
        client.try_register_by_keeper(&domain, &creator, &1_000, &1_000),
        Err(Ok(ContractError::InvalidPrice))
    );
}

// ── distribute (x402 spec settlement path) ──────────────────────────────────

#[test]
fn test_distribute_splits_from_contract_balance() {
    let (env, contract_id, _, platform, usdc_id) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "dist.com");

    let price:        i128 = 500_000;
    let platform_fee: i128 = 10_000;
    let creator_share       = price - platform_fee;

    client.register(&creator, &domain, &price, &platform_fee);
    // Simulate the agent's x402 spec transfer landing in the contract.
    mint(&env, &usdc_id, &contract_id, price);

    client.distribute(&domain, &usdc_id, &price);

    let usdc = token::Client::new(&env, &usdc_id);
    assert_eq!(usdc.balance(&contract_id), 0);
    assert_eq!(usdc.balance(&creator),     creator_share);
    assert_eq!(usdc.balance(&platform),    platform_fee);
}

#[test]
fn test_distribute_domain_not_registered() {
    let (env, contract_id, _, _, usdc_id) = setup();
    let client = PaywallContractClient::new(&env, &contract_id);
    let domain = String::from_str(&env, "ghost.com");

    assert_eq!(
        client.try_distribute(&domain, &usdc_id, &500_000),
        Err(Ok(ContractError::DomainNotRegistered))
    );
}

#[test]
fn test_distribute_amount_below_fee_rejected() {
    let (env, contract_id, _, _, usdc_id) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "low.com");

    client.register(&creator, &domain, &500_000, &10_000);

    assert_eq!(
        client.try_distribute(&domain, &usdc_id, &5_000),
        Err(Ok(ContractError::InvalidPrice))
    );
}

#[test]
fn test_distribute_disabled_domain() {
    let (env, contract_id, _, _, usdc_id) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "offdist.com");

    client.register(&creator, &domain, &500_000, &10_000);
    client.set_enabled(&creator, &domain, &false);

    assert_eq!(
        client.try_distribute(&domain, &usdc_id, &500_000),
        Err(Ok(ContractError::PaywallDisabled))
    );
}

// ── set_enabled ────────────────────────────────────────────────────────────

#[test]
fn test_set_enabled_toggle() {
    let (env, contract_id, _, _, _) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "toggle.com");

    client.register(&creator, &domain, &10_000, &100);
    assert!(client.get_creator(&domain).unwrap().enabled);

    client.set_enabled(&creator, &domain, &false);
    assert!(!client.get_creator(&domain).unwrap().enabled);

    client.set_enabled(&creator, &domain, &true);
    assert!(client.get_creator(&domain).unwrap().enabled);
}

#[test]
fn test_set_enabled_unauthorized() {
    let (env, contract_id, _, _, _) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let other   = Address::generate(&env);
    let domain  = String::from_str(&env, "auth.com");

    client.register(&creator, &domain, &10_000, &100);
    assert_eq!(
        client.try_set_enabled(&other, &domain, &false),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn test_set_enabled_domain_not_registered() {
    let (env, contract_id, _, _, _) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "missing.com");

    assert_eq!(
        client.try_set_enabled(&creator, &domain, &false),
        Err(Ok(ContractError::DomainNotRegistered))
    );
}

// ── USDC token assertion ───────────────────────────────────────────────────

#[test]
fn test_pay_wrong_token_rejected() {
    let (env, contract_id, _, _, _) = setup();
    let client   = PaywallContractClient::new(&env, &contract_id);
    let creator  = Address::generate(&env);
    let payer    = Address::generate(&env);
    let domain   = String::from_str(&env, "wrongtoken-pay.com");

    client.register(&creator, &domain, &50_000, &500);

    // Create a DIFFERENT token contract (not the usdc registered at init).
    let other_token_admin = Address::generate(&env);
    let other_token = env.register_stellar_asset_contract_v2(other_token_admin).address();
    mint(&env, &other_token, &payer, 1_000_000);

    assert_eq!(
        client.try_pay(&payer, &domain, &other_token),
        Err(Ok(ContractError::WrongAsset))
    );
}

#[test]
fn test_distribute_wrong_token_rejected() {
    let (env, contract_id, _, _, usdc_id) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let domain  = String::from_str(&env, "wrongtoken-dist.com");

    let price:        i128 = 500_000;
    let platform_fee: i128 = 10_000;

    client.register(&creator, &domain, &price, &platform_fee);

    // Mint correct USDC into the contract (simulating x402 inbound transfer).
    mint(&env, &usdc_id, &contract_id, price);

    // Create a DIFFERENT token and try to distribute with it.
    let other_token_admin = Address::generate(&env);
    let other_token = env.register_stellar_asset_contract_v2(other_token_admin).address();

    assert_eq!(
        client.try_distribute(&domain, &other_token, &price),
        Err(Ok(ContractError::WrongAsset))
    );
}

// ── keeper re-register guard ───────────────────────────────────────────────

#[test]
fn test_register_by_keeper_cannot_change_creator() {
    let (env, contract_id, _, _, _) = setup();
    let client   = PaywallContractClient::new(&env, &contract_id);
    let creator_a = Address::generate(&env);
    let creator_b = Address::generate(&env);
    let domain    = String::from_str(&env, "keeper-guard.com");

    // Keeper registers domain for creatorA.
    client.register_by_keeper(&domain, &creator_a, &500_000, &10_000);

    // Keeper tries to re-register the same domain for a different creatorB → Unauthorized.
    assert_eq!(
        client.try_register_by_keeper(&domain, &creator_b, &500_000, &10_000),
        Err(Ok(ContractError::Unauthorized))
    );

    // Keeper re-registering the SAME creatorA (price update) must still succeed.
    client.register_by_keeper(&domain, &creator_a, &600_000, &12_000);
    let data = client.get_creator(&domain).unwrap();
    assert_eq!(data.price,        600_000);
    assert_eq!(data.platform_fee, 12_000);
    assert_eq!(data.address,      creator_a);
}

// ── TTL extension ──────────────────────────────────────────────────────────

#[test]
fn test_pay_extends_creator_ttl() {
    let (env, contract_id, _, _, usdc_id) = setup();
    let client  = PaywallContractClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let payer   = Address::generate(&env);
    let domain  = String::from_str(&env, "ttl-pay.com");

    client.register(&creator, &domain, &50_000, &500);
    mint(&env, &usdc_id, &payer, 1_000_000);

    // Advance ledger to simulate partial TTL consumption.
    env.ledger().with_mut(|li| {
        li.sequence_number += 100_000;
    });

    client.pay(&payer, &domain, &usdc_id);

    // After pay, the creator entry TTL must be >= LEDGER_TTL (bumped by extend_ttl).
    let key = DataKey::Creator(domain);
    let ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&key)
    });
    assert!(ttl >= LEDGER_TTL, "expected TTL >= {LEDGER_TTL}, got {ttl}");
}
