/**
 * Search-crawler IP-range verifier — zero dependencies, edge-portable.
 *
 * Verifies that a request claiming to be Googlebot or Bingbot actually
 * originates from an IP address in the officially published JSON IP-range lists.
 * Uses `fetch` + pure-TS IP-in-CIDR arithmetic (IPv4 and IPv6). No `node:dns`,
 * no DOM — runs unchanged on Cloudflare Workers, Vercel Edge, and Node 18+.
 *
 * Fail-closed: any fetch/parse error resolves to `false` and the failure is NOT
 * cached, so the next call will retry the network.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CrawlerVerifierDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Default: 86_400_000 ms (24 h) */
  cacheTtlMs?: number;
  /** Default: https://developers.google.com/search/apis/ipranges/googlebot.json */
  googlebotUrl?: string;
  /** Default: https://www.bing.com/toolbox/bingbot.json */
  bingbotUrl?: string;
}

// ---------------------------------------------------------------------------
// ipInCidr — IPv4 and IPv6, no exceptions
// ---------------------------------------------------------------------------

/**
 * Return `true` when `ip` falls inside `cidr`.
 * Supports both IPv4 (`1.2.3.4/24`) and IPv6 (`2001:db8::/32`).
 * Embedded IPv4-in-IPv6 addresses (`::ffff:1.2.3.4`) are out of scope —
 * `false` is returned for those.
 * Returns `false` on any parse error; never throws.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  try {
    const slash = cidr.lastIndexOf("/");
    if (slash < 0) return false;
    const cidrAddr = cidr.slice(0, slash);
    const prefixLen = parseInt(cidr.slice(slash + 1), 10);
    if (!Number.isFinite(prefixLen) || prefixLen < 0) return false;

    // Route by address family.
    if (ip.includes(":") || cidrAddr.includes(":")) {
      // IPv6 path.
      if (prefixLen > 128) return false;
      const ipBig = parseIPv6(ip);
      const cidrBig = parseIPv6(cidrAddr);
      if (ipBig === null || cidrBig === null) return false;

      if (prefixLen === 0) return true;
      const shift = BigInt(128 - prefixLen);
      return (ipBig >> shift) === (cidrBig >> shift);
    } else {
      // IPv4 path.
      if (prefixLen > 32) return false;
      const ipInt = parseIPv4(ip);
      const cidrInt = parseIPv4(cidrAddr);
      if (ipInt === null || cidrInt === null) return false;

      if (prefixLen === 0) return true;
      const shift = 32 - prefixLen;
      return (ipInt >>> shift) === (cidrInt >>> shift);
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// IPv4 parser
// ---------------------------------------------------------------------------

/** Parse a dotted-decimal IPv4 address to an unsigned 32-bit integer, or null. */
function parseIPv4(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (part === "" || part.length > 3) return null;
    const n = parseInt(part, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255 || String(n) !== part) return null;
    result = (result * 256 + n) >>> 0;
  }
  return result;
}

// ---------------------------------------------------------------------------
// IPv6 parser — handles :: compression
// ---------------------------------------------------------------------------

/**
 * Parse an IPv6 address string to a 128-bit `BigInt`, or `null` on error.
 * Handles `::` shorthand at the start, middle, or end.
 * Does NOT handle embedded IPv4 notation (`::ffff:1.2.3.4`).
 */
function parseIPv6(addr: string): bigint | null {
  // Reject embedded IPv4 addresses (contains a dot in the hex segment area).
  if (addr.includes(".")) return null;

  const halves = addr.split("::");
  if (halves.length > 2) return null; // more than one "::" → invalid

  if (halves.length === 2) {
    // Has "::" compression.
    const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
    const right = halves[1] === "" ? [] : (halves[1] ?? "").split(":");
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null; // "::" must expand at least one group
    const groups = [
      ...left,
      ...Array<string>(missing).fill("0"),
      ...right,
    ];
    return groupsToBigInt(groups);
  } else {
    // No "::" — must be exactly 8 groups.
    const groups = addr.split(":");
    if (groups.length !== 8) return null;
    return groupsToBigInt(groups);
  }
}

/** Convert an array of exactly 8 hex group strings to a 128-bit BigInt, or null. */
function groupsToBigInt(groups: string[]): bigint | null {
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const g of groups) {
    if (g === "" || g.length > 4) return null;
    const n = parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    result = (result << 16n) | BigInt(n);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Range list cache (per-verifier instance)
// ---------------------------------------------------------------------------

interface CacheEntry {
  cidrs: string[];
  fetchedAt: number;
}

/**
 * Shape of both Google's and Bing's published IP-range JSON.
 * `ipv4Prefix` and `ipv6Prefix` are mutually exclusive per entry.
 */
interface IpRangeJson {
  prefixes: Array<{ ipv4Prefix?: string; ipv6Prefix?: string }>;
}

/**
 * Load and cache a provider's CIDR list from a per-instance cache map.
 * Returns an empty array (fail-closed, no cache on error) if the fetch or
 * parse fails — the caller returns `false` in that case.
 */
async function loadRanges(
  url: string,
  cache: Map<string, CacheEntry>,
  fetchFn: typeof fetch,
  now: () => number,
  cacheTtlMs: number,
): Promise<string[]> {
  const cached = cache.get(url);
  if (cached !== undefined && now() - cached.fetchedAt <= cacheTtlMs) {
    return cached.cidrs;
  }

  let res: Response;
  try {
    res = await fetchFn(url);
  } catch {
    // Network error — fail closed, no cache.
    return [];
  }

  if (!res.ok) return [];

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }

  // Parse the JSON into a flat CIDR list.
  const typed = body as IpRangeJson;
  if (!typed || !Array.isArray(typed.prefixes)) return [];

  const cidrs: string[] = [];
  for (const entry of typed.prefixes) {
    if (typeof entry.ipv4Prefix === "string") cidrs.push(entry.ipv4Prefix);
    else if (typeof entry.ipv6Prefix === "string") cidrs.push(entry.ipv6Prefix);
  }

  // Cache the successful result.
  cache.set(url, { cidrs, fetchedAt: now() });
  return cidrs;
}

/** Return `true` if `ip` matches any CIDR in the list. */
function anyMatch(ip: string, cidrs: string[]): boolean {
  return cidrs.some((c) => ipInCidr(ip, c));
}

// ---------------------------------------------------------------------------
// createSearchCrawlerVerifier
// ---------------------------------------------------------------------------

const DEFAULT_GOOGLEBOT_URL =
  "https://developers.google.com/search/apis/ipranges/googlebot.json";
const DEFAULT_BINGBOT_URL = "https://www.bing.com/toolbox/bingbot.json";
const DEFAULT_CACHE_TTL_MS = 86_400_000; // 24 h

/**
 * Create a search-crawler IP verifier.
 *
 * The returned function `(ip, ua) => Promise<boolean>`:
 *   - Lower-cases `ua`.
 *   - If `ua` contains `"googlebot"` → fetches/caches Google's IP ranges and
 *     checks `ip` against them.
 *   - If `ua` contains `"bingbot"` → same for Bing.
 *   - Otherwise → returns `false` immediately (no fetch).
 *
 * The range JSON is cached per-instance, per-URL for `cacheTtlMs` milliseconds
 * (default 24 h). Each call to `createSearchCrawlerVerifier` gets its own cache,
 * preventing cross-instance or cross-test contamination.
 * Fail-closed: any fetch or parse error → `false`, failure not cached.
 */
export function createSearchCrawlerVerifier(
  deps?: CrawlerVerifierDeps,
): (ip: string, ua: string) => Promise<boolean> {
  const fetchFn = deps?.fetch ?? fetch;
  const now = deps?.now ?? Date.now;
  const cacheTtlMs = deps?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const googlebotUrl = deps?.googlebotUrl ?? DEFAULT_GOOGLEBOT_URL;
  const bingbotUrl = deps?.bingbotUrl ?? DEFAULT_BINGBOT_URL;

  // Instance-local cache — isolates each verifier from others.
  const cache = new Map<string, CacheEntry>();

  return async (ip: string, ua: string): Promise<boolean> => {
    try {
      const lowerUa = ua.toLowerCase();

      if (lowerUa.includes("googlebot")) {
        const cidrs = await loadRanges(googlebotUrl, cache, fetchFn, now, cacheTtlMs);
        return anyMatch(ip, cidrs);
      }

      if (lowerUa.includes("bingbot")) {
        const cidrs = await loadRanges(bingbotUrl, cache, fetchFn, now, cacheTtlMs);
        return anyMatch(ip, cidrs);
      }

      return false;
    } catch {
      return false;
    }
  };
}
