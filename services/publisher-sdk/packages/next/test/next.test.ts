import { describe, it, expect, vi } from "vitest";
import { verivyx } from "@verivyx/paywall";
import type { Verivyx, DiscoveryOptions } from "@verivyx/paywall";
import { verivyxNext } from "../src/index.js";

function wrap(
  coreOverrides: Parameters<typeof verivyx.mock>[0],
  adapterOpts?: { advertise?: DiscoveryOptions },
) {
  const vx = verivyxNext({
    domain: "ex.com",
    token: "t",
    _core: verivyx.mock(coreOverrides),
    ...adapterOpts,
  });
  const handler = vi.fn(async () => new Response("SECRET BODY", { status: 200 }));
  return { GET: vx.protect(handler), handler };
}

// Minimal Verivyx stub that captures the x-real-ip seen by protect().
function makeCaptureCore(): { core: Verivyx; capturedIp: () => string | null } {
  let captured: string | null = null;
  const core: Verivyx = {
    protect: async (req: Request) => {
      captured = req.headers.get("x-real-ip");
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

describe("verivyxNext", () => {
  it("402 for ai-bot, handler not run", async () => {
    const { GET, handler } = wrap({ classification: "ai-bot" });
    const res = await GET(
      new Request("https://ex.com/articles/x", { headers: { "user-agent": "GPTBot" } }),
      { params: Promise.resolve({ slug: "x" }) },
    );
    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs handler for mocked-paid and attaches PAYMENT-RESPONSE", async () => {
    const { GET, handler } = wrap({
      classification: "paid",
      authorize: { authorized: true, transaction: "tx", paymentResponse: "cmVjZWlwdA==" },
    });
    const res = await GET(
      new Request("https://ex.com/articles/x", { headers: { "payment-signature": "s" } }),
      { params: Promise.resolve({ slug: "x" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SECRET BODY");
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe("cmVjZWlwdA==");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("awaits ctx.params Promise to resolve slug", async () => {
    const { GET, handler } = wrap({ classification: "paid", authorize: { authorized: true } });
    // params is a Promise — must be awaited
    const paramsPromise = new Promise<Record<string, string>>((resolve) =>
      setTimeout(() => resolve({ slug: "deferred-slug" }), 0),
    );
    const res = await GET(
      new Request("https://ex.com/articles/deferred-slug"),
      { params: paramsPromise },
    );
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("falls back to last path segment when no ctx.params", async () => {
    const { GET, handler } = wrap({ classification: "paid", authorize: { authorized: true } });
    const res = await GET(
      new Request("https://ex.com/articles/fallback-slug"),
      { params: undefined },
    );
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("attaches Link + Content-Usage headers when advertise is set (denied path)", async () => {
    const { GET, handler } = wrap(
      { classification: "ai-bot" },
      { advertise: { licenseUrl: "https://ex.com/license.xml" } },
    );
    const res = await GET(
      new Request("https://ex.com/articles/x", { headers: { "user-agent": "GPTBot" } }),
      { params: Promise.resolve({ slug: "x" }) },
    );
    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
    expect(res.headers.get("content-usage")).toBe("train-ai=n, search=y");
    expect(res.headers.get("link")).toContain('rel="license"');
  });

  it("omits advertise headers by default (no advertise option)", async () => {
    const { GET } = wrap({ classification: "ai-bot" });
    const res = await GET(
      new Request("https://ex.com/articles/x", { headers: { "user-agent": "GPTBot" } }),
      { params: Promise.resolve({ slug: "x" }) },
    );
    expect(res.status).toBe(402);
    expect(res.headers.get("content-usage")).toBeNull();
  });

  /**
   * proxy() tests use the REAL classifier (no mock injection — proxy() ignores
   * _core entirely). proxy() is a coarse, network-free pre-filter; the route
   * handler is the authoritative gate.
   */
  describe("proxy()", () => {
    it("returns 402 for a clear AI-bot UA with no payment header", async () => {
      // GPTBot matches the "gptbot" needle in the real classifier → ai-bot → 402.
      const vx = verivyxNext({ domain: "ex.com", token: "t" });
      const proxyFn = vx.proxy();
      const result = await proxyFn(
        new Request("https://ex.com/articles/x", {
          headers: { "user-agent": "GPTBot/1.0" },
        }),
      );
      expect(result).toBeInstanceOf(Response);
      expect(result?.status).toBe(402);
    });

    it("returns undefined (pass-through) for a normal browser UA", async () => {
      // A Chrome UA has no matching needle → human → proxy lets it through.
      const vx = verivyxNext({ domain: "ex.com", token: "t" });
      const proxyFn = vx.proxy();
      const result = await proxyFn(
        new Request("https://ex.com/articles/x", {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
        }),
      );
      expect(result).toBeUndefined();
    });

    it("returns undefined (pass-through) when a payment header is present", async () => {
      // Even a GPTBot UA is passed through when PAYMENT-SIGNATURE is present;
      // the route handler handles authorization.
      const vx = verivyxNext({ domain: "ex.com", token: "t" });
      const proxyFn = vx.proxy();
      const result = await proxyFn(
        new Request("https://ex.com/articles/x", {
          headers: {
            "user-agent": "GPTBot/1.0",
            "payment-signature": "sig123",
          },
        }),
      );
      expect(result).toBeUndefined();
    });
  });

  it("seoPreview: crawler request receives 200 HTML with JSON-LD, handler not called", async () => {
    // Force classification to "crawler" via the mock so we don't need real DNS.
    const handler = vi.fn(async () => new Response("SECRET BODY", { status: 200 }));
    const vx = verivyxNext({
      domain: "ex.com",
      token: "t",
      _core: verivyx.mock({ classification: "crawler" }),
    });
    const GET = vx.protect(handler, {
      seoPreview: () => ({ title: "T", excerpt: "E" }),
    });
    const res = await GET(
      new Request("https://ex.com/articles/x", {
        headers: { "user-agent": "Googlebot/2.1" },
      }),
      { params: Promise.resolve({ slug: "x" }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // Anti-cloaking JSON-LD marker must be present in the preview HTML.
    expect(body).toMatch(/isAccessibleForFree|vx-paywalled/);
    expect(handler).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // IP-trust security: verify what x-real-ip the CORE actually receives.
  // ---------------------------------------------------------------------------

  it("IP-trust: core receives x-forwarded-for first-hop (5.5.5.5) not client x-real-ip (7.7.7.7)", async () => {
    const { core, capturedIp } = makeCaptureCore();
    const vx = verivyxNext({ domain: "ex.com", token: "t", _core: core });
    const GET = vx.protect(vi.fn(async () => new Response("ok")));
    await GET(
      new Request("https://ex.com/articles/x", {
        headers: {
          "x-forwarded-for": "5.5.5.5, 10.0.0.1",
          "x-real-ip": "7.7.7.7", // client-supplied — must be overridden
        },
      }),
      { params: Promise.resolve({ slug: "x" }) },
    );
    // XFF first-hop (5.5.5.5) takes precedence; client x-real-ip is overridden.
    expect(capturedIp()).toBe("5.5.5.5");
  });

  it("IP-trust: trustProxy:false strips x-real-ip so core sees null (no IP spoofing)", async () => {
    const { core, capturedIp } = makeCaptureCore();
    const vx = verivyxNext({ domain: "ex.com", token: "t", trustProxy: false, _core: core });
    const GET = vx.protect(vi.fn(async () => new Response("ok")));
    await GET(
      new Request("https://ex.com/articles/x", {
        headers: {
          "x-real-ip": "6.6.6.6",       // client-supplied spoof attempt
          "x-forwarded-for": "6.6.6.6", // also stripped
        },
      }),
      { params: Promise.resolve({ slug: "x" }) },
    );
    // Core must see null — client cannot inject a fake IP when trustProxy:false.
    expect(capturedIp()).toBeNull();
  });
});
