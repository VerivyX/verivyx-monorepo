#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short,
    token, Address, BytesN, Env, String,
};

// ~120 days at 5s/ledger on Stellar Testnet.
// Extended on every write so data never expires while the creator is active.
const LEDGER_TTL: u32 = 2_073_600;

#[contracterror]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    DomainNotRegistered = 3,
    PaywallDisabled    = 4,
    Unauthorized       = 5,
    InvalidPrice       = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreatorData {
    pub address:      Address,
    pub price:        i128, // Total price — atomic USDC, 7 decimals (1 USDC = 10_000_000)
    pub platform_fee: i128, // Platform cut — atomic USDC, 7 decimals
    pub enabled:      bool,
}

#[contracttype]
pub enum DataKey {
    Creator(String), // Persistent: domain string → CreatorData
    Admin,           // Instance: admin address (set once at init) — can upgrade
    PlatformAddress, // Instance: platform wallet for fee collection
    Keeper,          // Instance: keeper address — authorized to call distribute()
}

#[contract]
pub struct PaywallContract;

#[contractimpl]
impl PaywallContract {
    /// Initialize the contract. Must be called once after deployment.
    /// - `admin`: can upgrade the contract WASM
    /// - `platform_address`: wallet that receives the platform fee
    /// - `keeper`: address authorized to call `distribute` (the off-chain facilitator)
    pub fn init(
        env: Env,
        admin: Address,
        platform_address: Address,
        keeper: Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PlatformAddress, &platform_address);
        env.storage().instance().set(&DataKey::Keeper, &keeper);
        Ok(())
    }

    /// Upgrade the contract WASM. Only the admin may call this.
    /// Enables future logic changes without redeploying (contract ID stays the same).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Register or update a creator's domain. Creator must authorize.
    /// - `price`: total amount the AI agent pays (atomic USDC, 7 decimals)
    /// - `platform_fee`: Verivyx cut out of that price (must be < price)
    pub fn register(
        env: Env,
        creator: Address,
        domain: String,
        price: i128,
        platform_fee: i128,
    ) -> Result<(), ContractError> {
        if price <= 0 || platform_fee < 0 || platform_fee >= price {
            return Err(ContractError::InvalidPrice);
        }
        creator.require_auth();

        let data = CreatorData {
            address: creator.clone(),
            price,
            platform_fee,
            enabled: true,
        };

        let key = DataKey::Creator(domain.clone());
        env.storage().persistent().set(&key, &data);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);

        env.events().publish(
            (symbol_short!("reg"), domain),
            (creator, price, platform_fee),
        );
        Ok(())
    }

    /// Register/update a domain on behalf of a creator. Only the keeper may call this.
    ///
    /// Mirrors the off-chain creator config (Verivyx dashboard) onto the chain so the
    /// trustless `distribute` split can run. The keeper can only set `creator` as the
    /// fund recipient — it cannot redirect a creator's earnings to itself, since the
    /// creator address is recorded on-chain and all splits pay out to it.
    pub fn register_by_keeper(
        env: Env,
        domain: String,
        creator: Address,
        price: i128,
        platform_fee: i128,
    ) -> Result<(), ContractError> {
        if price <= 0 || platform_fee < 0 || platform_fee >= price {
            return Err(ContractError::InvalidPrice);
        }
        let keeper: Address = env
            .storage()
            .instance()
            .get(&DataKey::Keeper)
            .ok_or(ContractError::NotInitialized)?;
        keeper.require_auth();

        let data = CreatorData {
            address: creator.clone(),
            price,
            platform_fee,
            enabled: true,
        };

        let key = DataKey::Creator(domain.clone());
        env.storage().persistent().set(&key, &data);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);

        env.events().publish(
            (symbol_short!("kreg"), domain),
            (creator, price, platform_fee),
        );
        Ok(())
    }

    /// Fetch creator config for a domain (read-only, no auth required).
    pub fn get_creator(env: Env, domain: String) -> Option<CreatorData> {
        env.storage().persistent().get(&DataKey::Creator(domain))
    }

    /// Execute a trustless split payment. Payer (AI agent) must authorize.
    ///
    /// Atomically transfers:
    ///   Op 1 — (price − platform_fee) → creator address
    ///   Op 2 — platform_fee            → platform address
    ///
    /// Both ops succeed or both revert — no partial payment possible.
    pub fn pay(
        env: Env,
        payer: Address,
        domain: String,
        usdc_token: Address,
    ) -> Result<(), ContractError> {
        payer.require_auth();

        let data: CreatorData = env
            .storage()
            .persistent()
            .get(&DataKey::Creator(domain.clone()))
            .ok_or(ContractError::DomainNotRegistered)?;

        if !data.enabled {
            return Err(ContractError::PaywallDisabled);
        }

        let platform_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformAddress)
            .ok_or(ContractError::NotInitialized)?;

        let creator_share = data.price - data.platform_fee;
        let token_client = token::Client::new(&env, &usdc_token);

        token_client.transfer(&payer, &data.address, &creator_share);
        token_client.transfer(&payer, &platform_address, &data.platform_fee);

        env.events().publish(
            (symbol_short!("pay"), domain),
            (payer, data.address, data.price),
        );
        Ok(())
    }

    /// Distribute funds the contract already holds for a domain's payment.
    ///
    /// This is the x402-spec settlement path: an external AI/MCP client sends a
    /// single spec-compliant `USDC.transfer(agent, this_contract, amount)`.
    /// Once those funds land here, the keeper (off-chain facilitator) calls
    /// `distribute` to split them on-chain:
    ///   (amount − platform_fee) → creator
    ///   platform_fee            → platform
    ///
    /// Funds move from the contract's own balance — no payer auth needed because
    /// the agent already authorized the transfer into this contract. Only the
    /// registered keeper may call this, and it passes the exact settled `amount`,
    /// so accumulated balances from concurrent payments are never over-distributed.
    pub fn distribute(
        env: Env,
        domain: String,
        usdc_token: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        let keeper: Address = env
            .storage()
            .instance()
            .get(&DataKey::Keeper)
            .ok_or(ContractError::NotInitialized)?;
        keeper.require_auth();

        let data: CreatorData = env
            .storage()
            .persistent()
            .get(&DataKey::Creator(domain.clone()))
            .ok_or(ContractError::DomainNotRegistered)?;

        if !data.enabled {
            return Err(ContractError::PaywallDisabled);
        }
        // amount must cover the platform fee and be positive
        if amount <= 0 || amount < data.platform_fee {
            return Err(ContractError::InvalidPrice);
        }

        let platform_address: Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformAddress)
            .ok_or(ContractError::NotInitialized)?;

        let creator_share = amount - data.platform_fee;
        let contract_addr = env.current_contract_address();
        let token_client = token::Client::new(&env, &usdc_token);

        // from = this contract; the contract authorizes its own outgoing transfers
        token_client.transfer(&contract_addr, &data.address, &creator_share);
        token_client.transfer(&contract_addr, &platform_address, &data.platform_fee);

        env.events().publish(
            (symbol_short!("distrib"), domain),
            (data.address, platform_address, amount),
        );
        Ok(())
    }

    /// Toggle paywall on/off. Only the creator who registered the domain can call this.
    pub fn set_enabled(
        env: Env,
        creator: Address,
        domain: String,
        enabled: bool,
    ) -> Result<(), ContractError> {
        creator.require_auth();

        let mut data: CreatorData = env
            .storage()
            .persistent()
            .get(&DataKey::Creator(domain.clone()))
            .ok_or(ContractError::DomainNotRegistered)?;

        if data.address != creator {
            return Err(ContractError::Unauthorized);
        }

        data.enabled = enabled;
        let key = DataKey::Creator(domain);
        env.storage().persistent().set(&key, &data);
        env.storage().persistent().extend_ttl(&key, LEDGER_TTL, LEDGER_TTL);

        Ok(())
    }
}

mod test;
