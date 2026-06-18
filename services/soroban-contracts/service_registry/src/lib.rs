#![no_std]
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, contracterror,
    Address, Env, String,
};

// ~120 days at 5s/ledger on Stellar Testnet.
const LEDGER_TTL: u32 = 2_073_600;

#[contracterror]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ContractError {
    AlreadyInitialized  = 1,
    DomainNotRegistered = 2,
    Unauthorized        = 3,
    InvalidPrice        = 4,
}

/// On-chain record for a registered service/domain.
/// All amounts use 7-decimal atomic USDC (1 USDC = 10_000_000).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceRecord {
    pub owner:            Address,
    pub price_atomic:     i128, // Total price in atomic USDC
    pub paywall_enabled:  bool,
}

#[contracttype]
pub enum DataKey {
    Service(String), // Persistent: domain → ServiceRecord
    Admin,           // Instance: contract admin
}

/// Emitted when a service domain is registered or updated.
#[contractevent]
pub struct ServiceRegisterEvent {
    #[topic]
    pub domain: String,
    pub owner: Address,
    pub price_atomic: i128,
}

#[contract]
pub struct ServiceRegistry;

#[contractimpl]
impl ServiceRegistry {
    /// Initialize the registry with an admin address.
    pub fn init(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Register or update a domain. Owner must authorize.
    /// `price_atomic`: price in atomic USDC units (7 decimals). Must be > 0.
    pub fn register(
        env: Env,
        domain: String,
        owner: Address,
        price_atomic: i128,
    ) -> Result<(), ContractError> {
        if price_atomic <= 0 {
            return Err(ContractError::InvalidPrice);
        }
        owner.require_auth();

        let record = ServiceRecord {
            owner: owner.clone(),
            price_atomic,
            paywall_enabled: true,
        };

        let key = DataKey::Service(domain.clone());
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);

        ServiceRegisterEvent { domain, owner, price_atomic }.publish(&env);
        Ok(())
    }

    /// Retrieve a service record (read-only).
    pub fn get_service(env: Env, domain: String) -> Option<ServiceRecord> {
        env.storage().persistent().get(&DataKey::Service(domain))
    }

    /// Toggle paywall on/off. Only the domain owner can call this.
    pub fn set_enabled(
        env: Env,
        owner: Address,
        domain: String,
        enabled: bool,
    ) -> Result<(), ContractError> {
        owner.require_auth();

        let mut record: ServiceRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Service(domain.clone()))
            .ok_or(ContractError::DomainNotRegistered)?;

        if record.owner != owner {
            return Err(ContractError::Unauthorized);
        }

        record.paywall_enabled = enabled;
        let key = DataKey::Service(domain);
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    fn setup() -> (Env, ServiceRegistryClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ServiceRegistry, ());
        let client: ServiceRegistryClient<'static> =
            unsafe { core::mem::transmute(ServiceRegistryClient::new(&env, &id)) };
        let admin = Address::generate(&env);
        client.init(&admin);
        (env, client, admin)
    }

    #[test]
    fn test_register_and_get() {
        let (env, client, _) = setup();
        let owner  = Address::generate(&env);
        let domain = String::from_str(&env, "mysite.com");

        client.register(&domain, &owner, &50_000);
        let rec = client.get_service(&domain).unwrap();

        assert_eq!(rec.owner,           owner);
        assert_eq!(rec.price_atomic,    50_000);
        assert!(rec.paywall_enabled);
    }

    #[test]
    fn test_register_invalid_price() {
        let (env, client, _) = setup();
        let owner  = Address::generate(&env);
        let domain = String::from_str(&env, "bad.com");

        assert_eq!(
            client.try_register(&domain, &owner, &0),
            Err(Ok(ContractError::InvalidPrice))
        );
    }

    #[test]
    fn test_get_missing_returns_none() {
        let (env, client, _) = setup();
        let domain = String::from_str(&env, "none.com");
        assert!(client.get_service(&domain).is_none());
    }

    #[test]
    fn test_set_enabled_toggle() {
        let (env, client, _) = setup();
        let owner  = Address::generate(&env);
        let domain = String::from_str(&env, "tog.com");

        client.register(&domain, &owner, &10_000);
        client.set_enabled(&owner, &domain, &false);
        assert!(!client.get_service(&domain).unwrap().paywall_enabled);
    }

    #[test]
    fn test_set_enabled_unauthorized() {
        let (env, client, _) = setup();
        let owner  = Address::generate(&env);
        let other  = Address::generate(&env);
        let domain = String::from_str(&env, "auth.com");

        client.register(&domain, &owner, &10_000);
        assert_eq!(
            client.try_set_enabled(&other, &domain, &false),
            Err(Ok(ContractError::Unauthorized))
        );
    }
}
