import { describe, it, expect, vi } from "vitest";
import { verivyxMiddleware } from "../src/index.js";

const coreReturning = (d: any) => ({ protect: async () => d } as any);
const opts = (core: any) => ({ domain: "web-test.verivyx.com", token: "t", _core: core });

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    statusCode: 0,
    _body: undefined as any,
    headers,
    status(c: number) { this.statusCode = c; return this; },
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    append(k: string, v: string) { headers[k.toLowerCase()] = v; },
    send(b: any) { this._body = b; return this; },
  } as any;
}

function fakeReq(path: string, ua: string, extra: Record<string, string> = {}) {
  return {
    method: "GET",
    originalUrl: path,
    url: path,
    headers: { "user-agent": ua, host: "x.com", ...extra },
    socket: { remoteAddress: "1.2.3.4" },
  } as any;
}

describe("verivyxMiddleware (express)", () => {
  it("blocks ai-bot: writes 402, next NOT called", async () => {
    const next = vi.fn();
    const res = fakeRes();
    await verivyxMiddleware(
      opts(coreReturning({ allowed: false, reason: "ai-bot", response: () => new Response("x", { status: 402 }) })),
    )(fakeReq("/articles/a", "GPTBot"), res, next);
    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes human: next() called, no body", async () => {
    const next = vi.fn();
    const res = fakeRes();
    await verivyxMiddleware(
      opts(coreReturning({ allowed: true, reason: "human", response: () => new Response(null) })),
    )(fakeReq("/articles/a", "Mozilla/5.0"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._body).toBeUndefined();
  });

  it("paid: next() + PAYMENT-RESPONSE header", async () => {
    const next = vi.fn();
    const res = fakeRes();
    await verivyxMiddleware(
      opts(coreReturning({ allowed: true, reason: "paid", response: () => new Response(null), paymentResponse: "settled" })),
    )(fakeReq("/articles/a", "agent", { "payment-signature": "sig" }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.headers["payment-response"]).toBe("settled");
  });

  it("match: non-matching path → next(), core not called", async () => {
    let called = false;
    const next = vi.fn();
    const res = fakeRes();
    const core = {
      protect: async () => {
        called = true;
        return { allowed: false, reason: "ai-bot", response: () => new Response(null, { status: 402 }) };
      },
    } as any;
    await verivyxMiddleware({ ...opts(core), match: ["/articles/*"] })(
      fakeReq("/pricing", "GPTBot"),
      res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(called).toBe(false);
  });
});
