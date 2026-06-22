/**
 * SSRF-safe URL guard for outbound payment fetches.
 *
 * Private-range list cross-referenced against the OWASP SSRF Prevention Cheat
 * Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
 * and RFC 5735 / RFC 4291.
 */
import dns from "node:dns";
import net from "node:net";

// ---------------------------------------------------------------------------
// IPv4 helpers
// ---------------------------------------------------------------------------

function ipv4ToNumber(ip: string): number {
  const parts = ip.split(".");
  return (
    ((Number(parts[0]) << 24) |
      (Number(parts[1]) << 16) |
      (Number(parts[2]) << 8) |
      Number(parts[3])) >>>
    0
  );
}

function inRange4(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const mask = bits === undefined ? 0xffffffff : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(base) & mask);
}

// Blocked IPv4 CIDRs — OWASP SSRF cheat sheet + RFC 5735
const BLOCKED_V4: string[] = [
  "0.0.0.0/8", // "This" network / unspecified
  "10.0.0.0/8", // RFC-1918 private
  "100.64.0.0/10", // Shared address space / CGNAT (RFC 6598)
  "127.0.0.0/8", // Loopback
  "169.254.0.0/16", // Link-local (cloud metadata: AWS 169.254.169.254, GCP, Azure)
  "172.16.0.0/12", // RFC-1918 private
  "192.0.0.0/24", // IETF Protocol Assignments
  "192.168.0.0/16", // RFC-1918 private
  "198.18.0.0/15", // Network benchmark testing
  "240.0.0.0/4", // Reserved (Class E)
];

function isBlockedV4(ip: string): boolean {
  return BLOCKED_V4.some(cidr => inRange4(ip, cidr));
}

// ---------------------------------------------------------------------------
// IPv6 helpers
// ---------------------------------------------------------------------------

/** Expand an IPv6 address to 8 × uint16 groups. */
function expandV6(ip: string): number[] {
  // Strip zone ID if present (e.g. "fe80::1%eth0")
  const addr = ip.split("%")[0];

  const halves = addr.split("::");
  if (halves.length > 2) return new Array<number>(8).fill(0); // malformed

  const parseGroups = (s: string): number[] =>
    s === "" ? [] : s.split(":").map(g => parseInt(g, 16));

  if (halves.length === 1) {
    const groups = parseGroups(halves[0]);
    // Handle IPv4-mapped :::ffff:a.b.c.d notation already expanded
    return groups.length === 8 ? groups : new Array<number>(8).fill(0);
  }

  const left = parseGroups(halves[0]);
  const right = parseGroups(halves[1]);
  const fill = 8 - left.length - right.length;
  return [...left, ...new Array<number>(fill).fill(0), ...right];
}

function isBlockedV6(ip: string): boolean {
  const groups = expandV6(ip);

  // ::1 — loopback
  if (groups.every((g, i) => (i < 7 ? g === 0 : g === 1))) return true;

  // :: — unspecified
  if (groups.every(g => g === 0)) return true;

  const g0 = groups[0];

  // fc00::/7 — Unique Local Address (ULA), covers fd00::/8 too
  if ((g0 & 0xfe00) === 0xfc00) return true;

  // fe80::/10 — link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;

  // ::ffff:0:0/96 — IPv4-mapped (::ffff:10.0.0.1, etc.)
  // Groups: [0,0,0,0,0,0xffff,hi16,lo16]
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    // Reconstruct IPv4 from the last two groups
    const hi = groups[6];
    const lo = groups[7];
    const mapped = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return isBlockedV4(mapped);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the IP address is in a private, loopback, link-local, or
 * otherwise non-routable range that must not be reached by outbound payments.
 *
 * Covers OWASP SSRF cheat-sheet ranges for both IPv4 and IPv6.
 *
 * Handles IPv4-mapped IPv6 literals with a dotted-quad tail (e.g.
 * `::ffff:10.0.0.1`): Node's `net.isIPv6` accepts these but `expandV6` would
 * call `parseInt("10.0.0.1", 16)` on the last segment and misread it.  We
 * detect the pattern here and delegate the tail to the IPv4 path instead.
 */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) {
    // Detect ::ffff:<dotted-quad> — e.g. "::ffff:10.0.0.1".
    // The dotted-quad portion after the last colon is a valid IPv4 string.
    const mappedMatch = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mappedMatch) return isBlockedV4(mappedMatch[1]);
    return isBlockedV6(ip);
  }
  // Unrecognised format — block by default
  return true;
}

/**
 * Default DNS resolver: returns all IP addresses for a hostname.
 * Injectable so tests can stub without real DNS.
 */
async function defaultResolve(host: string): Promise<string[]> {
  const results = await dns.promises.lookup(host, { all: true, family: 0 });
  return results.map(r => r.address);
}

/**
 * Assert that `url` is safe to fetch for outbound payments:
 *   1. Must use the https: scheme.
 *   2. After DNS resolution, every resolved IP must be a public address.
 *
 * @param url - The target URL string.
 * @param resolve - Injectable DNS resolver (defaults to dns.promises.lookup).
 * @throws Error if the URL fails either check.
 */
export async function assertPublicHttpsUrl(
  url: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SSRF guard: invalid URL: ${url}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`SSRF guard: only https is allowed; got ${parsed.protocol} in ${url}`);
  }

  const ips = await resolve(parsed.hostname);
  if (ips.length === 0) {
    throw new Error(`SSRF guard: could not resolve host: ${parsed.hostname}`);
  }

  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new Error(
        `SSRF guard: blocked private/reserved IP ${ip} for host ${parsed.hostname}`,
      );
    }
  }
}
