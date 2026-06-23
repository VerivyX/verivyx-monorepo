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
 * Full x402 v2 payment requirement shape (implemented in Task 11).
 * Re-exported from src/x402.ts where it is defined alongside the wire helpers.
 * Field names mirror services/agent-sdk/src/types.ts exactly for wire compatibility.
 */
export type { PaymentRequirement } from "./x402.js";

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
