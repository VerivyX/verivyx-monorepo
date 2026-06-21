import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";

import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { addDecimalStrings, atomsToDecimalString, decimalToBaseUnits } from "../money.js";
import { chargeStellarFee } from "../fee/stellar.js";
import { chargeStellarFeeNonCustodial } from "../fee/stellarNonCustodial.js";
import type { FeeReceipt } from "../fee/types.js";
import { assertPublicHttpsUrl } from "../ssrf.js";
import { STELLAR_NETWORK_TO_PASSPHRASE } from "../core/stellar/constants.js";
import { setupStellarRail, setupStellarRailNonCustodial, stellarInfo } from "./stellar.js";
import { setupEvmRail, type EvmRail } from "./evm.js";
import { chargeSolanaFee, setupSolanaRail, solanaInfo, type SolanaRail } from "./solana.js";

type HttpMethod = "GET" | "POST";

export type PayInput = {
  url: string;
  method: HttpMethod;
  body?: string;
  headers?: Record<string, string>;
};

export type PayResult = {
  url: string;
  method: HttpMethod;
  status: number;
  ok: boolean;
  paymentMade: boolean;
  chain: string | null;
  paymentReceipt: unknown;
  feeReceipt: FeeReceipt | null;
  feeError: string | null;
  response: unknown;
};

export type QuoteResult = {
  url: string;
  paymentRequired: boolean;
  chain: string | null;
  asset: string | null;
  resourceAmount: string | null;
  serviceFee: string;
  totalEstimate: string | null;
  payTo: string | null;
  raw: unknown;
};

export type PaymentService = {
  pay(input: PayInput): Promise<PayResult>;
  quote(input: PayInput): Promise<QuoteResult>;
  info(): Record<string, unknown>;
  supportedChains(): unknown[];
};

type Requirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
};

function tryParseBody(rawBody: string, contentType: string | null): unknown {
  if (!rawBody) return "";
  const looksJson = contentType?.toLowerCase().includes("application/json") ?? false;
  if (!looksJson) return rawBody;
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

function isRequirements(value: unknown): value is Requirements {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.network === "string" && typeof v.amount === "string" && typeof v.payTo === "string";
}

/** Pull the x402 `accepts[]` from a 402 response body or the PAYMENT-REQUIRED header. */
function extractAccepts(parsedBody: unknown, headerValue: string | null): Requirements[] {
  const fromObject = (obj: unknown): Requirements[] => {
    if (typeof obj !== "object" || obj === null) return [];
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.accepts)) return o.accepts.filter(isRequirements);
    if (isRequirements(o)) return [o];
    return [];
  };
  const fromBody = fromObject(parsedBody);
  if (fromBody.length > 0) return fromBody;
  if (headerValue) {
    try {
      const decoded = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as unknown;
      return fromObject(decoded);
    } catch {
      return [];
    }
  }
  return [];
}

function networkOf(receipt: unknown): string | null {
  if (typeof receipt !== "object" || receipt === null) return null;
  const r = receipt as Record<string, unknown>;
  return typeof r.network === "string" ? r.network : null;
}

/**
 * Build a payment service. By default it uses the configured platform wallets and
 * all chains. The playground passes a per-session Stellar wallet override (internal,
 * server-side, pooled testnet wallets) so each visitor pays from their own wallet.
 */
export async function createPaymentService(opts?: {
  stellarSecretKey?: string;
  stellarOnly?: boolean;
  /**
   * Non-custodial mode: pay the resource from the caller's OWN smart account via the
   * delegated session key (standard x402). Registers the non-custodial Stellar rail
   * instead of the custodial one; Stellar-only (the binding is a Stellar smart account).
   * The service fee is also charged non-custodially: a delegated USDC.transfer from the
   * smart account to the fee treasury, gas-sponsored by the MCP wallet.
   */
  nonCustodial?: { smartAccountId: string; sessionSecret: string };
  /**
   * OAuth caller with no linked wallet: a Stellar `pay` must NOT silently use the
   * custodial MCP wallet — it returns a structured `no_wallet_linked` error instead.
   * `quote` still works so the caller can see what a payment would cost.
   */
  noWalletLinked?: boolean;
}): Promise<PaymentService> {
  const cfg = getConfig();
  const stellarSecret = opts?.stellarSecretKey ?? cfg.stellarSecretKey;
  const isNonCustodial = !!opts?.nonCustodial;
  const noWalletLinked = !!opts?.noWalletLinked;
  const client = new x402Client();

  // Non-custodial is Stellar-only (the binding is a Stellar smart account); when set,
  // treat like stellarOnly (no EVM/Solana rails on this path).
  const stellarOnly = opts?.stellarOnly || isNonCustodial;

  const stellarRail = isNonCustodial
    ? setupStellarRailNonCustodial(
        client,
        cfg.stellar,
        opts!.nonCustodial!.smartAccountId,
        opts!.nonCustodial!.sessionSecret,
      )
    : setupStellarRail(client, cfg.stellar, stellarSecret);
  let evmRail: EvmRail | null = null;
  let solanaRail: SolanaRail | null = null;
  if (!stellarOnly) {
    if (cfg.evm) {
      evmRail = setupEvmRail(client, cfg.evm);
    }
    if (cfg.solana) {
      solanaRail = await setupSolanaRail(client, cfg.solana);
    }
  }

  const httpClient = new x402HTTPClient(client);
  const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);

  // Which networks we can actually pay (have a signer for).
  const supportedNetworks = new Set<string>([cfg.stellar.network]);
  if (cfg.evm) supportedNetworks.add(cfg.evm.caip2);
  if (cfg.solana) supportedNetworks.add(cfg.solana.caip2);

  function decimalsForNetwork(network: string): number {
    if (network.startsWith("stellar:")) return cfg.stellar.usdcDecimals;
    if (network.startsWith("eip155:")) return cfg.evm?.usdcDecimals ?? 6;
    if (network.startsWith("solana:")) return cfg.solana?.usdcDecimals ?? 6;
    return 6;
  }

  function canPay(network: string): boolean {
    if (supportedNetworks.has(network)) return true;
    // Accept any network of a family we have a signer for (resource may advertise a sibling network).
    if (network.startsWith("stellar:")) return true;
    if (network.startsWith("eip155:") && cfg.evm) return true;
    if (network.startsWith("solana:") && cfg.solana) return true;
    return false;
  }

  async function assertUrlAllowed(url: string): Promise<void> {
    // If the URL matches a trusted prefix, skip further checks (explicit bypass for
    // internal/test hosts). An EMPTY prefix list is NOT "allow all" — it means only
    // public HTTPS non-private hosts are permitted (default-deny via SSRF guard).
    if (cfg.allowedPaymentPrefixes.some(prefix => url.startsWith(prefix))) return;
    await assertPublicHttpsUrl(url);
  }

  function buildInit(input: PayInput): RequestInit {
    const headers = new Headers(input.headers ?? {});
    if (
      cfg.facilitatorUrl &&
      cfg.facilitatorApiKey &&
      !headers.has("authorization") &&
      sameOrigin(input.url, cfg.facilitatorUrl)
    ) {
      headers.set("authorization", `Bearer ${cfg.facilitatorApiKey}`);
    }
    const init: RequestInit = { method: input.method, headers };
    if (input.body && input.method === "POST") {
      init.body = input.body;
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    return init;
  }

  async function chargeFee(network: string): Promise<FeeReceipt> {
    if (network.startsWith("stellar:")) {
      return chargeStellarFee({ config: cfg.stellar, secretKey: stellarSecret, feeUsdc: cfg.feeUsdc });
    }
    if (network.startsWith("eip155:") && cfg.evm && evmRail) {
      return evmRail.chargeFee(cfg.feeUsdc);
    }
    if (network.startsWith("solana:") && cfg.solana) {
      return chargeSolanaFee({ config: cfg.solana, feeUsdc: cfg.feeUsdc });
    }
    throw new Error(`No fee rail for network: ${network}`);
  }

  async function pay(input: PayInput): Promise<PayResult> {
    await assertUrlAllowed(input.url);

    // OAuth caller without a linked wallet: never pay a Stellar resource from the
    // custodial MCP wallet. Probe the resource; if it requires a Stellar payment,
    // surface a structured `no_wallet_linked` error so the caller links a wallet.
    if (noWalletLinked) {
      const q = await quote(input);
      if (q.paymentRequired && (q.chain === null || q.chain.startsWith("stellar:"))) {
        return {
          url: input.url,
          method: input.method,
          status: 402,
          ok: false,
          paymentMade: false,
          chain: q.chain,
          paymentReceipt: null,
          feeReceipt: null,
          feeError: "no_wallet_linked",
          response: {
            error: "no_wallet_linked",
            message:
              "No wallet is linked to your account. Connect a Verivyx wallet in the dashboard to pay from your own smart account.",
          },
        };
      }
    }

    const response = await fetchWithPayment(input.url, buildInit(input));
    const rawBody = await response.text();
    const parsedBody = tryParseBody(rawBody, response.headers.get("content-type"));

    let paymentReceipt: unknown = null;
    try {
      paymentReceipt = httpClient.getPaymentSettleResponse(h => response.headers.get(h));
    } catch {
      paymentReceipt = null;
    }

    const paymentMade = paymentReceipt !== null;
    const chain = networkOf(paymentReceipt);
    let feeReceipt: FeeReceipt | null = null;
    let feeError: string | null = null;

    if (paymentMade && response.ok) {
      if (isNonCustodial) {
        // Charge the Verivyx service fee from the caller's smart account to the fee
        // treasury, authorized by the session key, gas-sponsored by the MCP wallet.
        // A fee submit error is recorded but does NOT fail the pay — the resource was
        // already paid and served. Mirror the custodial try/catch below.
        const feeAtomic = decimalToBaseUnits(cfg.feeUsdc, cfg.stellar.usdcDecimals).toString();
        try {
          feeReceipt = await chargeStellarFeeNonCustodial({
            smartAccountId: opts!.nonCustodial!.smartAccountId,
            sessionSecret: opts!.nonCustodial!.sessionSecret,
            feeTreasury: cfg.stellar.feeTreasury,
            usdcContract: cfg.stellar.usdcContract,
            feeAtomic,
            feeUsdc: cfg.feeUsdc,
            networkPassphrase: STELLAR_NETWORK_TO_PASSPHRASE.get(cfg.stellar.network) ?? "Test SDF Network ; September 2015",
            rpcUrl: cfg.stellar.rpcUrl ?? "https://soroban-testnet.stellar.org",
            network: cfg.stellar.network,
            sponsorSecret: cfg.stellarSecretKey,
          });
        } catch (error) {
          feeError = error instanceof Error ? error.message : "non-custodial fee charge failed";
          logger.error({ url: input.url, err: feeError }, "non-custodial service fee charge failed");
        }
      } else if (!chain) {
        feeError = "could not determine settlement network; service fee not charged";
        logger.warn({ url: input.url }, feeError);
      } else {
        try {
          feeReceipt = await chargeFee(chain);
        } catch (error) {
          feeError = error instanceof Error ? error.message : "fee charge failed";
          logger.error({ url: input.url, chain, err: feeError }, "service fee charge failed");
        }
      }
    }

    return {
      url: input.url,
      method: input.method,
      status: response.status,
      ok: response.ok,
      paymentMade,
      chain,
      paymentReceipt,
      feeReceipt,
      feeError,
      response: parsedBody,
    };
  }

  async function quote(input: PayInput): Promise<QuoteResult> {
    await assertUrlAllowed(input.url);
    const response = await fetch(input.url, buildInit(input));
    const rawBody = await response.text();
    const parsedBody = tryParseBody(rawBody, response.headers.get("content-type"));

    if (response.status !== 402) {
      return {
        url: input.url,
        paymentRequired: false,
        chain: null,
        asset: null,
        resourceAmount: null,
        serviceFee: cfg.feeUsdc,
        totalEstimate: null,
        payTo: null,
        raw: parsedBody,
      };
    }

    const accepts = extractAccepts(parsedBody, response.headers.get("payment-required"));
    const entry = accepts.find(a => canPay(a.network)) ?? accepts[0] ?? null;
    const resourceAmount = entry
      ? atomsToDecimalString(entry.amount, decimalsForNetwork(entry.network))
      : null;
    const totalEstimate = resourceAmount !== null ? addDecimalStrings(resourceAmount, cfg.feeUsdc) : null;

    return {
      url: input.url,
      paymentRequired: true,
      chain: entry?.network ?? null,
      asset: entry?.asset ?? null,
      resourceAmount,
      serviceFee: cfg.feeUsdc,
      totalEstimate,
      payTo: entry?.payTo ?? null,
      raw: accepts.length > 0 ? accepts : parsedBody,
    };
  }

  function info(): Record<string, unknown> {
    return {
      serviceFee: cfg.feeUsdc,
      stellar: stellarInfo(cfg.stellar, stellarRail.address, cfg.feeUsdc),
      evm: cfg.evm
        ? {
            chain: cfg.evm.caip2,
            address: evmRail?.address ?? null,
            asset: { code: "USDC", contract: cfg.evm.usdc },
            rpcUrl: cfg.evm.rpcUrl,
            serviceFee: cfg.feeUsdc,
            feeTreasury: cfg.evm.feeTreasury,
            testnet: cfg.evm.isTestnet,
          }
        : null,
      solana: cfg.solana && solanaRail ? solanaInfo(cfg.solana, solanaRail.address, cfg.feeUsdc) : null,
    };
  }

  function supportedChains(): unknown[] {
    const chains: unknown[] = [
      {
        chain: cfg.stellar.network,
        kind: "stellar",
        enabled: true,
        asset: "USDC",
        walletAddress: stellarRail.address,
        serviceFee: cfg.feeUsdc,
        testnet: cfg.stellar.isTestnet,
      },
    ];
    if (cfg.evm && evmRail) {
      chains.push({
        chain: cfg.evm.caip2,
        kind: "evm",
        enabled: true,
        asset: "USDC",
        walletAddress: evmRail.address,
        serviceFee: cfg.feeUsdc,
        testnet: cfg.evm.isTestnet,
      });
    }
    if (cfg.solana && solanaRail) {
      chains.push({
        chain: cfg.solana.caip2,
        kind: "solana",
        enabled: true,
        asset: "USDC",
        walletAddress: solanaRail.address,
        serviceFee: cfg.feeUsdc,
        testnet: cfg.solana.isTestnet,
      });
    }
    for (const c of cfg.plannedChains) {
      chains.push({ kind: c.kind, enabled: false, plannedPhase: c.plannedPhase });
    }
    return chains;
  }

  return { pay, quote, info, supportedChains };
}

function sameOrigin(requestUrl: string, baseUrl: string): boolean {
  try {
    return new URL(requestUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}
