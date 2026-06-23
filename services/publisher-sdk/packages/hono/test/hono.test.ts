import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { verivyx } from "@verivyx/paywall";
import { verivyxHono } from "../src/index.js";

function makeApp(coreOverrides: Parameters<typeof verivyx.mock>[0]) {
  const vx = verivyxHono({ domain: "ex.com", token: "t", _core: verivyx.mock(coreOverrides) });
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
