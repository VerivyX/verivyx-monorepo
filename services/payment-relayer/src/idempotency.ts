import { createHash } from 'crypto';

// sha256 hex of the signed transaction XDR — the server-derived dedupe key
export function payloadHash(transactionXdr: string): string {
  return createHash('sha256').update(transactionXdr).digest('hex');
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CompletedEntry = { result: unknown; expiresAt: number };

const completedCache = new Map<string, CompletedEntry>();
const inFlight = new Map<string, Promise<unknown>>();

// Coalesce + cache.
// - If a completed result for `key` exists within TTL → return it without calling fn.
// - If a call for `key` is in flight → return the same promise (fn runs once).
// - Otherwise: run fn(), cache its resolved value on success; on rejection do NOT cache.
export function settleOnce<T>(key: string, fn: () => Promise<T>, ttlMs: number = DEFAULT_TTL_MS): Promise<T> {
  // Check completed cache
  const cached = completedCache.get(key);
  if (cached) {
    if (Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.result as T);
    }
    completedCache.delete(key);
  }

  // Check in-flight
  const existing = inFlight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  // Start new call
  const promise: Promise<T> = fn().then(
    (result) => {
      completedCache.set(key, { result, expiresAt: Date.now() + ttlMs });
      inFlight.delete(key);
      return result;
    },
    (err) => {
      inFlight.delete(key);
      throw err;
    }
  );

  inFlight.set(key, promise as Promise<unknown>);
  return promise;
}

// Test-only reset hook so unit tests start with a clean slate.
export function _resetIdempotency(): void {
  completedCache.clear();
  inFlight.clear();
}
