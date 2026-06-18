/**
 * Strict allowlist HTML sanitizer.
 *
 * Uses an injected parser (platform DOMParser in the browser, linkedom in tests)
 * so the function remains pure and unit-testable in Node.
 *
 * Rules:
 *  - Remove these elements entirely: SCRIPT IFRAME OBJECT EMBED LINK META BASE FORM NOSCRIPT
 *  - Strip any attribute whose name starts with "on" (event handlers)
 *  - Strip href/src/xlink:href that are javascript:, vbscript:, or data: (except data:image/)
 *  - Strip style containing expression() or javascript:
 */

const BLOCKED_TAGS = new Set([
  'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'NOSCRIPT',
]);

const BLOCKED_URL_ATTRS = new Set(['href', 'src', 'xlink:href']);

const RE_JS_PROTO = /^\s*(javascript|vbscript):/i;
const RE_DATA_NON_IMAGE = /^\s*data:(?!image\/)/i;
const RE_STYLE_DANGEROUS = /expression\s*\(|javascript:/i;

export function sanitizeHtml(html: string, parse: (html: string) => Document): string {
  const doc = parse(html);

  // Collect elements to remove first (modifying DOM while iterating causes issues)
  const toRemove: Element[] = [];
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    if (BLOCKED_TAGS.has(el.tagName)) {
      toRemove.push(el);
      continue;
    }
    // Iterate a static snapshot of attributes so removal is safe
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (BLOCKED_URL_ATTRS.has(name)) {
        const val = attr.value;
        if (RE_JS_PROTO.test(val) || RE_DATA_NON_IMAGE.test(val)) {
          el.removeAttribute(attr.name);
        }
        continue;
      }
      if (name === 'style' && RE_STYLE_DANGEROUS.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }

  for (const el of toRemove) {
    el.parentNode?.removeChild(el);
  }

  return doc.body.innerHTML;
}

/**
 * Browser-bound convenience — wraps sanitizeHtml with the native DOMParser.
 * Only call this from browser code; it is NOT available in Node test environments.
 */
export function sanitizeForBrowser(html: string): string {
  return sanitizeHtml(
    html,
    (h) => new DOMParser().parseFromString(h, 'text/html'),
  );
}
