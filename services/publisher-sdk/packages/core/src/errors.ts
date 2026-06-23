/**
 * Error taxonomy for @verivyx/paywall.
 *
 * All domain-specific errors extend PaywallError so callers can catch at
 * the coarse level (`catch (e) { if (e instanceof PaywallError) ... }`) or
 * at the fine level. BackendUnreachableError extends PaywallError too —
 * "unreachable backend" is a paywall-domain concern, not a generic system
 * error, so one catch-all is cleaner than two independent hierarchies.
 *
 * Each constructor calls Object.setPrototypeOf to restore the prototype chain
 * in environments that downlevel ES class syntax (e.g. tsc → ES5 targets),
 * matching the pattern used by ConfigError in config.ts.
 *
 * ConfigError is intentionally left in config.ts; it is re-exported from
 * index.ts alongside this module's exports.
 */

export class PaywallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaywallError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an on-chain settlement attempt fails (e.g. rejected tx,
 * timeout waiting for confirmation, or invalid proof).
 */
export class SettlementFailedError extends PaywallError {
  constructor(message: string) {
    super(message);
    this.name = "SettlementFailedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the hydration service (content fetch) fails and the SDK
 * cannot assemble a gated response.
 */
export class HydrationFailedError extends PaywallError {
  constructor(message: string) {
    super(message);
    this.name = "HydrationFailedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the upstream Verivyx API is unreachable within the configured
 * timeoutMs window. Extends PaywallError because an unreachable backend is a
 * paywall-domain concern — callers can handle it via `instanceof PaywallError`
 * or specifically via `instanceof BackendUnreachableError`.
 */
export class BackendUnreachableError extends PaywallError {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnreachableError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
