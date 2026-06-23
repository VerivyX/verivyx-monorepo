// Public API surface for @verivyx/paywall

// Shared types
export type { Logger, Price, PaymentRequirement, PowChallenge } from "./types.js";

// x402 v2 wire helpers
export { buildPaymentRequired, readPaymentHeader } from "./x402.js";
export type { PaymentRequiredBody, ResourceInfo } from "./x402.js";

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

// Web Bot Auth verifier (RFC 9421 Ed25519)
export { verifyWebBotAuth } from "./webbotauth.js";
export type { VerifyWebBotAuthDeps } from "./webbotauth.js";

// SEO preview + anti-cloaking JSON-LD builders
export { buildPaywallJsonLd, buildPreviewHtml } from "./preview.js";

// Verivyx backend client (authorize / requirements)
export { VerivyxClient } from "./client.js";
export type { AuthorizeInput, AuthorizeResult, RequirementsResult, ClientDeps } from "./client.js";
