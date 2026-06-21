import type { x402Client } from "@x402/core/client";

import { ExactStellarScheme } from "../core/stellar/exact/client/scheme.js";
import { NonCustodialExactStellarScheme } from "../core/stellar/exact/client/nonCustodialScheme.js";
import { createEd25519Signer } from "../core/stellar/signer.js";
import type { StellarChainConfig } from "../config.js";

export type StellarRail = {
  readonly address: string;
};

/** Build the Stellar paying wallet and register its exact scheme on the shared x402 client. */
export function setupStellarRail(client: x402Client, config: StellarChainConfig, secretKey: string): StellarRail {
  const signer = createEd25519Signer(secretKey, config.network);
  client.register(
    "stellar:*",
    new ExactStellarScheme(signer, config.rpcUrl ? { url: config.rpcUrl } : undefined),
  );
  return { address: signer.address };
}

/**
 * Build a NON-CUSTODIAL Stellar rail: the caller pays the resource from THEIR OWN
 * smart account via the delegated session key (standard x402). No MCP-owned signer
 * is involved on this path. `address` reports the caller's smart account (the payer)
 * for diagnostics.
 */
export function setupStellarRailNonCustodial(
  client: x402Client,
  config: StellarChainConfig,
  smartAccountId: string,
  sessionSecret: string,
): StellarRail {
  client.register(
    "stellar:*",
    new NonCustodialExactStellarScheme({
      smartAccountId,
      sessionSecret,
      rpcConfig: config.rpcUrl ? { url: config.rpcUrl } : undefined,
    }),
  );
  return { address: smartAccountId };
}

export function stellarInfo(config: StellarChainConfig, address: string, feeUsdc: string): Record<string, unknown> {
  return {
    chain: config.network,
    address,
    asset: { code: "USDC", contract: config.usdcContract, issuer: config.usdcIssuer },
    rpcUrl: config.rpcUrl ?? null,
    horizonUrl: config.horizonUrl,
    serviceFee: feeUsdc,
    feeTreasury: config.feeTreasury,
    testnet: config.isTestnet,
  };
}
