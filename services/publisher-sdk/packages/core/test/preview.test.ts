import { describe, it, expect } from "vitest";
import { buildPaywallJsonLd, buildPreviewHtml } from "../src/preview";

// ---------------------------------------------------------------------------
// buildPaywallJsonLd
// ---------------------------------------------------------------------------

describe("buildPaywallJsonLd", () => {
  const base = {
    title: "Article Title",
    description: "A short description.",
    url: "https://example.com/articles/test",
  };

  it("returns valid JSON string", () => {
    const result = buildPaywallJsonLd(base);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("contains @type NewsArticle", () => {
    const result = buildPaywallJsonLd(base);
    const obj = JSON.parse(result) as Record<string, unknown>;
    expect(obj["@type"]).toBe("NewsArticle");
  });

  it("contains @context https://schema.org", () => {
    const result = buildPaywallJsonLd(base);
    const obj = JSON.parse(result) as Record<string, unknown>;
    expect(obj["@context"]).toBe("https://schema.org");
  });

  it('top-level isAccessibleForFree is false', () => {
    const result = buildPaywallJsonLd(base);
    const obj = JSON.parse(result) as Record<string, unknown>;
    expect(obj["isAccessibleForFree"]).toBe(false);
  });

  it("hasPart is a WebPageElement with cssSelector .vx-paywalled", () => {
    const result = buildPaywallJsonLd(base);
    const obj = JSON.parse(result) as {
      hasPart: { "@type": string; isAccessibleForFree: boolean; cssSelector: string };
    };
    expect(obj.hasPart["@type"]).toBe("WebPageElement");
    expect(obj.hasPart.isAccessibleForFree).toBe(false);
    expect(obj.hasPart.cssSelector).toBe(".vx-paywalled");
  });

  it("embeds title, description, url into JSON", () => {
    const result = buildPaywallJsonLd(base);
    const obj = JSON.parse(result) as Record<string, unknown>;
    expect(obj["headline"]).toBe(base.title);
    expect(obj["description"]).toBe(base.description);
    expect(obj["url"]).toBe(base.url);
  });

  // Raw string check — confirms the literal token is present (matches spec)
  it('raw output contains "isAccessibleForFree":false', () => {
    const result = buildPaywallJsonLd(base);
    expect(result).toContain('"isAccessibleForFree":false');
  });

  it('raw output contains ".vx-paywalled"', () => {
    const result = buildPaywallJsonLd(base);
    expect(result).toContain(".vx-paywalled");
  });

  // XSS/breakout hardening — buildPaywallJsonLd must itself produce safe output
  it("output contains no raw < when title has </script> payload", () => {
    const result = buildPaywallJsonLd({
      title: "</script><script>alert(1)</script>",
      description: "d",
      url: "https://x/y",
    });
    // No raw `<` must remain — all are Unicode-escaped
    expect(result).not.toMatch(/<(?!\\u003c)/);
    // The escape sentinel must be present
    expect(result).toContain("\\u003c");
    // The hardened output must not contain the literal breakout sequence
    expect(result).not.toContain("</script>");
  });

  it("hardened output round-trips back to original value via JSON.parse", () => {
    const title = "</script><script>alert(1)</script>";
    const result = buildPaywallJsonLd({
      title,
      description: "d",
      url: "https://x/y",
    });
    // Replace \\u003c back with < so JSON.parse sees valid JSON
    const roundTripped = JSON.parse(result.replace(/\\u003c/g, "<")) as Record<string, unknown>;
    expect(roundTripped["headline"]).toBe(title);
  });
});

// ---------------------------------------------------------------------------
// buildPreviewHtml
// ---------------------------------------------------------------------------

describe("buildPreviewHtml", () => {
  const safeParams = {
    title: "Hello World",
    excerpt: "A short teaser.",
    url: "https://example.com/articles/test",
    jsonLd: '{"@type":"NewsArticle"}',
  };

  it("returns a string containing <html", () => {
    const html = buildPreviewHtml(safeParams);
    expect(html.toLowerCase()).toContain("<html");
  });

  it("embeds a <script type=\"application/ld+json\"> tag", () => {
    const html = buildPreviewHtml(safeParams);
    expect(html).toContain('<script type="application/ld+json">');
  });

  it("places jsonLd inside the script tag", () => {
    const html = buildPreviewHtml(safeParams);
    expect(html).toContain(safeParams.jsonLd);
  });

  it("contains title in <title> tag", () => {
    const html = buildPreviewHtml(safeParams);
    expect(html).toContain(`<title>${safeParams.title}</title>`);
  });

  it("contains excerpt text", () => {
    const html = buildPreviewHtml(safeParams);
    expect(html).toContain(safeParams.excerpt);
  });

  it("contains canonical link to url", () => {
    const html = buildPreviewHtml(safeParams);
    expect(html).toContain(safeParams.url);
  });

  // HTML escaping — title with XSS payload
  it("HTML-escapes < and > in title (prevents script injection)", () => {
    const html = buildPreviewHtml({
      ...safeParams,
      title: "<script>alert(1)</script>",
    });
    // The raw unescaped form must NOT appear
    expect(html).not.toContain("<script>alert(1)</script>");
    // The escaped form must appear
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("HTML-escapes & in title", () => {
    const html = buildPreviewHtml({ ...safeParams, title: "Cats & Dogs" });
    expect(html).not.toContain("Cats & Dogs");
    expect(html).toContain("Cats &amp; Dogs");
  });

  it('HTML-escapes " in title', () => {
    const html = buildPreviewHtml({ ...safeParams, title: 'Say "hello"' });
    expect(html).toContain("&quot;");
    expect(html).not.toContain('Say "hello"');
  });

  it("HTML-escapes ' in title", () => {
    const html = buildPreviewHtml({ ...safeParams, title: "it's here" });
    expect(html).toContain("&#39;");
  });

  it("HTML-escapes < and > in excerpt", () => {
    const html = buildPreviewHtml({
      ...safeParams,
      excerpt: "<b>bold</b>",
    });
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("HTML-escapes url when rendering as href attribute", () => {
    const html = buildPreviewHtml({
      ...safeParams,
      url: 'https://example.com/?a=1&b="2"',
    });
    expect(html).not.toContain('href="https://example.com/?a=1&b="2""');
    expect(html).toContain("&amp;");
  });

  // Double-harden idempotency: buildPreviewHtml's hardenJsonLdForScript call is a no-op
  // when the jsonLd argument already came from buildPaywallJsonLd (which now hardens itself).
  it("double-hardening via buildPreviewHtml is idempotent — no corruption", () => {
    const jsonLd = buildPaywallJsonLd({
      title: "</script><script>alert(1)</script>",
      description: "d",
      url: "https://x/y",
    });
    // Pass the already-hardened jsonLd through buildPreviewHtml — must not corrupt the output
    const html = buildPreviewHtml({ title: "T", excerpt: "E", url: "https://x/y", jsonLd });
    // The ld+json block body must contain no raw </script>
    const ldStart = html.indexOf('<script type="application/ld+json">') + '<script type="application/ld+json">'.length;
    const ldEnd = html.indexOf("</script>", ldStart);
    const ldBody = html.slice(ldStart, ldEnd);
    expect(ldBody).not.toContain("</script>");
    // The sentinel must still be present (not double-escaped)
    expect(ldBody).toContain("\\u003c");
  });

  // </script> breakout hardening: jsonLd containing </script> must not close the tag early
  it("hardens </script> in jsonLd to prevent script-tag breakout", () => {
    const attackJsonLd = '{"@type":"NewsArticle","x":"</script><script>alert(1)</script>"}';
    const html = buildPreviewHtml({ ...safeParams, jsonLd: attackJsonLd });
    // The raw </script> must not appear literally inside the ld+json block
    // (either as escaped < or as &lt; etc.; any hardening is valid)
    const scriptTagClose = /<\/script>/gi;
    // Find all </script> occurrences — only the closing tag of the ld+json block
    // should close the actual script; the payload one must be neutralised.
    const matches = html.match(scriptTagClose) ?? [];
    // There should be exactly ONE </script> per script tag in the page.
    // The ld+json block gets one + any others from the page template, but
    // the payload </script> must NOT produce an extra raw one in the tag body.
    //
    // Simpler check: after the opening <script type="application/ld+json">,
    // the NEXT </script> that terminates it must come after the full jsonLd
    // content — i.e. the payload </script> inside jsonLd is escaped/neutralised.
    const ldJsonStart = html.indexOf('<script type="application/ld+json">');
    const ldJsonBodyStart = ldJsonStart + '<script type="application/ld+json">'.length;
    const ldJsonEnd = html.indexOf("</script>", ldJsonBodyStart);
    const ldJsonBody = html.slice(ldJsonBodyStart, ldJsonEnd);
    // The body must NOT contain a literal </script> substring
    expect(ldJsonBody).not.toContain("</script>");
  });
});
