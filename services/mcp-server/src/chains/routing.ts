/**
 * Pure routing decision for selecting the per-request Stellar payment mode.
 *
 * Factored out of index.ts so every branch is unit-testable without HTTP mocks.
 * This decides ONLY the mode; index.ts performs the (impure) binding lookup and
 * service construction based on the chosen mode.
 *
 * Modes:
 *   - "noncustodial"    : OAuth caller with a linked wallet → pay from THEIR smart
 *                         account via the delegated session key (standard x402).
 *   - "no_wallet_linked": OAuth caller without a binding → must connect a wallet.
 *                         Never falls back to the MCP custodial wallet.
 *   - "session_override": Static-key caller supplying x-session-stellar-secret →
 *                         existing playground per-session wallet (UNCHANGED).
 *   - "custodial"       : Static-key caller, no override → the live custodial MCP wallet.
 */

export type McpUser =
  | { kind: "oauth"; sub: string }
  | { kind: "key"; label: string }
  | undefined;

export type StellarPaymentMode =
  | "noncustodial"
  | "no_wallet_linked"
  | "session_override"
  | "custodial";

/**
 * Chooses the Stellar payment mode for a request.
 *
 * @param mcpUser - The authenticated caller (oauth | key | undefined).
 * @param hasBinding - Whether an OAuth caller has a wallet binding (only meaningful for oauth).
 * @param hasSessionSecretHeader - Whether x-session-stellar-secret is present (playground override).
 */
export function chooseStellarPaymentMode(
  mcpUser: McpUser,
  hasBinding: boolean,
  hasSessionSecretHeader: boolean,
): StellarPaymentMode {
  // OAuth callers are non-custodial-only: pay from their own wallet, or be told to
  // link one. The session-secret playground override never applies to them.
  if (mcpUser?.kind === "oauth") {
    return hasBinding ? "noncustodial" : "no_wallet_linked";
  }

  // Static-key (and defensive undefined) callers keep the legacy behavior:
  // playground per-session override when present, else the custodial MCP wallet.
  if (hasSessionSecretHeader) return "session_override";
  return "custodial";
}
