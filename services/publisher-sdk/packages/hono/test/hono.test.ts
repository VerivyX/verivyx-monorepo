import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { verivyx } from "@verivyx/paywall";
import type { Verivyx, DiscoveryOptions } from "@verivyx/paywall";
import { verivyxHono } from "../src/index.js";

// ---------------------------------------------------------------------------
// Minimal Verivyx stub that captures the x-real-ip header seen by protect().
// Returns a denied GateDecision so the handler is never called.
// ---------------------------------------------------------------------------
function makeCaptureCore(): { core: Verivyx; capturedIp: () => string | null } {
  let captured: string | null = null;
  const core: Verivyx = {
    protect: async (req: Request) => {
      captured = req.headers.get("x-real-ip");
      // Return a minimal denied GateDecision (ai-bot → 402).
      return {
        allowed: false,
        reason: "ai-bot" as const,
        response: () => new Response(JSON.stringify({ error: "payment_required" }), { status: 402 }),
        paymentResponse: undefined,
      };
    },
  } as unknown as Verivyx;
  return { core, capturedIp: () => captured };
}

function makeApp(
  coreOverrides: Parameters<typeof verivyx.mock>[0],
  adapterOpts?: { advertise?: DiscoveryOptions },
) {
  const vx = verivyxHono({
    domain: "ex.com",
    token: "t",
    _core: verivyx.mock(coreOverrides),
    ...adapterOpts,
  });
  const handler = vi.fn((c: Parameters<Parameters<typeof vx.protect>[0]>[0]) =>
    c.body("SECRET BODY", 200),
  );
  const a = new Hono();
  a.get("/articles/:slug", vx.protect(handler));
  return { a, handler };
}

describe("verivyxHono", () => {
  it("returns 402 for ai-bot and does not call the handler", async () => {
    const { a, handler } = makeApp({ classification: "ai-bot" });
    const res = await a.request("/articles/my-article", {
      headers: { "user-agent": "GPTBot/1.0" },
    });
    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
  });

  it("attaches Link + Content-Usage headers when advertise is set (denied path)", async () => {
    const { a, handler } = makeApp(
      { classification: "ai-bot" },
      { advertise: { licenseUrl: "https://ex.com/license.xml" } },
    );
    const res = await a.request("/articles/x", {
      headers: { "user-agent": "GPTBot" },
    });
    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
    expect(res.headers.get("content-usage")).toBe("train-ai=n, search=y");
    expect(res.headers.get("link")).toContain('rel="license"');
  });

  it("omits advertise headers by default (no advertise option)", async () => {
    const { a } = makeApp({ classification: "ai-bot" });
    const res = await a.request("/articles/x", {
      headers: { "user-agent": "GPTBot" },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("content-usage")).toBeNull();
  });

  it("calls handler and returns 200 for mocked-paid request", async () => {
    const { a, handler } = makeApp({
      classification: "paid",
      authorize: { authorized: true, transaction: "tx123" },
    });
    const res = await a.request("/articles/my-article", {
      headers: { "payment-signature": "sig-abc" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SECRET BODY");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("attaches PAYMENT-RESPONSE header when paymentResponse is present", async () => {
    const { a } = makeApp({
      classification: "paid",
      authorize: { authorized: true, transaction: "tx456", paymentResponse: "receipt-xyz" },
    });
    const res = await a.request("/articles/my-article", {
      headers: { "payment-signature": "sig-def" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-response")).toBe("receipt-xyz");
  });

  it("resolves cf-connecting-ip over x-forwarded-for", async () => {
    // Verify the IP resolution path doesn't throw / break when headers are set
    const { a } = makeApp({
      classification: "paid",
      authorize: { authorized: true, transaction: "tx789" },
    });
    const res = await a.request("/articles/my-article", {
      headers: {
        "cf-connecting-ip": "1.2.3.4",
        "x-forwarded-for": "9.9.9.9",
        "payment-signature": "sig-ghi",
      },
    });
    expect(res.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // IP-trust security: verify what x-real-ip the CORE actually receives.
  // ---------------------------------------------------------------------------

  it("IP-trust: core receives cf-connecting-ip (1.2.3.4) not x-forwarded-for (9.9.9.9)", async () => {
    const { core, capturedIp } = makeCaptureCore();
    const vx = verivyxHono({ domain: "ex.com", token: "t", _core: core });
    const a = new Hono();
    a.get("/articles/:slug", vx.protect(async (c) => c.body("BODY", 200)));

    await a.request("/articles/my-article", {
      headers: {
        "cf-connecting-ip": "1.2.3.4",
        "x-forwarded-for": "9.9.9.9",
        "x-real-ip": "7.7.7.7", // client-supplied — must be overridden
      },
    });

    // CF-Connecting-IP has highest precedence; core must see that value.
    expect(capturedIp()).toBe("1.2.3.4");
  });

  it("IP-trust: trustProxy:false strips x-real-ip so core sees null (no IP spoofing)", async () => {
    const { core, capturedIp } = makeCaptureCore();
    const vx = verivyxHono({ domain: "ex.com", token: "t", trustProxy: false, _core: core });
    const a = new Hono();
    a.get("/articles/:slug", vx.protect(async (c) => c.body("BODY", 200)));

    await a.request("/articles/my-article", {
      headers: {
        "x-real-ip": "6.6.6.6",       // client-supplied spoof attempt
        "x-forwarded-for": "6.6.6.6", // also stripped
      },
    });

    // Core must see null — client cannot inject a fake IP when trustProxy:false.
    expect(capturedIp()).toBeNull();
  });

  it("seoPreview: crawler request receives 200 HTML with JSON-LD, handler not called", async () => {
    const vx = verivyxHono({
      domain: "ex.com",
      token: "t",
      _core: verivyx.mock({ classification: "crawler" }),
    });
    const handler = vi.fn((c: Parameters<Parameters<typeof vx.protect>[0]>[0]) =>
      c.body("SECRET BODY", 200),
    );
    const a = new Hono();
    a.get("/articles/:slug", vx.protect(handler, {
      seoPreview: ({ slug }) => ({ title: `Article: ${slug}`, excerpt: "A teaser." }),
    }));
    const res = await a.request("/articles/my-article", {
      headers: { "user-agent": "Googlebot/2.1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/isAccessibleForFree|vx-paywalled/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("seoPreview: human-unverified request receives 200 HTML with JSON-LD, handler not called", async () => {
    const vx = verivyxHono({
      domain: "ex.com",
      token: "t",
      _core: verivyx.mock({ classification: "human" }),
    });
    const handler = vi.fn((c: Parameters<Parameters<typeof vx.protect>[0]>[0]) =>
      c.body("SECRET BODY", 200),
    );
    const a = new Hono();
    a.get("/articles/:slug", vx.protect(handler, {
      seoPreview: () => ({ title: "Title", excerpt: "Excerpt." }),
    }));
    const res = await a.request("/articles/my-article", {
      headers: { "user-agent": "Mozilla/5.0" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/isAccessibleForFree|vx-paywalled/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("falls back to last path segment when :slug param missing", async () => {
    const vx = verivyxHono({
      domain: "ex.com",
      token: "t",
      _core: verivyx.mock({ classification: "ai-bot" }),
    });
    const handler = vi.fn((c: Parameters<Parameters<typeof vx.protect>[0]>[0]) =>
      c.body("BODY", 200),
    );
    const a = new Hono();
    // Route without :slug — adapter falls back to lastPathSegment
    a.get("/content/*", vx.protect(handler));
    const res = await a.request("/content/some-slug");
    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
  });
});
