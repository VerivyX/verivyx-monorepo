import { SettleValidationError } from './idempotency';

/**
 * Parse the comma-separated ALLOWED_PAYWALL_CONTRACTS env value into a
 * trimmed, non-empty Set. Undefined or empty string → empty Set (fail-closed).
 */
export function parseAllowedPaywallContracts(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw.split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  );
}

/**
 * Assert that pc is present and in the allowlist.
 * Throws SettleValidationError (→ HTTP 400) if not — fail-closed.
 * Called only on the fee-sponsored Soroban distribute path.
 */
export function assertPaywallContractAllowed(pc: string | undefined, allowed: Set<string>): void {
  if (!pc) {
    throw new SettleValidationError('paywallContract is required for fee-sponsored Soroban settlement');
  }
  if (allowed.size === 0) {
    throw new SettleValidationError('ALLOWED_PAYWALL_CONTRACTS is not configured — fee-sponsored settlement rejected');
  }
  if (!allowed.has(pc)) {
    throw new SettleValidationError(`paywallContract ${pc} is not in the allowlist`);
  }
}

/**
 * Map an arbitrary thrown error to a stable {status, reason} for the HTTP response.
 * Timeout (message ends with '_timeout') → {status:503, reason:'settlement_timeout'}.
 * Everything else → {status:500, reason:'settlement_failed'}.
 *
 * SettleValidationError (intentional 400s) is NOT handled here — the caller must
 * check instanceof SettleValidationError before calling this.
 */
export function toStableError(err: unknown): { status: number; reason: string } {
  if (err instanceof Error && err.message.endsWith('_timeout')) {
    return { status: 503, reason: 'settlement_timeout' };
  }
  return { status: 500, reason: 'settlement_failed' };
}
