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
 * Convert a Stellar stroop value (integer string, 7 implied decimal places) to
 * a fixed-7-decimal Stellar amount string WITHOUT float math.
 *
 * Pure string/integer arithmetic: left-pads the digit string to ≥8 chars, then
 * inserts the decimal point 7 places from the right. The output shape is
 * byte-identical to the old `(Number(atomic) / 1e7).toFixed(7)` for all values
 * that fit in a JS safe integer, and is EXACT for values beyond Number.MAX_SAFE_INTEGER
 * where float division would round incorrectly.
 *
 * Examples:
 *   "0"       → "0.0000000"
 *   "50000"   → "0.0050000"
 *   "10000000"→ "1.0000000"
 */
export function atomicToStellar(atomic: string): string {
  const negative = atomic.startsWith('-');
  const digits = negative ? atomic.slice(1) : atomic;
  if (!/^\d+$/.test(digits)) {
    throw new Error(`Invalid atomic value: "${atomic}"`);
  }
  // Pad to at least 8 chars so there is always ≥1 integer digit + 7 fractional digits.
  const padded = digits.padStart(8, '0');
  const intRaw = padded.slice(0, padded.length - 7);
  // Strip leading zeros from integer part, keep at least one digit.
  const intPart = intRaw.replace(/^0+/, '') || '0';
  const fracPart = padded.slice(padded.length - 7);
  return (negative ? '-' : '') + intPart + '.' + fracPart;
}

/**
 * Resolve and validate the STELLAR_NETWORK env value at startup.
 * Accepts only "testnet" (default when unset), "public", or "mainnet".
 * Any other non-empty value throws immediately — fail-fast to prevent a
 * misconfigured relayer from accidentally operating on mainnet (real money).
 *
 * Returns the canonical two-value type used throughout the relayer:
 *   "testnet" | "public"
 */
export function resolveNetworkName(raw: string | undefined): 'testnet' | 'public' {
  // Default to testnet when the env var is unset (preserves existing behaviour).
  if (raw === undefined) return 'testnet';
  if (raw === 'testnet') return 'testnet';
  if (raw === 'public' || raw === 'mainnet') return 'public';
  throw new Error(
    `Invalid STELLAR_NETWORK="${raw}": must be "testnet" or "public"/"mainnet"`,
  );
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
