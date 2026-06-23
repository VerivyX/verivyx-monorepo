/**
 * Layered visitor classifier for @verivyx/paywall.
 *
 * Classifies each incoming HTTP Request into a single caller type.
 * Resolution order (first match wins):
 *   1. paid          — payment header present (x402 v2 or legacy)
 *   2. verified      — human session: vx_session cookie or Authorization: Bearer
 *   3. signed-agent  — Web Bot Auth signature valid (injected dep)
 *   4. ai-bot        — UA matches known AI/scraper list
 *   5. crawler       — UA matches search-crawler list AND DNS reverse-lookup passes
 *                      (spoofed Googlebot without verified DNS → ai-bot)
 *   6. human         — fallback (fail-open on is-human)
 *
 * All I/O (DNS lookup, Web Bot Auth) is injected via `deps` so classify() is
 * a pure function in tests — no network calls inside the module.
 *
 * NOTE: The adapter (Next.js edge / Hono / Express) is responsible for
 * populating X-Real-IP / X-Forwarded-For with a trustworthy IP value before
 * passing the Request to classify().
 */

import type { ResolvedConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Canonical classification returned by classify().
 *
 * "unknown" is reserved but not currently emitted — ambiguous browser traffic
 * defaults to "human" per the spec's fail-open-on-is-human policy.
 */
export type Classification =
  | "paid"
  | "verified"
  | "signed-agent"
  | "ai-bot"
  | "crawler"
  | "human"
  | "unknown";

export interface ClassifyDeps {
  /**
   * Verify an RFC 9421 Web Bot Auth signature.
   * Implemented in Task 9; injected here as a dependency.
   */
  verifyWebBotAuth: (req: Request) => Promise<boolean>;

  /**
   * Verify a search-crawler claim via DNS reverse lookup.
   * If absent, any search-crawler UA claim is treated as a spoof → ai-bot.
   * `ip` comes from X-Real-IP / X-Forwarded-For (adapter must be trusted).
   */
  verifyCrawlerDns?: (ip: string, ua: string) => Promise<boolean>;
}

export interface ClassifyResult {
  classification: Classification;
  /** Short tags explaining the decision — for telemetry / onDecision hook. */
  signals: string[];
}

// ---------------------------------------------------------------------------
// UA substring lists — ported from:
//   services/wordpress-plugin/verivyx-paywall/includes/class-detect.php
//   Verivyx_Detect::is_known_agent() (lines 18-27) — AI crawlers block.
//   Additional automation clients appended where absent in the PHP list.
// ---------------------------------------------------------------------------

/**
 * Substrings (lowercase) matching known AI crawlers, scraper bots, and
 * raw HTTP automation clients that must be routed to the pay path.
 *
 * Source: class-detect.php Verivyx_Detect::is_known_agent()
 *   AI crawlers: gptbot, oai-search, openai, perplexity, anthropic, claudebot,
 *     google-extended, googleother, bytespider, amazonbot, ccbot
 *   Headless/automation: headless, puppeteer, playwright, selenium, phantomjs
 *   Raw HTTP clients: python-requests, python-urllib, go-http-client, curl/,
 *     wget/, libwww-perl, scrapy, httpclient, apache-httpclient, node-fetch, axios
 */
const AI_BOT_NEEDLES: readonly string[] = [
  // AI crawlers / research agents (from class-detect.php)
  "gptbot",
  "oai-search",
  "openai",
  "perplexity",
  "anthropic",
  "claudebot",
  "google-extended",
  "googleother",
  "bytespider",
  "amazonbot",
  "ccbot",
  // headless / automation stacks (from class-detect.php)
  "headless",
  "puppeteer",
  "playwright",
  "selenium",
  "phantomjs",
  // raw HTTP clients (from class-detect.php)
  "python-requests",
  "python-urllib",
  "go-http-client",
  "curl/",
  "wget/",
  "libwww-perl",
  "scrapy",
  "httpclient",
  "apache-httpclient",
  "node-fetch",
  "axios",
];

/**
 * Substrings (lowercase) matching legitimate search-engine crawlers.
 * These get an SEO preview path ONLY when DNS reverse-lookup confirms
 * the request actually originates from the search engine's IP range.
 * Without DNS confirmation they are downgraded to ai-bot (spoof-defense).
 *
 * Mapped signal tag is used for the signals array and crawler DNS call.
 */
const CRAWLER_NEEDLES: readonly { needle: string; tag: string }[] = [
  { needle: "googlebot", tag: "googlebot" },
  { needle: "bingbot", tag: "bingbot" },
  { needle: "slurp", tag: "slurp" }, // Yahoo Slurp
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the client IP from request headers.
 * Preference: X-Real-IP (single trusted IP) → first value of X-Forwarded-For.
 * Returns empty string if neither is present.
 */
function extractIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();

  return "";
}

/**
 * Check whether the given User-Agent string matches any entry in a needle
 * list. Returns the matching needle/tag or null if no match.
 */
function matchUA(ua: string, needle: string): boolean {
  return ua.includes(needle);
}

// ---------------------------------------------------------------------------
// Public classifier
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP Request into a caller type.
 *
 * @param req  - The incoming HTTP Request (Fetch API).
 * @param cfg  - Resolved SDK configuration (for future logging / telemetry).
 * @param deps - Injected async dependencies (WebBotAuth verifier, DNS resolver).
 * @returns    Classification result with a signals array for diagnostics.
 */
export async function classify(
  req: Request,
  cfg: ResolvedConfig,
  deps: ClassifyDeps,
): Promise<ClassifyResult> {
  // --- 1. paid — payment header present (x402 v2 or legacy) ---------------
  // Actual signature verification / settlement happens later in the pipeline.
  // Presence of the header is sufficient to route to the paid path here.
  if (req.headers.get("PAYMENT-SIGNATURE")) {
    return {
      classification: "paid",
      signals: ["payment-header:PAYMENT-SIGNATURE"],
    };
  }
  if (req.headers.get("X-PAYMENT")) {
    return {
      classification: "paid",
      signals: ["payment-header:X-PAYMENT"],
    };
  }

  // --- 2. verified — human session present ----------------------------------
  // Presence only; JWT / session validation happens later.
  const cookie = req.headers.get("cookie") ?? "";
  if (cookie.includes("vx_session=")) {
    return {
      classification: "verified",
      signals: ["session:cookie"],
    };
  }
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return {
      classification: "verified",
      signals: ["session:bearer"],
    };
  }

  // --- 3. signed-agent — valid RFC 9421 Web Bot Auth signature --------------
  const isSigned = await deps.verifyWebBotAuth(req);
  if (isSigned) {
    return {
      classification: "signed-agent",
      signals: ["webbotauth:signed"],
    };
  }

  // Normalise UA for remaining checks
  const rawUA = req.headers.get("user-agent") ?? "";
  const ua = rawUA.toLowerCase();

  // --- 4/5. UA-based classification ----------------------------------------
  // Check search-crawler needles first so we can branch on DNS verification.
  for (const { needle, tag } of CRAWLER_NEEDLES) {
    if (matchUA(ua, needle)) {
      // Crawler UA claim detected — must verify via DNS to get SEO path.
      // If verifyCrawlerDns is absent or returns false → spoof → ai-bot.
      if (deps.verifyCrawlerDns) {
        const ip = extractIp(req);
        const dnsOk = await deps.verifyCrawlerDns(ip, rawUA);
        if (dnsOk) {
          return {
            classification: "crawler",
            signals: [`ua:${tag}`, "dns:verified"],
          };
        }
      }
      // DNS absent or failed — treat as adversarial bot
      return {
        classification: "ai-bot",
        signals: [`ua:${tag}`, "dns:unverified→ai-bot"],
      };
    }
  }

  // AI bot / scraper needle check (after crawler so Googlebot doesn't hit here)
  for (const needle of AI_BOT_NEEDLES) {
    if (matchUA(ua, needle)) {
      return {
        classification: "ai-bot",
        signals: [`ua:${needle}`],
      };
    }
  }

  // --- 6. human — default (fail-open on is-human) --------------------------
  return {
    classification: "human",
    signals: ["ua:human"],
  };
}
