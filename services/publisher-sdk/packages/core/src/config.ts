import type { Logger, GateDecision, Price } from "./types.js";

/** Options accepted by the SDK — all fields optional (resolved to defaults). */
export interface VerivyxOptions {
  domain?: string;
  token?: string;
  apiBase?: string;
  match?: string[];
  failMode?: "teaser" | "open" | "closed";
  price?: Price;
  timeoutMs?: number;
  logger?: Logger;
  telemetry?: boolean;
  onDecision?: (d: GateDecision) => void;
}

/** Fully-resolved config — no optional fields except price and onDecision. */
export interface ResolvedConfig {
  domain: string;
  token: string;
  apiBase: string;
  match: string[];
  failMode: "teaser" | "open" | "closed";
  price?: Price;
  timeoutMs: number;
  logger: Logger;
  telemetry: boolean;
  onDecision?: (d: GateDecision) => void;
}

/** Thrown when required config values (domain, token) cannot be resolved. */
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
  // --- domain ---
  const domain = (opts?.domain ?? env["VERIVYX_DOMAIN"] ?? "").trim();
  if (!domain) {
    throw new ConfigError(
      "VERIVYX_DOMAIN is required (set via opts.domain or VERIVYX_DOMAIN env var)",
    );
  }

  // --- token ---
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
    match = env["VERIVYX_MATCH"].split(",").map((s) => s.trim());
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

  // --- logger ---
  const logger: Logger = opts?.logger ?? consoleLogger;

  // --- telemetry ---
  const telemetry = opts?.telemetry ?? false;

  // --- price ---
  const price: Price | undefined = opts?.price;

  // --- onDecision ---
  const onDecision = opts?.onDecision;

  return {
    domain,
    token,
    apiBase,
    match,
    failMode,
    price,
    timeoutMs,
    logger,
    telemetry,
    onDecision,
  };
}
