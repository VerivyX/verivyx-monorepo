/**
 * SEO preview + anti-cloaking JSON-LD builders for @verivyx/paywall.
 *
 * `buildPaywallJsonLd` — emits Google paywalled-content structured data
 *   (NewsArticle shape) mirroring class-content-gate.php:build_paywall_jsonld.
 *   Declaring `isAccessibleForFree: false` + cssSelector `.vx-paywalled` tells
 *   Google that the visible portion is a legitimate preview, not cloaking.
 *   Ref: https://developers.google.com/search/docs/appearance/structured-data/paywalled-content
 *
 * `buildPreviewHtml` — wraps a teaser excerpt in a minimal HTML document,
 *   embedding the JSON-LD in a <script type="application/ld+json"> block.
 *   All caller-supplied text values are HTML-escaped before interpolation.
 *   The jsonLd string has `<` replaced with `<` to prevent `</script>`
 *   from breaking out of the script tag (standard JSON-LD-in-HTML hardening).
 */

// ---------------------------------------------------------------------------
// HTML escaping helper
// ---------------------------------------------------------------------------

/**
 * Escape the five HTML metacharacters so user-supplied strings are safe
 * inside HTML text content and attribute values.
 *
 * Order matters: `&` must be first to avoid double-escaping.
 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Harden a JSON string for embedding inside an HTML <script> tag.
 *
 * JSON.stringify already escapes the string value bytes; but the resulting
 * JSON *text* may contain the literal sequence `</script>` (e.g. as the
 * value `"<\/script>"` — which is valid JSON but closes the tag in HTML
 * parsers).  Replacing `<` with its Unicode escape `<` keeps the JSON
 * semantically identical (parsers decode it back to `<`) while preventing
 * any `</script>` sequence from appearing verbatim in the document.
 */
function hardenJsonLdForScript(json: string): string {
  // Replace bare < with its JSON Unicode escape.
  // This is the canonical approach used by frameworks like Next.js.
  return json.replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

/**
 * Build the Google paywalled-content JSON-LD for a NewsArticle.
 *
 * Shape mirrors class-content-gate.php:build_paywall_jsonld (lines 90-104):
 *   @context           https://schema.org
 *   @type              NewsArticle
 *   headline           ← title
 *   description        ← description
 *   url                ← url
 *   isAccessibleForFree false
 *   hasPart            WebPageElement { isAccessibleForFree: false, cssSelector: ".vx-paywalled" }
 *
 * Returns a compact JSON string (no pretty-print) that is already hardened
 * for embedding directly in a <script type="application/ld+json"> tag —
 * all `<` characters are Unicode-escaped to `<` so no `</script>`
 * sequence can appear verbatim in the output.
 */
export function buildPaywallJsonLd(p: {
  title: string;
  description: string;
  url: string;
}): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: p.title,
    description: p.description,
    url: p.url,
    isAccessibleForFree: false,
    hasPart: {
      "@type": "WebPageElement",
      isAccessibleForFree: false,
      cssSelector: ".vx-paywalled",
    },
  };
  return hardenJsonLdForScript(JSON.stringify(schema));
}

/**
 * Build a minimal preview HTML document for search crawlers and unverified
 * human visitors.
 *
 * - All interpolated text fields (`title`, `excerpt`, `url`) are HTML-escaped.
 * - The `jsonLd` argument (a JSON string from `buildPaywallJsonLd`) is placed
 *   verbatim inside the `<script type="application/ld+json">` block after
 *   `<` is Unicode-escaped to `<`, preventing `</script>` breakout.
 * - The function is pure (no DOM, no side-effects) and works in any JS
 *   runtime (Node.js, Edge, Workers).
 */
export function buildPreviewHtml(p: {
  title: string;
  excerpt: string;
  url: string;
  jsonLd: string;
}): string {
  const safeTitle = escapeHtml(p.title);
  const safeExcerpt = escapeHtml(p.excerpt);
  const safeUrl = escapeHtml(p.url);
  const safeJsonLd = hardenJsonLdForScript(p.jsonLd);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <link rel="canonical" href="${safeUrl}" />
  <script type="application/ld+json">${safeJsonLd}</script>
</head>
<body>
  <h1>${safeTitle}</h1>
  <p>${safeExcerpt}</p>
  <a href="${safeUrl}">${safeUrl}</a>
</body>
</html>`;
}

/**
 * Build an SEO preview `Response` (200 HTML + anti-cloaking JSON-LD) for a
 * crawler or unverified-human request.
 *
 * Shared by all three adapter packages (Express, Hono, Next) so the preview
 * HTML is generated identically regardless of which adapter is in use.
 *
 * This helper is a thin wrapper around `buildPaywallJsonLd` + `buildPreviewHtml`;
 * adapters import it from `@verivyx/paywall` rather than each maintaining a
 * private copy.
 */
export function buildSeoPreviewResponse(
  slug: string,
  url: string,
  seoPreview: (c: { slug: string }) => { title: string; excerpt: string },
): Response {
  const { title, excerpt } = seoPreview({ slug });
  const jsonLd = buildPaywallJsonLd({ title, description: excerpt, url });
  const html = buildPreviewHtml({ title, excerpt, url, jsonLd });
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
