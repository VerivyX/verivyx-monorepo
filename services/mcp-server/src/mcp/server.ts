import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getConfig } from "../config.js";
import type { PaymentService } from "../chains/payments.js";
import { logger } from "../logger.js";
import { mapSettlementError } from "../wallet/errorMap.js";

/**
 * Actionable hints keyed by the stable error code from mapSettlementError.
 * The real fix for delegation/balance failures is on the Agent Wallet page —
 * NOT re-authorizing the OAuth connector — so we spell that out for the agent.
 * `settlement_failed` (catch-all) has no hint on purpose.
 */
const ERROR_HINTS: Record<string, string> = {
  delegation_expired:
    "Your Verivyx wallet delegation has expired or run out of budget. Re-delegate on the Agent Wallet page (dashboard → Agent Wallet, or https://mcp.verivyx.com/mcp/wallet) — this is NOT an OAuth/connector issue.",
  delegation_budget_exhausted:
    "Your Verivyx wallet delegation has run out of budget. Re-delegate with a higher budget on the Agent Wallet page (dashboard → Agent Wallet, or https://mcp.verivyx.com/mcp/wallet) — this is NOT an OAuth/connector issue.",
  insufficient_balance:
    "Top up your agent smart account on the Agent Wallet page (dashboard → Agent Wallet).",
  no_wallet_linked:
    "No agent wallet is linked. Set one up on the Agent Wallet page (dashboard → Agent Wallet).",
};

const fetchInputShape = {
  url: z.string().url().describe("Full URL of the x402-protected resource to fetch"),
  method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method"),
  body: z.string().optional().describe("Optional raw body for POST requests"),
  headers: z.record(z.string()).optional().describe("Optional additional HTTP headers"),
};

function asText(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function asError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
  };
}

/**
 * Build a structured error payload for non-custodial payment failures.
 * Runs mapSettlementError to convert raw Soroban/RPC error strings and
 * simulation diagnostics into a stable agent-friendly code alongside the
 * human-readable message.
 *
 * Only called on the non-custodial path — custodial errors continue to use asError().
 */
function asNonCustodialError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Pull diagnostics attached by the simulate-error path in sessionPayment.ts (best-effort).
  const diagnostics = (error as { diagnostics?: string[] }).diagnostics;
  const code = mapSettlementError({ message, diagnostics });
  const hint = ERROR_HINTS[code];
  const payload = hint ? { error: message, code, hint } : { error: message, code };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** Build a fresh McpServer wired to the shared multi-chain payment service. */
export function buildMcpServer(payments: PaymentService, opts?: { isNonCustodial?: boolean }): McpServer {
  const isNonCustodial = opts?.isNonCustodial ?? false;
  const cfg = getConfig();
  const server = new McpServer({ name: "verivyx-x402-mcp", version: "0.1.0" });

  server.registerTool(
    "list_supported_chains",
    {
      title: "List supported chains",
      description: "List the chains/assets this Verivyx MCP can pay on, plus the flat service fee.",
      inputSchema: {},
      outputSchema: { serviceFee: z.string(), chains: z.array(z.any()) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const payload = { serviceFee: cfg.feeUsdc, chains: payments.supportedChains() };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    },
  );

  server.registerTool(
    "wallet_info",
    {
      title: "Wallet info",
      description: "Show the active paying wallet(s) and network configuration for each chain.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => asText(payments.info()),
  );

  server.registerTool(
    "quote_payment",
    {
      title: "Quote payment",
      description:
        "Preview the cost to fetch an x402 resource (resource price + Verivyx service fee) WITHOUT paying.",
      inputSchema: fetchInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, method, body, headers }) => {
      try {
        return asText(await payments.quote({ url, method, body, headers }));
      } catch (error) {
        logger.warn({ err: String(error) }, "quote_payment failed");
        return asError(error instanceof Error ? error.message : "quote failed");
      }
    },
  );

  server.registerTool(
    "pay_for_resource",
    {
      title: "Pay for resource",
      description:
        "Fetch an x402-protected URL and automatically pay the required micropayment (plus the flat Verivyx service fee). Auto-selects the chain the resource advertises. Returns the content and a payment receipt.",
      inputSchema: fetchInputShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, method, body, headers }) => {
      try {
        const result = await payments.pay({ url, method, body, headers });
        logger.info(
          { url, status: result.status, paymentMade: result.paymentMade, chain: result.chain },
          "pay_for_resource",
        );
        return asText(result);
      } catch (error) {
        logger.warn({ err: String(error), url }, "pay_for_resource failed");
        // Non-custodial path: map raw Soroban/RPC errors to stable agent-friendly codes.
        // Custodial path continues to use the plain error message.
        if (isNonCustodial) {
          return asNonCustodialError(error);
        }
        return asError(error instanceof Error ? error.message : "payment failed");
      }
    },
  );

  return server;
}
