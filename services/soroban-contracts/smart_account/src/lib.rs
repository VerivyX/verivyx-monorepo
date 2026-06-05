#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    token, Address, Env,
};

// ~120 days at 5s/ledger on Stellar Testnet.
const LEDGER_TTL: u32 = 2_073_600;

#[contracterror]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ContractError {
    AlreadyInitialized  = 1,
    NotInitialized      = 2,
    Unauthorized        = 3,
    SpendLimitExceeded  = 4,
    InvalidAmount       = 5,
}

#[contracttype]
pub enum DataKey {
    Owner,                // Instance: account owner address
    UsdcContract,         // Instance: USDC token contract address
    SpendLimit(Address),  // Persistent: max spend per provider address
}

/// An on-chain smart account that lets an AI agent pre-authorize USDC spending.
///
/// Flow:
///   1. Owner calls `init` after deployment.
///   2. Owner calls `set_limit` to authorize a provider (e.g. Verivyx gateway)
///      up to a maximum USDC amount per session.
///   3. Agent calls `execute_payment` — contract transfers USDC from its own
///      balance to the provider and deducts from the remaining limit.
///   4. Owner can top-up the contract's USDC balance directly via token transfer.
#[contract]
pub struct SmartAccount;

#[contractimpl]
impl SmartAccount {
    /// Initialize the smart account. Must be called once after deployment.
    /// - `owner`: address that controls limit settings.
    /// - `usdc_contract`: Stellar USDC SEP-41 token contract address.
    pub fn init(
        env: Env,
        owner: Address,
        usdc_contract: Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Owner) {
            return Err(ContractError::AlreadyInitialized);
        }
        owner.require_auth();
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::UsdcContract, &usdc_contract);
        Ok(())
    }

    /// Set the maximum amount (atomic USDC, 7 decimals) this account will
    /// pay to a specific provider address. Only the owner can call this.
    pub fn set_limit(
        env: Env,
        provider: Address,
        max_atomic: i128,
    ) -> Result<(), ContractError> {
        if max_atomic < 0 {
            return Err(ContractError::InvalidAmount);
        }
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .ok_or(ContractError::NotInitialized)?;
        owner.require_auth();

        let key = DataKey::SpendLimit(provider);
        env.storage().persistent().set(&key, &max_atomic);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);
        Ok(())
    }

    /// Return remaining spend limit for a provider (0 if not set).
    pub fn get_limit(env: Env, provider: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::SpendLimit(provider))
            .unwrap_or(0)
    }

    /// Execute a micropayment from this smart account to a provider.
    /// Owner must authorize each payment call.
    /// Deducts `amount_atomic` from the provider's remaining limit and
    /// transfers USDC from this contract's balance to the provider.
    pub fn execute_payment(
        env: Env,
        provider: Address,
        amount_atomic: i128,
    ) -> Result<(), ContractError> {
        if amount_atomic <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .ok_or(ContractError::NotInitialized)?;
        owner.require_auth();

        let usdc_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcContract)
            .ok_or(ContractError::NotInitialized)?;

        let current_limit = Self::get_limit(env.clone(), provider.clone());
        if amount_atomic > current_limit {
            return Err(ContractError::SpendLimitExceeded);
        }

        let new_limit = current_limit - amount_atomic;
        let key = DataKey::SpendLimit(provider.clone());
        env.storage().persistent().set(&key, &new_limit);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);

        // Transfer USDC from this contract's own balance to the provider.
        token::Client::new(&env, &usdc_contract)
            .transfer(&env.current_contract_address(), &provider, &amount_atomic);

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, token, Address, Env};

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(SmartAccount, ());
        let owner       = Address::generate(&env);
        let usdc_admin  = Address::generate(&env);
        let usdc_id     = env.register_stellar_asset_contract_v2(usdc_admin).address();

        SmartAccountClient::new(&env, &contract_id).init(&owner, &usdc_id);
        (env, contract_id, owner, usdc_id)
    }

    #[test]
    fn test_init_double_fails() {
        let (env, contract_id, owner, usdc_id) = setup();
        let client = SmartAccountClient::new(&env, &contract_id);
        assert_eq!(
            client.try_init(&owner, &usdc_id),
            Err(Ok(ContractError::AlreadyInitialized))
        );
    }

    #[test]
    fn test_set_and_get_limit() {
        let (env, contract_id, _, _) = setup();
        let client   = SmartAccountClient::new(&env, &contract_id);
        let provider = Address::generate(&env);

        client.set_limit(&provider, &500_000);
        assert_eq!(client.get_limit(&provider), 500_000);
    }

    #[test]
    fn test_get_limit_unknown_returns_zero() {
        let (env, contract_id, _, _) = setup();
        let client   = SmartAccountClient::new(&env, &contract_id);
        let provider = Address::generate(&env);
        assert_eq!(client.get_limit(&provider), 0);
    }

    #[test]
    fn test_execute_payment_deducts_limit_and_transfers() {
        let (env, contract_id, _, usdc_id) = setup();
        let client   = SmartAccountClient::new(&env, &contract_id);
        let provider = Address::generate(&env);
        let amount: i128 = 10_000;

        // Fund the smart account contract itself with USDC.
        token::StellarAssetClient::new(&env, &usdc_id).mint(&contract_id, &100_000);

        client.set_limit(&provider, &50_000);
        client.execute_payment(&provider, &amount);

        assert_eq!(client.get_limit(&provider), 50_000 - amount);
        assert_eq!(token::Client::new(&env, &usdc_id).balance(&provider), amount);
    }

    #[test]
    fn test_execute_payment_exceeds_limit() {
        let (env, contract_id, _, _) = setup();
        let client   = SmartAccountClient::new(&env, &contract_id);
        let provider = Address::generate(&env);

        client.set_limit(&provider, &1_000);
        assert_eq!(
            client.try_execute_payment(&provider, &2_000),
            Err(Ok(ContractError::SpendLimitExceeded))
        );
    }

    #[test]
    fn test_execute_payment_zero_amount_rejected() {
        let (env, contract_id, _, _) = setup();
        let client   = SmartAccountClient::new(&env, &contract_id);
        let provider = Address::generate(&env);

        assert_eq!(
            client.try_execute_payment(&provider, &0),
            Err(Ok(ContractError::InvalidAmount))
        );
    }

    #[test]
    fn test_execute_payment_negative_amount_rejected() {
        let (env, contract_id, _, _) = setup();
        let client   = SmartAccountClient::new(&env, &contract_id);
        let provider = Address::generate(&env);

        assert_eq!(
            client.try_execute_payment(&provider, &-1),
            Err(Ok(ContractError::InvalidAmount))
        );
    }
}
