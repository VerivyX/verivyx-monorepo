/**
 * RSL 1.0 + AIPREF discovery emitters.
 *
 * Zero dependencies, no node:* imports — edge-portable.
 *
 * Outputs:
 *   - `contentUsageHeader`  → AIPREF `Content-Usage` structured-field value
 *   - `rslLinkHeader`       → RFC 8288 `Link` header value (rel="license" [+ rel="payment"])
 *   - `rslLinkTag`          → HTML `<link rel="license" href="...">` (href HTML-escaped)
 *   - `rslRobotsBlock`      → robots.txt `License:` + `Content-Usage:` block
 */

export interface DiscoveryOptions {
  /** Absolute URL to the RSL license file/feed. */
  licenseUrl: string;
  /** AIPREF train-ai token; default "n". */
  trainAi?: "y" | "n";
  /** AIPREF search token; default "y". */
  search?: "y" | "n";
  /** Optional x402 requirements endpoint to advertise as rel="payment". */
  paymentUrl?: string;
}

/**
 * Guard against CR/LF injection in URLs that are embedded in header or
 * robots-block contexts. A newline in a URL would allow injecting extra
 * HTTP header fields or robots.txt directives.
 *
 * Throws a descriptive error so the publisher can fix their config.
 */
function assertSingleLine(url: string, field: string): void {
  if (/[\r\n]/.test(url)) {
    throw new Error(
      `discovery URL must be a single-line absolute URL (field: ${field})`
    );
  }
}

/**
 * Minimal HTML attribute escaper — used only for the `href` inside `rslLinkTag`.
 * The Link HEADER uses angle-brackets as RFC 8288 delimiters and must NOT be
 * HTML-escaped; the escaping is therefore intentionally restricted to the tag.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * AIPREF `Content-Usage` structured-field dictionary value.
 * e.g. `train-ai=n, search=y`
 */
export function contentUsageHeader(o: DiscoveryOptions): string {
  return `train-ai=${o.trainAi ?? "n"}, search=${o.search ?? "y"}`;
}

/**
 * RFC 8288 `Link` header value advertising the RSL license URL.
 * Appends a `rel="payment"` entry when `paymentUrl` is set.
 * e.g. `<https://example.com/license.xml>; rel="license"`
 */
export function rslLinkHeader(o: DiscoveryOptions): string {
  assertSingleLine(o.licenseUrl, "licenseUrl");
  if (o.paymentUrl) assertSingleLine(o.paymentUrl, "paymentUrl");
  let v = `<${o.licenseUrl}>; rel="license"`;
  if (o.paymentUrl) {
    v += `, <${o.paymentUrl}>; rel="payment"`;
  }
  return v;
}

/**
 * HTML `<link>` tag advertising the RSL license.
 * The `href` attribute value is HTML-escaped to be safe in any HTML context.
 * e.g. `<link rel="license" href="https://example.com/license.xml">`
 */
export function rslLinkTag(o: DiscoveryOptions): string {
  assertSingleLine(o.licenseUrl, "licenseUrl");
  return `<link rel="license" href="${esc(o.licenseUrl)}">`;
}

/**
 * robots.txt block combining the RSL `License:` directive and AIPREF
 * `Content-Usage:` directive.
 * e.g.:
 *   License: https://example.com/license.xml
 *   Content-Usage: train-ai=n, search=y
 */
export function rslRobotsBlock(o: DiscoveryOptions): string {
  assertSingleLine(o.licenseUrl, "licenseUrl");
  return `License: ${o.licenseUrl}\nContent-Usage: ${contentUsageHeader(o)}`;
}
