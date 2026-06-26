import { describe, it, expect, vi } from "vitest";
import { verivyxHonoMiddleware } from "../src/index.js";

const coreReturning = (d: any) => ({ protect: async () => d } as any);
const opts = (core: any) => ({ domain: "web-test.verivyx.com", token: "t", _core: core });

function fakeCtx(path: string, ua: string, extra: Record<string, string> = {}) {
  const h = new Headers({ "user-agent": ua, host: "x.com", ...extra });
  const raw = new Request("https://x.com" + path, { headers: h });
  return {
    req: { raw, path, header: (k: string) => h.get(k) ?? undefined, param: () => undefined },
    res: new Response(null),
  } as any;
}

describe("verivyxHonoMiddleware", () => {
  it("blocks ai-bot: returns 402, next NOT called", async () => {
    const next = vi.fn();
    const c = fakeCtx("/articles/a", "GPTBot");
    const out = await verivyxHonoMiddleware(
      opts(
        coreReturning({
          allowed: false,
          reason: "ai-bot",
          response: () => new Response("x", { status: 402 }),
        }),
      ),
    )(c, next);
    expect((out as Response).status).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes human: next called", async () => {
    const next = vi.fn();
    const c = fakeCtx("/articles/a", "Mozilla/5.0");
    await verivyxHonoMiddleware(
      opts(
        coreReturning({
          allowed: true,
          reason: "human",
          response: () => new Response(null),
        }),
      ),
    )(c, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("paid: next + PAYMENT-RESPONSE on c.res", async () => {
    const next = vi.fn();
    const c = fakeCtx("/articles/a", "agent", { "payment-signature": "sig" });
    await verivyxHonoMiddleware(
      opts(
        coreReturning({
          allowed: true,
          reason: "paid",
          response: () => new Response(null),
          paymentResponse: "settled",
        }),
      ),
    )(c, next);
    expect(next).toHaveBeenCalledOnce();
    expect(c.res.headers.get("payment-response")).toBe("settled");
  });

  it("match: non-matching → next, core not called", async () => {
    let called = false;
    const next = vi.fn();
    const c = fakeCtx("/pricing", "GPTBot");
    const core = {
      protect: async () => {
        called = true;
        return {
          allowed: false,
          reason: "ai-bot",
          response: () => new Response(null, { status: 402 }),
        };
      },
    } as any;
    await verivyxHonoMiddleware({ ...opts(core), match: ["/articles/*"] })(c, next);
    expect(next).toHaveBeenCalledOnce();
    expect(called).toBe(false);
  });
});
