/**
 * Settlement error mapper — maps raw Soroban/RPC simulation error strings and diagnostic
 * events to stable, agent-friendly error codes for non-custodial payment failures.
 *
 * Pure and dependency-free so it is trivially unit-testable.
 *
 * --------------------------------------------------------------------------
 * Exact substrings / codes keyed (case-insensitive, substring match):
 *
 * INSUFFICIENT_BALANCE — checked FIRST (before delegation codes):
 *   "balanceerror"      SAC HostError BalanceError (Soroban balance shortfall)
 *   "insufficient"      generic "insufficient balance/funds" phrasing
 *   "balance"           any balance-related error string
 *   "allowance"         SEP-41 allowance shortfall
 *
 * DELEGATION_BUDGET_EXHAUSTED — #3002/InvalidAction + policy diagnostic present:
 *   "#3002" or "invalidaction" (auth failure code/name) in the combined haystack
 *   AND any of: "spending_limit", "can_enforce", "spendinglimit" in the haystack
 *   (presence of the policy's can_enforce call → the policy was consulted → budget cap hit)
 *
 * DELEGATION_EXPIRED — #3002/InvalidAction WITHOUT a policy diagnostic:
 *   "#3002", "invalidaction", or "unvalidatedcontext" in message
 *   (rule skipped → expired/revoked/destination-mismatch; actionable signal: re-link delegation)
 *   NOTE: this intentionally also covers revoked rules and destination-mismatch cases —
 *   the agent-actionable signal in all these cases is "your delegation is not valid, re-link".
 *
 * SETTLEMENT_FAILED — catch-all for anything unrecognised.
 *
 * --------------------------------------------------------------------------
 * Diagnostic availability note (Stellar SDK v14):
 *   rpc.Api.SimulateTransactionErrorResponse has an `events: xdr.DiagnosticEvent[]` field
 *   on ALL simulation responses (including errors). The events are XDR objects. To pass them
 *   to this mapper, the caller must convert them to strings (e.g. via JSON.stringify or
 *   toXDR("hex")). The `buildDelegatedInvocation` simulate-error path captures these as
 *   string[] when available (see sessionPayment.ts). If conversion fails or events are absent,
 *   the mapper degrades gracefully: #3002 without policy diagnostic → delegation_expired
 *   (the safe "re-link your delegation" signal for both budget and expiry when the diagnostic
 *   cannot be distinguished).
 *
 * Future on-chain refinement: if the diagnostic event XDR can be fully decoded, the policy
 * can_enforce fn_return=false can be matched more precisely. Until then, the string approach
 * (policy contract address fragment, "can_enforce", "spending_limit" substrings) covers all
 * practical cases since the Soroban diagnostic event log stringifies the fn name.
 * --------------------------------------------------------------------------
 */

export type SettlementErrorCode =
  | "delegation_budget_exhausted"
  | "delegation_expired"
  | "insufficient_balance"
  | "settlement_failed";

export interface SettlementErrorInput {
  /** Raw error message from simulation or transaction submission. */
  message?: string;
  /**
   * Simulation diagnostic events as strings (XDR hex, JSON, or the raw
   * DiagnosticEvent.toString() representation). May be a string array or a
   * single concatenated string. Best-effort: undefined/empty is handled.
   */
  diagnostics?: string[] | string;
}

/** Normalise diagnostics to a single lowercase string for substring matching. */
function normaliseDiagnostics(diagnostics: string[] | string | undefined): string {
  if (!diagnostics) return "";
  if (Array.isArray(diagnostics)) return diagnostics.join(" ").toLowerCase();
  return String(diagnostics).toLowerCase();
}

export function mapSettlementError(input: SettlementErrorInput): SettlementErrorCode {
  const msg = (input.message ?? "").toLowerCase();
  const diag = normaliseDiagnostics(input.diagnostics);

  // Build combined haystack (message + diagnostics) for multi-field matches.
  const haystack = `${msg} ${diag}`.trimEnd();

  // ---- 1. INSUFFICIENT_BALANCE — checked FIRST ----------------------------------------
  // SEP-41 balance/allowance shortfalls are distinct from delegation auth failures.
  // A message that contains balance-related keywords wins over any #3002 check.
  if (
    haystack.includes("balanceerror") ||
    haystack.includes("insufficient") ||
    haystack.includes("balance") ||
    haystack.includes("allowance")
  ) {
    return "insufficient_balance";
  }

  // ---- 2. DELEGATION AUTH failure (#3002 / InvalidAction / UnvalidatedContext) ----------
  const isAuthFailure =
    haystack.includes("#3002") ||
    haystack.includes("invalidaction") ||
    haystack.includes("unvalidatedcontext");

  if (isAuthFailure) {
    // 2a. If policy diagnostics are present → budget cap hit.
    const hasPolicyDiag =
      haystack.includes("spending_limit") ||
      haystack.includes("spendinglimit") ||
      haystack.includes("can_enforce");

    if (hasPolicyDiag) {
      return "delegation_budget_exhausted";
    }

    // 2b. No policy diagnostic → rule expired/revoked/not matched.
    return "delegation_expired";
  }

  // ---- 3. CATCH-ALL --------------------------------------------------------------------
  return "settlement_failed";
}
