/**
 * Web Bot Auth verifier — RFC 9421 HTTP Message Signatures, Ed25519.
 *
 * Verifies that an incoming request carries a valid Web Bot Auth signature
 * (draft-meunier-web-bot-auth-architecture / -http-message-signatures-directory).
 * A valid signature cryptographically identifies a "good" agent (Anthropic /
 * OpenAI / Perplexity / Common Crawl, etc.) → the SDK routes it to the x402 pay
 * path instead of running heuristics.
 *
 * Design goals:
 *   - Zero runtime dependencies. WebCrypto `crypto.subtle` ONLY (Ed25519), so it
 *     runs unchanged on Node 18+, Cloudflare Workers, and Vercel Edge.
 *   - NEVER throws. Any malformed / missing / expired / unverifiable input
 *     resolves to `false`. `classify()` calls this; a throw would break the gate.
 *
 * What is enforced (fail-closed on identity):
 *   - `Signature` and `Signature-Input` headers present and parseable
 *     (RFC 8941 structured fields).
 *   - Required signature params: `tag="web-bot-auth"`, `created`, `expires`,
 *     `keyid`. (`nonce` is optional; `alg`, if present, must be Ed25519.)
 *   - Freshness: `created` not in the future beyond a small skew; `expires` not
 *     in the past; window (`expires - created`) ≤ 24h.
 *   - Covered components MUST include `@authority` AND `@target-uri` (target
 *     binding — stricter than the draft's `@authority`-only minimum, prevents a
 *     signature captured for one URL being replayed against another path/host).
 *   - `keyid` resolves to a directory JWK whose RFC 7638 (RFC 8037 A.3 for OKP)
 *     base64url SHA-256 thumbprint equals `keyid`.
 *   - Ed25519 signature verifies over the RFC 9421 §2.5 signature base
 *     reconstructed from the covered component identifiers.
 *
 * @see RFC 9421 §2 (signature base), §2.2 (derived components), §2.5
 * @see RFC 8941 (structured fields), RFC 7638 (JWK thumbprint), RFC 8037 (OKP)
 * @see draft-meunier-web-bot-auth-architecture, ...-http-message-signatures-directory
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface VerifyWebBotAuthDeps {
  /**
   * Resolve the signing directory's JWKS for a given Signature-Agent origin.
   * Injected in tests for determinism; the default fetches
   * `/.well-known/http-message-signatures-directory` from the agent host.
   */
  fetchDirectory?: (signatureAgent: string) => Promise<JsonWebKey[]>;
  /** Clock injection (seconds since epoch). Defaults to Date.now()/1000. */
  now?: () => number;
}

/** Max allowed signature validity window (24h) per the web-bot-auth draft. */
const MAX_WINDOW_SECONDS = 24 * 60 * 60;
/** Allowed clock skew for a `created` timestamp slightly in the future. */
const CLOCK_SKEW_SECONDS = 60;
/** JWKS cache TTL (≤ 24h per the directory draft). */
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — well under 24h.

/**
 * Verify an RFC 9421 Web Bot Auth signature on a request.
 * Returns `true` only if every check passes; `false` on anything else.
 * NEVER throws.
 */
export async function verifyWebBotAuth(
  req: Request,
  deps: VerifyWebBotAuthDeps = {},
): Promise<boolean> {
  try {
    const nowSec = deps.now ? deps.now() : Math.floor(Date.now() / 1000);

    const sigInputRaw = req.headers.get("signature-input");
    const sigRaw = req.headers.get("signature");
    if (!sigInputRaw || !sigRaw) return false;

    const inputs = parseSignatureInput(sigInputRaw);
    const sigs = parseSignatureHeader(sigRaw);
    if (!inputs || !sigs) return false;

    // Use the first label that has a matching Signature value. There may be
    // multiple labels; we accept the request if ANY one verifies fully.
    for (const [label, spec] of inputs) {
      const sigBytes = sigs.get(label);
      if (!sigBytes) continue;
      if (await verifyOne(req, spec, sigBytes, nowSec, deps)) return true;
    }
    return false;
  } catch {
    // Defensive: the contract is "never throw".
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parsed-spec shape
// ---------------------------------------------------------------------------

interface ParamMap {
  created?: number;
  expires?: number;
  keyid?: string;
  tag?: string;
  alg?: string;
  nonce?: string;
}

interface SigSpec {
  /** Covered component identifiers in order (e.g. "@authority"). */
  components: string[];
  /** Raw parameter segment as it appears after the inner list, for base rebuild. */
  paramSegment: string;
  params: ParamMap;
}

// ---------------------------------------------------------------------------
// Per-label verification
// ---------------------------------------------------------------------------

async function verifyOne(
  req: Request,
  spec: SigSpec,
  sigBytes: Uint8Array,
  nowSec: number,
  deps: VerifyWebBotAuthDeps,
): Promise<boolean> {
  const { params, components } = spec;

  // --- Required params -----------------------------------------------------
  if (params.tag !== "web-bot-auth") return false;
  if (typeof params.created !== "number") return false;
  if (typeof params.expires !== "number") return false;
  if (!params.keyid) return false;
  if (params.alg && params.alg.toLowerCase() !== "ed25519") return false;

  // --- Freshness -----------------------------------------------------------
  if (params.created > nowSec + CLOCK_SKEW_SECONDS) return false; // future
  if (params.expires < nowSec) return false; // expired
  if (params.expires < params.created) return false; // inverted window
  if (params.expires - params.created > MAX_WINDOW_SECONDS) return false; // > 24h

  // --- Required coverage (target binding) ----------------------------------
  if (!components.includes("@authority")) return false;
  if (!components.includes("@target-uri")) return false;

  // --- Resolve the signing key ---------------------------------------------
  const signatureAgent = readSignatureAgent(req);
  const jwk = await resolveKey(params.keyid, signatureAgent, deps);
  if (!jwk) return false;

  // --- Reconstruct the RFC 9421 signature base -----------------------------
  const base = buildSignatureBase(req, spec);
  if (base === null) return false;

  // --- Ed25519 verify ------------------------------------------------------
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    return false;
  }

  try {
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      // Copy into a fresh ArrayBuffer to satisfy BufferSource typing.
      sigBytes.slice().buffer,
      new TextEncoder().encode(base),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// RFC 9421 §2.5 signature base reconstruction
// ---------------------------------------------------------------------------

/**
 * Build the signature base from covered components + the original param segment.
 * Returns null if any covered component cannot be resolved from the request.
 */
function buildSignatureBase(req: Request, spec: SigSpec): string | null {
  const url = new URL(req.url);
  const lines: string[] = [];

  for (const comp of spec.components) {
    // We only support the derived components needed by web-bot-auth. Any
    // unknown / unsupported component → cannot reconstruct → reject.
    if (comp === "@authority") {
      // RFC 9421 §2.2.3: authority, normalized (lowercase host, no default port).
      lines.push(`"@authority": ${url.host.toLowerCase()}`);
    } else if (comp === "@target-uri") {
      // RFC 9421 §2.2.2: full target URI.
      lines.push(`"@target-uri": ${url.href}`);
    } else if (comp === "signature-agent") {
      const v = req.headers.get("signature-agent");
      if (v === null) return null;
      lines.push(`"signature-agent": ${v.trim()}`);
    } else {
      return null;
    }
  }

  lines.push(`"@signature-params": (${innerList(spec.components)})${spec.paramSegment}`);
  return lines.join("\n");
}

function innerList(components: string[]): string {
  return components.map((c) => `"${c}"`).join(" ");
}

// ---------------------------------------------------------------------------
// Key resolution: keyid → directory JWK by RFC 7638 thumbprint, with cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  jwk: JsonWebKey;
  expiresAt: number;
}

/** Module-level JWKS cache keyed by thumbprint (keyid). Injectable bypass: */
/* tests always pass deps.fetchDirectory and unique keys, so the cache never */
/* returns a stale match across cases. */
const jwksCache = new Map<string, CacheEntry>();

async function resolveKey(
  keyid: string,
  signatureAgent: string | null,
  deps: VerifyWebBotAuthDeps,
): Promise<JsonWebKey | null> {
  const now = Date.now();
  const cached = jwksCache.get(keyid);
  if (cached && cached.expiresAt > now) return cached.jwk;

  let jwks: JsonWebKey[];
  try {
    jwks = deps.fetchDirectory
      ? await deps.fetchDirectory(signatureAgent ?? "")
      : await defaultFetchDirectory(signatureAgent);
  } catch {
    return null;
  }
  if (!Array.isArray(jwks)) return null;

  for (const jwk of jwks) {
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) continue;
    let thumb: string;
    try {
      thumb = await jwkThumbprint(jwk);
    } catch {
      continue;
    }
    if (thumb === keyid) {
      jwksCache.set(keyid, { jwk, expiresAt: now + JWKS_CACHE_TTL_MS });
      return jwk;
    }
  }
  return null;
}

/**
 * Default directory fetch:
 *   GET {signature-agent origin}/.well-known/http-message-signatures-directory
 * Accepts either a bare JWKS array, `{keys:[...]}`, or `{jwks:{keys:[...]}}`.
 */
async function defaultFetchDirectory(
  signatureAgent: string | null,
): Promise<JsonWebKey[]> {
  if (!signatureAgent) return [];
  // signatureAgent is a structured-field string like "https://host"; strip quotes.
  const origin = signatureAgent.replace(/^"|"$/g, "").trim();
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return [];
  }
  const dirUrl = new URL(
    "/.well-known/http-message-signatures-directory",
    base,
  ).href;
  const res = await fetch(dirUrl, {
    headers: { accept: "application/http-message-signatures-directory+json" },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as unknown;
  if (Array.isArray(body)) return body as JsonWebKey[];
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.keys)) return obj.keys as JsonWebKey[];
    const j = obj.jwks as Record<string, unknown> | undefined;
    if (j && Array.isArray(j.keys)) return j.keys as JsonWebKey[];
  }
  return [];
}

/**
 * RFC 7638 JWK SHA-256 thumbprint, base64url (no padding).
 * For OKP (Ed25519) the canonical member set/order is {crv, kty, x}
 * (RFC 8037 Appendix A.3), each a JSON string, lexicographically by name.
 */
async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = `{"crv":${jsonStr(jwk.crv)},"kty":${jsonStr(
    jwk.kty,
  )},"x":${jsonStr(jwk.x)}}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

function jsonStr(v: unknown): string {
  return JSON.stringify(String(v ?? ""));
}

function readSignatureAgent(req: Request): string | null {
  return req.headers.get("signature-agent");
}

// ---------------------------------------------------------------------------
// RFC 8941 structured-fields parsing (minimal, scoped to what we need)
// ---------------------------------------------------------------------------

/**
 * Parse a `Signature-Input` value: a Dictionary of label → Inner List with
 * parameters. e.g.
 *   sig1=("@authority" "@target-uri");created=1;keyid="x";tag="web-bot-auth"
 * Returns a Map<label, SigSpec>, or null if structurally invalid.
 */
function parseSignatureInput(raw: string): Map<string, SigSpec> | null {
  const out = new Map<string, SigSpec>();
  // Split top-level dictionary members on commas that are NOT inside quotes
  // or parentheses.
  const members = splitTopLevel(raw, ",");
  if (members.length === 0) return null;

  for (const memberRaw of members) {
    const member = memberRaw.trim();
    if (!member) continue;
    const eq = member.indexOf("=");
    if (eq < 0) return null;
    const label = member.slice(0, eq).trim();
    const value = member.slice(eq + 1).trim();
    if (!isToken(label)) return null;
    if (!value.startsWith("(")) return null;

    const close = value.indexOf(")");
    if (close < 0) return null;
    const innerRaw = value.slice(1, close).trim();
    const paramSegment = value.slice(close + 1); // includes leading ';'

    const components = parseInnerList(innerRaw);
    if (components === null) return null;

    const params = parseParams(paramSegment);
    if (params === null) return null;

    out.set(label, { components, paramSegment, params });
  }
  return out.size > 0 ? out : null;
}

/** Parse an inner list body like: "@authority" "@target-uri" → ['@authority',...] */
function parseInnerList(inner: string): string[] | null {
  if (inner === "") return [];
  const items: string[] = [];
  const parts = splitTopLevel(inner, " ");
  for (const p of parts) {
    const t = p.trim();
    if (t === "") continue;
    // Each item is a quoted string (possibly with its own params, which
    // web-bot-auth does not use for these components).
    const m = /^"([^"]*)"/.exec(t);
    if (!m) return null;
    items.push(m[1]!);
  }
  return items;
}

/**
 * Parse a parameter segment like `;created=1;keyid="x";tag="web-bot-auth"`.
 * Returns a ParamMap, or null on malformed structure.
 */
function parseParams(segment: string): ParamMap | null {
  const params: ParamMap = {};
  const trimmed = segment.trim();
  if (trimmed === "") return params;
  if (!trimmed.startsWith(";")) return null;

  const parts = splitTopLevel(trimmed.slice(1), ";");
  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq < 0) return null; // all params we care about are key=value
    const key = part.slice(0, eq).trim();
    const valRaw = part.slice(eq + 1).trim();
    if (!isToken(key)) return null;

    if (valRaw.startsWith('"')) {
      // String value.
      if (!valRaw.endsWith('"') || valRaw.length < 2) return null;
      const str = valRaw.slice(1, -1);
      assignStringParam(params, key, str);
    } else {
      // Integer (created/expires) or token (alg without quotes).
      if (/^-?\d+$/.test(valRaw)) {
        const n = Number(valRaw);
        if (!Number.isFinite(n)) return null;
        assignNumberParam(params, key, n);
      } else {
        assignStringParam(params, key, valRaw);
      }
    }
  }
  return params;
}

function assignStringParam(p: ParamMap, key: string, val: string): void {
  if (key === "keyid") p.keyid = val;
  else if (key === "tag") p.tag = val;
  else if (key === "alg") p.alg = val;
  else if (key === "nonce") p.nonce = val;
  // created/expires must be integers; a string there is ignored (stays
  // undefined → required-param check fails).
}

function assignNumberParam(p: ParamMap, key: string, val: number): void {
  if (key === "created") p.created = val;
  else if (key === "expires") p.expires = val;
}

/**
 * Parse a `Signature` value: Dictionary of label → Byte Sequence (`:b64:`).
 * Returns Map<label, Uint8Array>, or null if invalid.
 */
function parseSignatureHeader(raw: string): Map<string, Uint8Array> | null {
  const out = new Map<string, Uint8Array>();
  const members = splitTopLevel(raw, ",");
  for (const memberRaw of members) {
    const member = memberRaw.trim();
    if (!member) continue;
    const eq = member.indexOf("=");
    if (eq < 0) return null;
    const label = member.slice(0, eq).trim();
    const value = member.slice(eq + 1).trim();
    if (!isToken(label)) return null;
    // Byte sequence: :base64:
    if (!value.startsWith(":") || !value.endsWith(":") || value.length < 2) {
      return null;
    }
    const b64 = value.slice(1, -1);
    const bytes = base64Decode(b64);
    if (bytes === null) return null;
    out.set(label, bytes);
  }
  return out.size > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/** Split on `sep` at top level (ignoring quoted strings and parentheses). */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuote) {
      cur += ch;
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      cur += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
      continue;
    }
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (inQuote) return []; // unterminated quote → malformed
  out.push(cur);
  return out;
}

/** RFC 8941 token: starts with alpha or '*', then token chars. */
function isToken(s: string): boolean {
  return /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*$/.test(s);
}

/** Decode standard or base64url, with or without padding. Returns null on error. */
function base64Decode(input: string): Uint8Array | null {
  try {
    let s = input.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4;
    if (pad === 2) s += "==";
    else if (pad === 3) s += "=";
    else if (pad === 1) return null;
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
