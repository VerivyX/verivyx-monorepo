/**
 * Pure delegation-params helpers.
 *
 * Converts a human-readable USDC budget + duration into the atomic values
 * required for a non-custodial Soroban delegation:
 *   - budgetAtomic  : spending_limit in stroops (10^-7 USDC)
 *   - expiryLedger  : valid_until ledger number
 *
 * Rules:
 *  - NO floating-point arithmetic for money: all conversion via string
 *    parsing + BigInt.
 *  - NO I/O, NO network calls, NO Stellar SDK calls.
 */

/** Stellar USDC uses 7 decimal places (1 USDC = 10_000_000 atomic units). */
export const USDC_DECIMALS = 7 as const;

/**
 * Approximate ledger rate: ~5 seconds per ledger.
 * 86_400 s/day ÷ 5 s/ledger = 17_280 ledgers/day.
 */
export const LEDGERS_PER_DAY = 17_280 as const;

// ── toAtomicUsdc ──────────────────────────────────────────────────────────────

/**
 * Parse a human-readable USDC decimal string to its atomic (stroop) bigint.
 *
 * Accepts: "1", "1.5", "0.001", "0.0000001"
 * Rejects: "", "-1", "abc", "1.2.3", "1.12345678" (> 7 dp), "0"
 *
 * Uses pure string-split + BigInt — never Number() for money.
 */
export function toAtomicUsdc(amount: string): bigint {
  const trimmed = amount.trim();

  if (trimmed === '') {
    throw new Error('Invalid USDC amount: empty string');
  }

  // Reject negatives up-front (before the regex, so the message is clear).
  if (trimmed.startsWith('-')) {
    throw new Error('Invalid USDC amount: negative value not allowed');
  }

  // Must be digits, at most one dot, optional fractional part.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid USDC amount: "${trimmed}" is not a valid decimal`);
  }

  const dotIndex = trimmed.indexOf('.');
  let whole: string;
  let frac: string;

  if (dotIndex === -1) {
    whole = trimmed;
    frac = '';
  } else {
    whole = trimmed.slice(0, dotIndex);
    frac = trimmed.slice(dotIndex + 1);
  }

  // Multiple dots are already caught by the regex; guard anyway.
  if (frac.includes('.')) {
    throw new Error(`Invalid USDC amount: multiple decimal points in "${trimmed}"`);
  }

  if (frac.length > USDC_DECIMALS) {
    throw new Error(
      `Invalid USDC amount: too many decimal places (${frac.length}); ` +
        `max is ${USDC_DECIMALS}`,
    );
  }

  // Pad fractional part to exactly USDC_DECIMALS digits.
  const fracPadded = frac.padEnd(USDC_DECIMALS, '0');

  // Combine: e.g. "1" + "5000000" → 15_000_000n
  const atomic = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded);

  if (atomic === 0n) {
    throw new Error('Invalid USDC amount: must be greater than zero');
  }

  return atomic;
}

// ── expiryToLedger ────────────────────────────────────────────────────────────

/**
 * Compute the expiry ledger for a delegation of `days` days starting from
 * `currentLedger`.
 *
 * Formula: currentLedger + ceil(days × 86_400 / 5)
 *          = currentLedger + ceil(days × LEDGERS_PER_DAY)
 *
 * Fractional days are rounded up (ceil) so the delegation never expires
 * earlier than requested.
 *
 * @param days          - Duration in days (positive, may be fractional)
 * @param currentLedger - Current ledger sequence number (non-negative integer)
 */
export function expiryToLedger(days: number, currentLedger: number): number {
  if (typeof days !== 'number' || Number.isNaN(days) || days <= 0) {
    throw new Error(
      `Invalid days: must be a positive number, got ${days}`,
    );
  }

  const ledgersToAdd = Math.ceil(days * LEDGERS_PER_DAY);
  return currentLedger + ledgersToAdd;
}

// ── validateDelegation ────────────────────────────────────────────────────────

export interface DelegationInput {
  /** Human-readable USDC amount string, e.g. "1.5" */
  budgetUsdc: string;
  /** Duration in days (positive) */
  days: number;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate delegation parameters before constructing any on-chain transaction.
 *
 * Returns `{ ok: true }` or `{ ok: false; error: string }`.
 * Never throws — all errors are captured as structured results.
 */
export function validateDelegation(input: DelegationInput): ValidationResult {
  // Validate days first (cheap).
  if (typeof input.days !== 'number' || Number.isNaN(input.days) || input.days <= 0) {
    return {
      ok: false,
      error: `days must be a positive number (got ${input.days})`,
    };
  }

  // Validate budget via toAtomicUsdc (catches zero, negative, non-numeric, etc.).
  try {
    toAtomicUsdc(input.budgetUsdc);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true };
}
