import { describe, it, expect, vi } from "vitest";
import { verivyx } from "@verivyx/paywall";
import { verivyxNext } from "../src/index.js";

function wrap(coreOverrides: Parameters<typeof verivyx.mock>[0]) {
  const vx = verivyxNext({ domain: "ex.com", token: "t", _core: verivyx.mock(coreOverrides) } as never);
  const handler = vi.fn(async () => new Response("SECRET BODY", { status: 200 }));
  return { GET: vx.protect(handler), handler };
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

  it("proxy() returns undefined for non-ai-bot requests", async () => {
    const vx = verivyxNext({ domain: "ex.com", token: "t", _core: verivyx.mock({ classification: "human" }) } as never);
    const proxyFn = vx.proxy();
    const result = await proxyFn(new Request("https://ex.com/articles/x"));
    expect(result).toBeUndefined();
  });

  it("proxy() returns 402 for clear ai-bot with no payment header", async () => {
    const vx = verivyxNext({ domain: "ex.com", token: "t", _core: verivyx.mock({ classification: "ai-bot" }) } as never);
    const proxyFn = vx.proxy();
    const result = await proxyFn(
      new Request("https://ex.com/articles/x", { headers: { "user-agent": "GPTBot" } }),
    );
    expect(result).toBeInstanceOf(Response);
    expect(result?.status).toBe(402);
  });
});
