// Public API surface for @verivyx/paywall

// Shared types
export type { Logger, Price, PaymentRequirement, PowChallenge } from "./types.js";

// Config
export { resolveConfig, ConfigError } from "./config.js";
export type { VerivyxOptions, ResolvedConfig } from "./config.js";

// Decision model (GateDecision and GateReason exported from here)
export { makeDecision, applyFailMode } from "./decision.js";
export type { GateDecision, GateReason, PreviewBuilders } from "./decision.js";

// Error taxonomy
export { PaywallError, SettlementFailedError, HydrationFailedError, BackendUnreachableError } from "./errors.js";

// Visitor classifier
export { classify } from "./detect.js";
export type { Classification, ClassifyDeps, ClassifyResult } from "./detect.js";
