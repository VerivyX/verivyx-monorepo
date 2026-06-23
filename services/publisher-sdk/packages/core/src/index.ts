// Public API surface for @verivyx/paywall

// Shared types
export type { Logger, GateDecision, Price } from "./types.js";

// Config
export { resolveConfig, ConfigError } from "./config.js";
export type { VerivyxOptions, ResolvedConfig } from "./config.js";
