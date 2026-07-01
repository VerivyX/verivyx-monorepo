import { describe, it, expect } from "vitest";
import { getCookie, buildUnlockHtml } from "../src/index.js";

describe("getCookie", () => {
  it("reads vx_session from the Cookie header", () => {
    const req = new Request("https://x.com/", { headers: { cookie: "a=1; vx_session=TOK.EN-123; b=2" } });
    expect(getCookie(req, "vx_session")).toBe("TOK.EN-123");
  });
  it("returns undefined when absent", () => {
    expect(getCookie(new Request("https://x.com/"), "vx_session")).toBeUndefined();
  });
});

describe("buildUnlockHtml", () => {
  const html = buildUnlockHtml({
    slug: "seven-wonders", url: "https://pub.com/seven-wonders",
    authBase: "https://api.verivyx.com", domain: "web-test.verivyx.com",
    token: "vx_tok_abc123",
    seo: { title: "Seven Wonders", excerpt: "Preview." },
  });
  it("includes the teaser + JSON-LD (anti-cloaking)", () => {
    expect(html).toContain("Seven Wonders");
    expect(html).toContain("isAccessibleForFree");
  });
  it("embeds the PoW unlock flow targeting the auth base + the challenge/verify endpoints", () => {
    expect(html).toContain("https://api.verivyx.com/api/v1/auth/challenge");
    expect(html).toContain("https://api.verivyx.com/api/v1/auth/verify-human");
    expect(html).toContain("crypto.subtle.digest");
    expect(html).toContain("vx_session=");
  });
  it("sends the site token to /challenge (token-only sites can unlock)", () => {
    // token embedded in the config + posted in the challenge request body
    expect(html).toContain("vx_tok_abc123");
    expect(html).toContain("token:'vx_tok_abc123'");
    expect(html).toContain("token:C.token");
    expect(html).toContain("domain:C.domain||undefined");
  });
  it("fingerprint uses server-expected field names (not old short aliases)", () => {
    expect(html).toContain("userAgent");
    expect(html).toContain("languages");
    expect(html).toContain("screenWidth");
    expect(html).toContain("screenHeight");
    expect(html).toContain("hardwareConcurrency");
    // old wrong aliases must not appear
    expect(html).not.toContain("ua:");
    expect(html).not.toContain("lang:");
    expect(html).not.toContain("hc:");
  });
  it("does not allow </script> breakout from injected values", () => {
    const evil = buildUnlockHtml({ slug: "</script><x>", url: "https://p/x", authBase: "https://api.verivyx.com", domain: "d", token: "t" });
    expect(evil).not.toContain("</script><x>");
  });
});
