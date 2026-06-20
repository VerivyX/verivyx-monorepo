import { SettleValidationError } from './idempotency';

/**
 * Shared parser for comma-separated contract/adapter allowlist env values.
 * Returns a trimmed, non-empty Set. Undefined or empty string → empty Set (fail-closed).
 */
function parseAllowedContracts(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw.split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
  );
}

/**
 * Parse the comma-separated ALLOWED_PAYWALL_CONTRACTS env value into a
 * trimmed, non-empty Set. Undefined or empty string → empty Set (fail-closed).
 */
export function parseAllowedPaywallContracts(raw: string | undefined): Set<string> {
  return parseAllowedContracts(raw);
}

/**
 * Parse the comma-separated ALLOWED_PAY_ADAPTERS env value into a
 * trimmed, non-empty Set. Undefined or empty string → empty Set (fail-closed).
 */
export function parseAllowedPayAdapters(raw: string | undefined): Set<string> {
  return parseAllowedContracts(raw);
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
 * Assert that the adapter id is present and in the adapter allowlist.
 * Throws SettleValidationError (→ HTTP 400) if not — fail-closed.
 * Called only on the adapter (non-custodial) sponsor path.
 */
export function assertAdapterAllowed(adapterId: string | undefined, allowed: Set<string>): void {
  if (!adapterId) {
    throw new SettleValidationError('payAdapterId is required for adapter fee-sponsored settlement');
  }
  if (allowed.size === 0) {
    throw new SettleValidationError('ALLOWED_PAY_ADAPTERS is not configured — adapter settlement rejected');
  }
  if (!allowed.has(adapterId)) {
    throw new SettleValidationError(`payAdapter ${adapterId} is not in the allowlist`);
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
