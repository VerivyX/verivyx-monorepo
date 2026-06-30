import type { Logger, Price } from "./types.js";
import type { GateDecision } from "./decision.js";

/** Options accepted by the SDK — all fields optional (resolved to defaults). */
export interface VerivyxOptions {
  domain?: string;
  token?: string;
  apiBase?: string;
  match?: string[];
  failMode?: "teaser" | "open" | "closed";
  price?: Price;
  /** Timeout for the quick requirements/classify path (default 800 ms). */
  timeoutMs?: number;
  /**
   * Timeout for the authorize/settle path, which awaits an on-chain
   * transaction (default 60 000 ms). Kept separate so a paying agent is
   * not aborted mid-settle.
   */
  settleTimeoutMs?: number;
  logger?: Logger;
  onDecision?: (d: GateDecision) => void;
  /** Human-unlock options. Adapters use `buildUnlockHtml` with this config. */
  humanUnlock?: { authBase?: string };
}

/** Fully-resolved config — no optional fields except price and onDecision. */
export interface ResolvedConfig {
  /**
   * Optional legacy/analytics label. Empty string when not provided.
   * The SDK is now token-only; `token` alone identifies the tenant.
   */
  domain: string;
  token: string;
  apiBase: string;
  match: string[];
  failMode: "teaser" | "open" | "closed";
  price?: Price;
  /** Timeout for the quick requirements/classify path (ms). */
  timeoutMs: number;
  /** Timeout for the authorize/settle path that awaits on-chain confirmation (ms). */
  settleTimeoutMs: number;
  logger: Logger;
  onDecision?: (d: GateDecision) => void;
}

/** Thrown when required config values (token) cannot be resolved. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
    // Restore prototype chain in environments that downlevel class syntax
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A silent console-backed logger used when the caller supplies none. */
const consoleLogger: Logger = {
  debug: (...args) => console.debug("[verivyx]", ...args),
  info: (...args) => console.info("[verivyx]", ...args),
  warn: (...args) => console.warn("[verivyx]", ...args),
  error: (...args) => console.error("[verivyx]", ...args),
};

const VALID_FAIL_MODES = new Set(["teaser", "open", "closed"]);

/**
 * Resolve SDK configuration.
 *
 * Precedence (highest → lowest): code arg > env > default.
 *
 * @param opts  - Caller-supplied options object.
 * @param env   - Environment variable map (defaults to `process.env`).
 *               Accept an explicit map so the function is testable without
 *               mutating the real process environment.
 */
export function resolveConfig(
  opts?: VerivyxOptions,
  env: Record<string, string | undefined> = {},
): ResolvedConfig {
  // --- domain (optional: legacy/analytics label; token alone identifies the
  //     tenant). Resolved when provided, defaults to "" when absent. ---
  const domain = (opts?.domain ?? env["VERIVYX_DOMAIN"] ?? "").trim();

  // --- token (required) ---
  const token = (opts?.token ?? env["VERIVYX_TOKEN"] ?? "").trim();
  if (!token) {
    throw new ConfigError(
      "VERIVYX_TOKEN is required (set via opts.token or VERIVYX_TOKEN env var)",
    );
  }

  // --- apiBase ---
  const apiBase =
    opts?.apiBase ?? env["VERIVYX_API_BASE"] ?? "https://api.verivyx.com";

  // --- match ---
  let match: string[];
  if (opts?.match !== undefined) {
    match = opts.match;
  } else if (env["VERIVYX_MATCH"]) {
    match = env["VERIVYX_MATCH"].split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    match = [];
  }

  // --- failMode ---
  const rawFailMode =
    opts?.failMode ?? env["VERIVYX_FAIL_MODE"] ?? "teaser";
  if (!VALID_FAIL_MODES.has(rawFailMode)) {
    throw new ConfigError(
      `Invalid failMode "${rawFailMode}". Must be one of: teaser, open, closed`,
    );
  }
  const failMode = rawFailMode as "teaser" | "open" | "closed";

  // --- timeoutMs ---
  let timeoutMs: number;
  if (opts?.timeoutMs !== undefined) {
    timeoutMs = opts.timeoutMs;
  } else if (env["VERIVYX_TIMEOUT_MS"] !== undefined) {
    const parsed = parseInt(env["VERIVYX_TIMEOUT_MS"], 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ConfigError(
        `VERIVYX_TIMEOUT_MS must be a positive integer, got "${env["VERIVYX_TIMEOUT_MS"]}"`,
      );
    }
    timeoutMs = parsed;
  } else {
    timeoutMs = 800;
  }

  // --- settleTimeoutMs ---
  // Separate, longer timeout for the authorize/settle path (awaits on-chain tx).
  // Default 60 000 ms; keeps a paying agent from being aborted mid-settle.
  let settleTimeoutMs: number;
  if (opts?.settleTimeoutMs !== undefined) {
    settleTimeoutMs = opts.settleTimeoutMs;
  } else if (env["VERIVYX_SETTLE_TIMEOUT_MS"] !== undefined) {
    const parsed = parseInt(env["VERIVYX_SETTLE_TIMEOUT_MS"], 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ConfigError(
        `VERIVYX_SETTLE_TIMEOUT_MS must be a positive integer, got "${env["VERIVYX_SETTLE_TIMEOUT_MS"]}"`,
      );
    }
    settleTimeoutMs = parsed;
  } else {
    settleTimeoutMs = 60_000;
  }

  // --- logger ---
  const logger: Logger = opts?.logger ?? consoleLogger;

  // --- price ---
  // --- onDecision ---
  // Omit optional keys entirely when undefined so exactOptionalPropertyTypes
  // is satisfied (ResolvedConfig uses `price?:` not `price?: X | undefined`).
  const base = {
    domain,
    token,
    apiBase,
    match,
    failMode,
    timeoutMs,
    settleTimeoutMs,
    logger,
  };
  return {
    ...base,
    ...(opts?.price !== undefined ? { price: opts.price } : {}),
    ...(opts?.onDecision !== undefined ? { onDecision: opts.onDecision } : {}),
  };
}
