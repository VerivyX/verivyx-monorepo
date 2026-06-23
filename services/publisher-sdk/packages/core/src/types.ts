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
 * Minimal placeholder for the gate decision type.
 * Expanded in Task 7 (decision.ts) with full reason codes and metadata.
 */
export interface GateDecision {
  // expanded in Task 7
  allowed: boolean;
  reason: string;
}

/** Price specification — either a shorthand string or a structured object. */
export type Price =
  | string
  | { amount: string; asset: string; network: string };
