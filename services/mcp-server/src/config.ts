import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseApiKeys } from "./apiKeys.js";
import type { ApiKeyEntry } from "./apiKeys.js";
import {
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  USDC_PUBNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
} from "./core/stellar/constants.js";

// Load the repo-root .env when present (local dev). In docker the env is injected
// by docker-compose, so a missing file is fine.
const currentDir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(currentDir, "..", "..", "..", ".env") });

/** Crash on a missing required env var with a clear message. */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name)?.toLowerCase();
  if (value === undefined) return fallback;
  return value === "1" || value === "true" || value === "yes";
}

type StellarNetwork = typeof STELLAR_TESTNET_CAIP2 | typeof STELLAR_PUBNET_CAIP2;

function resolveStellarNetwork(): StellarNetwork {
  // Accept both the short style ("testnet"/"mainnet") and CAIP-2 form.
  const raw = (optionalEnv("STELLAR_NETWORK") ?? "testnet").toLowerCase();
  if (raw === STELLAR_TESTNET_CAIP2 || raw === "testnet") return STELLAR_TESTNET_CAIP2;
  if (raw === STELLAR_PUBNET_CAIP2 || raw === "mainnet" || raw === "pubnet") {
    return STELLAR_PUBNET_CAIP2;
  }
  throw new Error(`Unsupported STELLAR_NETWORK: ${raw}`);
}

export type StellarChainConfig = {
  readonly kind: "stellar";
  readonly enabled: true;
  readonly network: StellarNetwork;
  readonly isTestnet: boolean;
  readonly rpcUrl: string | undefined;
  readonly horizonUrl: string;
  readonly usdcContract: string;
  readonly usdcIssuer: string;
  readonly usdcDecimals: number;
  readonly feeTreasury: string;
};

export type PlannedChainConfig = {
  readonly kind: "base" | "solana";
  readonly enabled: false;
  readonly plannedPhase: string;
};

const DEFAULT_TESTNET_RPC = "https://soroban-testnet.stellar.org";
const DEFAULT_TESTNET_HORIZON = "https://horizon-testnet.stellar.org";
const DEFAULT_MAINNET_HORIZON = "https://horizon.stellar.org";
// Testnet classic USDC issuer (Circle testnet). Mainnet must be set explicitly.
const DEFAULT_TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function buildStellarConfig(): StellarChainConfig {
  const network = resolveStellarNetwork();
  const isTestnet = network === STELLAR_TESTNET_CAIP2;
  return {
    kind: "stellar",
    enabled: true,
    network,
    isTestnet,
    rpcUrl: optionalEnv("STELLAR_RPC_URL") ?? (isTestnet ? DEFAULT_TESTNET_RPC : undefined),
    horizonUrl:
      optionalEnv("HORIZON_URL") ?? (isTestnet ? DEFAULT_TESTNET_HORIZON : DEFAULT_MAINNET_HORIZON),
    usdcContract: optionalEnv("USDC_CONTRACT_ID") ?? (isTestnet ? USDC_TESTNET_ADDRESS : USDC_PUBNET_ADDRESS),
    usdcIssuer: isTestnet
      ? optionalEnv("USDC_ISSUER") ?? DEFAULT_TESTNET_USDC_ISSUER
      : requireEnv("USDC_ISSUER"),
    usdcDecimals: 7,
    // Default the fee treasury to the platform wallet; override per chain if needed.
    feeTreasury: optionalEnv("MCP_FEE_TREASURY_STELLAR") ?? requireEnv("PLATFORM_STELLAR_ADDRESS"),
  };
}

// ---- EVM (Base) ----
type EvmNetworkName = "base-sepolia" | "base";

type EvmNetworkSpec = {
  readonly caip2: string;
  readonly chainId: number;
  readonly isTestnet: boolean;
  readonly defaultRpc: string;
  readonly usdc: `0x${string}`;
};

const EVM_NETWORKS: Record<EvmNetworkName, EvmNetworkSpec> = {
  "base-sepolia": {
    caip2: "eip155:84532",
    chainId: 84532,
    isTestnet: true,
    defaultRpc: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  base: {
    caip2: "eip155:8453",
    chainId: 8453,
    isTestnet: false,
    defaultRpc: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

export type EvmChainConfig = {
  readonly kind: "evm";
  readonly enabled: true;
  readonly network: EvmNetworkName;
  readonly caip2: string;
  readonly chainId: number;
  readonly isTestnet: boolean;
  readonly rpcUrl: string;
  readonly usdc: `0x${string}`;
  readonly usdcDecimals: number;
  readonly feeTreasury: `0x${string}`;
  readonly privateKey: `0x${string}`;
};

function buildEvmConfig(): EvmChainConfig | undefined {
  // EVM rail is enabled only when a paying key is configured.
  const privateKeyRaw = optionalEnv("MCP_EVM_PRIVATE_KEY");
  if (!privateKeyRaw) return undefined;

  const networkName = (optionalEnv("EVM_NETWORK") ?? "base-sepolia") as EvmNetworkName;
  const spec = EVM_NETWORKS[networkName];
  if (!spec) {
    throw new Error(`Unsupported EVM_NETWORK: ${networkName}. Use base-sepolia or base.`);
  }

  const privateKey = (privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`) as `0x${string}`;
  const feeTreasury = requireEnv("MCP_FEE_TREASURY_EVM") as `0x${string}`;

  return {
    kind: "evm",
    enabled: true,
    network: networkName,
    caip2: spec.caip2,
    chainId: spec.chainId,
    isTestnet: spec.isTestnet,
    rpcUrl: optionalEnv("EVM_RPC_URL") ?? spec.defaultRpc,
    usdc: (optionalEnv("EVM_USDC_ADDRESS") as `0x${string}` | undefined) ?? spec.usdc,
    usdcDecimals: 6,
    feeTreasury,
    privateKey,
  };
}

// ---- Solana ----
type SolanaNetworkName = "devnet" | "mainnet";

type SolanaNetworkSpec = {
  readonly caip2: string;
  readonly isTestnet: boolean;
  readonly defaultRpc: string;
  readonly usdc: string;
};

// CAIP-2 + USDC mint constants (from @x402/svm). Stable network identifiers.
const SOLANA_NETWORKS: Record<SolanaNetworkName, SolanaNetworkSpec> = {
  devnet: {
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    isTestnet: true,
    defaultRpc: "https://api.devnet.solana.com",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  },
  mainnet: {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    isTestnet: false,
    defaultRpc: "https://api.mainnet-beta.solana.com",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
};

export type SolanaChainConfig = {
  readonly kind: "solana";
  readonly enabled: true;
  readonly network: SolanaNetworkName;
  readonly caip2: string;
  readonly isTestnet: boolean;
  readonly rpcUrl: string;
  readonly usdc: string;
  readonly usdcDecimals: number;
  readonly feeTreasury: string;
  readonly secretKey: string;
};

function buildSolanaConfig(): SolanaChainConfig | undefined {
  const secretKey = optionalEnv("MCP_SOLANA_SECRET");
  if (!secretKey) return undefined;

  const networkName = (optionalEnv("SOLANA_NETWORK") ?? "devnet") as SolanaNetworkName;
  const spec = SOLANA_NETWORKS[networkName];
  if (!spec) {
    throw new Error(`Unsupported SOLANA_NETWORK: ${networkName}. Use devnet or mainnet.`);
  }

  return {
    kind: "solana",
    enabled: true,
    network: networkName,
    caip2: spec.caip2,
    isTestnet: spec.isTestnet,
    rpcUrl: optionalEnv("SOLANA_RPC_URL") ?? spec.defaultRpc,
    usdc: optionalEnv("SOLANA_USDC_MINT") ?? spec.usdc,
    usdcDecimals: 6,
    feeTreasury: requireEnv("MCP_FEE_TREASURY_SOLANA"),
    secretKey,
  };
}

export type AppConfig = {
  readonly port: number;
  readonly mainnetEnabled: boolean;
  /** API keys allowed to call /mcp, stored as SHA-256 hashes with per-key labels. */
  readonly apiKeys: readonly ApiKeyEntry[];
  readonly internalToken: string;
  /** OAuth 2.1 / Hydra resource server config. Present only when HYDRA_ISSUER is set. */
  readonly oauth: { readonly issuer: string; readonly jwksUrl: string; readonly resourceUri: string } | undefined;
  /** Shared HS256 secret from auth-service (JWT_SECRET). When set, /wallet/* also accepts
   * dashboard paywall_token JWTs (audience "creator", claim id:number → sub=String(id)).
   * When unset, only the Hydra OAuth path works for /wallet/*. */
  readonly dashboardJwtSecret: string | undefined;
  readonly feeUsdc: string;
  readonly stellarSecretKey: string;
  readonly stellar: StellarChainConfig;
  readonly evm: EvmChainConfig | undefined;
  readonly solana: SolanaChainConfig | undefined;
  readonly plannedChains: readonly PlannedChainConfig[];
  readonly facilitatorUrl: string | undefined;
  readonly facilitatorApiKey: string | undefined;
  /** When non-empty, target URLs must start with one of these prefixes. */
  readonly allowedPaymentPrefixes: readonly string[];
  /** Allowed Host header values for /mcp (DNS-rebinding defense). "*" disables. */
  readonly allowedHosts: readonly string[];
  /** Allowed Origin header values for /mcp (when an Origin is present). "*" disables. */
  readonly allowedOrigins: readonly string[];
  /**
   * verivyx_pay_adapter contract ID (C…).
   * Optional: undefined when VERIVYX_PAY_ADAPTER_ID is not set (feature disabled).
   * Used by session-key payment builder (wallet/sessionPayment.ts).
   */
  readonly payAdapterId: string | undefined;
};

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const stellar = buildStellarConfig();
  const evm = buildEvmConfig();
  const solana = buildSolanaConfig();
  const mainnetEnabled = boolEnv("MCP_MAINNET_ENABLED", false);

  // Hard testnet guard: refuse to run a mainnet chain unless mainnet is explicitly enabled.
  if (!stellar.isTestnet && !mainnetEnabled) {
    throw new Error(
      "STELLAR_NETWORK is mainnet but MCP_MAINNET_ENABLED is not true. Refusing to start (testnet-only guard).",
    );
  }
  if (evm && !evm.isTestnet && !mainnetEnabled) {
    throw new Error(
      "EVM_NETWORK is mainnet but MCP_MAINNET_ENABLED is not true. Refusing to start (testnet-only guard).",
    );
  }
  if (solana && !solana.isTestnet && !mainnetEnabled) {
    throw new Error(
      "SOLANA_NETWORK is mainnet but MCP_MAINNET_ENABLED is not true. Refusing to start (testnet-only guard).",
    );
  }

  const apiKeys = parseApiKeys(optionalEnv("MCP_API_KEYS") ?? "");

  const hydraIssuer = optionalEnv("HYDRA_ISSUER")?.replace(/\/$/, "");
  const oauth = hydraIssuer ? {
    issuer: hydraIssuer,
    jwksUrl: optionalEnv("HYDRA_JWKS_URL") ?? `${hydraIssuer}/.well-known/jwks.json`,
    resourceUri: optionalEnv("MCP_RESOURCE_URI") ?? "https://mcp.verivyx.com/mcp",
  } : undefined;

  cached = {
    port: Number(optionalEnv("MCP_PORT") ?? "8088"),
    mainnetEnabled,
    apiKeys,
    internalToken: requireEnv("INTERNAL_TOKEN"),
    feeUsdc: optionalEnv("MCP_FEE_USDC") ?? "0.001",
    // Dedicated MCP paying wallet for v1 (testnet). NEVER reuse the facilitator
    // or any other key. Non-custodial session keys replace this later.
    stellarSecretKey: requireEnv("MCP_STELLAR_SECRET"),
    stellar,
    evm,
    solana,
    plannedChains: [
      ...(evm ? [] : [{ kind: "base" as const, enabled: false as const, plannedPhase: "F1" }]),
      ...(solana ? [] : [{ kind: "solana" as const, enabled: false as const, plannedPhase: "F2" }]),
    ],
    facilitatorUrl: optionalEnv("X402_FACILITATOR_URL"),
    facilitatorApiKey: optionalEnv("X402_FACILITATOR_API_KEY"),
    allowedPaymentPrefixes: (optionalEnv("MCP_ALLOWED_PAYMENT_PREFIXES") ?? "")
      .split(",")
      .map(p => p.trim())
      .filter(Boolean),
    // DNS-rebinding defense: validate the Host (and Origin, when present) of /mcp
    // requests. Defaults cover the public host + the internal docker name the
    // playground uses. Override with MCP_ALLOWED_HOSTS / MCP_ALLOWED_ORIGINS;
    // set either to "*" to disable that check.
    allowedHosts: (optionalEnv("MCP_ALLOWED_HOSTS") ??
      "mcp.verivyx.com,mcp-server:8088,localhost:8088,127.0.0.1:8088")
      .split(",")
      .map(h => h.trim().toLowerCase())
      .filter(Boolean),
    allowedOrigins: (optionalEnv("MCP_ALLOWED_ORIGINS") ??
      "https://mcp.verivyx.com,https://verivyx.com,https://docs.verivyx.com")
      .split(",")
      .map(o => o.trim().toLowerCase())
      .filter(Boolean),
    oauth,
    dashboardJwtSecret: optionalEnv("JWT_SECRET"),
    payAdapterId: optionalEnv("VERIVYX_PAY_ADAPTER_ID"),
  };

  return cached;
}
