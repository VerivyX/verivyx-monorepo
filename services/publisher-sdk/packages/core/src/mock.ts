/**
 * verivyx.mock() — a zero-network test helper.
 *
 * Returns a `Verivyx` instance whose backend client and classifier are stubbed
 * so `protect()` can be unit-tested without any network access. Callers can
 * override:
 *   - `classification`  — force the visitor classification (skips `classify`).
 *   - `authorize`       — the stubbed `client.authorize` result.
 *   - `authorizeThrows` — make `authorize` throw `BackendUnreachableError`
 *                         (to exercise the failMode path).
 *   - `requirements`    — the stubbed `client.requirements` result.
 *   - `match` / `failMode` / `domain` / `token` — config overrides.
 *   - `verifyWebBotAuth` / `verifyCrawlerDns` — classifier dep overrides
 *                         (only consulted when `classification` is not forced).
 */

import { resolveConfig } from "./config.js";
import type { Classification, ClassifyDeps } from "./detect.js";
import type { GateDecision } from "./decision.js";
import type { AuthorizeResult } from "./client.js";
import { BackendUnreachableError } from "./errors.js";
import { makeVerivyx } from "./index.js";
import type { Verivyx, EngineClient } from "./index.js";

export interface MockOverrides {
  /** Force the visitor classification (bypasses the real `classify`). */
  classification?: Classification;
  /** Stubbed `client.authorize` result. Defaults to `{ authorized: false }`. */
  authorize?: AuthorizeResult;
  /** When true, `client.authorize` throws BackendUnreachableError. */
  authorizeThrows?: boolean;
  /** Stubbed `client.requirements` result. */
  requirements?: { body: object; header: string };
  /** When true, `client.requirements` throws BackendUnreachableError. */
  requirementsThrows?: boolean;

  // --- config overrides ---
  match?: string[];
  failMode?: "teaser" | "open" | "closed";
  domain?: string;
  token?: string;
  /** Observe every gate decision (forwarded to cfg.onDecision). */
  onDecision?: (d: GateDecision) => void;

  // --- classifier dep overrides (only used when classification is unset) ---
  verifyWebBotAuth?: (req: Request) => Promise<boolean>;
  verifyCrawlerDns?: (ip: string, ua: string) => Promise<boolean>;
}

const DEFAULT_REQUIREMENTS = {
  body: {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        amount: "0.01",
        payTo: "GMOCK",
        maxTimeoutSeconds: 300,
      },
    ],
  },
  header: "bW9jaw==",
};

/**
 * Build a `Verivyx` instance backed by stubs — no network calls. See
 * {@link MockOverrides} for the knobs.
 */
export function mock(overrides: MockOverrides = {}): Verivyx {
  const cfg = resolveConfig(
    {
      domain: overrides.domain ?? "mock.example.com",
      token: overrides.token ?? "mock-token",
      ...(overrides.match !== undefined ? { match: overrides.match } : {}),
      ...(overrides.failMode !== undefined ? { failMode: overrides.failMode } : {}),
      ...(overrides.onDecision !== undefined ? { onDecision: overrides.onDecision } : {}),
    },
    {},
  );

  const client: EngineClient = {
    async authorize() {
      if (overrides.authorizeThrows) {
        throw new BackendUnreachableError("mock: backend unreachable (authorize)");
      }
      return overrides.authorize ?? { authorized: false };
    },
    async requirements() {
      if (overrides.requirementsThrows) {
        throw new BackendUnreachableError("mock: backend unreachable (requirements)");
      }
      return overrides.requirements ?? DEFAULT_REQUIREMENTS;
    },
  };

  // Classifier deps — only consulted when `classification` is NOT forced.
  const classifyDeps: ClassifyDeps = {
    verifyWebBotAuth: overrides.verifyWebBotAuth ?? (async () => false),
    ...(overrides.verifyCrawlerDns
      ? { verifyCrawlerDns: overrides.verifyCrawlerDns }
      : {}),
  };

  const classifyFn =
    overrides.classification !== undefined
      ? async () => overrides.classification as Classification
      : undefined;

  return makeVerivyx({
    cfg,
    client,
    classifyDeps,
    ...(classifyFn ? { classifyFn } : {}),
  });
}
