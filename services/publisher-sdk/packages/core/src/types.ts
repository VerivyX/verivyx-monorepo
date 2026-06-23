/**
 * Shared public types for @verivyx/paywall.
 * Forward-placeholder types for tasks not yet implemented are noted inline.
 */

/** Structured logger interface — zero-dependency, mirrors console shape. */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Minimal placeholder for the x402 payment requirement shape.
 * Expanded in Task 11 (x402 emitter) with full wire-format fields.
 */
export interface PaymentRequirement {
  // expanded in Task 11
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

/**
 * Minimal placeholder for the proof-of-work challenge shape.
 * Expanded in a later task when the PoW challenge/verify path is implemented.
 */
export interface PowChallenge {
  // expanded in later task
  difficulty: number;
  nonce: string;
}

/** Price specification — either a shorthand string or a structured object. */
export type Price =
  | string
  | { amount: string; asset: string; network: string };
