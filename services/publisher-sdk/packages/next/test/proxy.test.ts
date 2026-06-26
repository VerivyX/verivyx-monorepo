import { describe, it, expect } from "vitest";
import { verivyxProxy } from "../src/index.js";
const coreReturning = (d: any) => ({ protect: async () => d } as any);
const opts = (core: any) => ({ domain: "web-test.verivyx.com", token: "t", _core: core });
describe("verivyxProxy settling gate", () => {
  it("blocks: !allowed → decision.response() (402)", async () => {
    const proxy = verivyxProxy(opts(coreReturning({ allowed: false, reason: "ai-bot", response: () => new Response("x", { status: 402 }) })));
    const out = await proxy(new Request("https://x.com/articles/a", { headers: { "user-agent": "GPTBot" } }));
    expect(out?.status).toBe(402);
  });
  it("passes: allowed (human) → undefined", async () => {
    const proxy = verivyxProxy(opts(coreReturning({ allowed: true, reason: "human", response: () => new Response(null) })));
    expect(await proxy(new Request("https://x.com/articles/a", { headers: { "user-agent": "Mozilla/5.0" } }))).toBeUndefined();
  });
  it("passes paid: allowed + paymentResponse → NextResponse.next() with PAYMENT-RESPONSE header (not empty body)", async () => {
    const proxy = verivyxProxy(opts(coreReturning({ allowed: true, reason: "paid", response: () => new Response(null), paymentResponse: "settled" })));
    const out = await proxy(new Request("https://x.com/articles/a", { headers: { "payment-signature": "sig" } }));
    // Must be defined (NextResponse.next()) — a plain Response(null) would short-circuit with empty body.
    expect(out).toBeDefined();
    expect(out!.headers.get("payment-response")).toBe("settled");
    // NextResponse.next() sets x-middleware-next: "1"; a plain Response does not.
    // This guards against a regression where we'd return new Response(null, {headers: {"PAYMENT-RESPONSE": ...}})
    // instead of NextResponse.next() — the plain Response would serve an empty body to the agent.
    expect(out!.headers.get("x-middleware-next")).toBe("1");
  });
  it("core throws → undefined (safe fail, don't break the site)", async () => {
    const core = { protect: async () => { throw new Error("boom"); } } as any;
    const proxy = verivyxProxy({ domain: "web-test.verivyx.com", token: "t", _core: core });
    expect(await proxy(new Request("https://x.com/articles/a", { headers: { "user-agent": "GPTBot" } }))).toBeUndefined();
  });
  it("match: non-matching path → undefined, core not called", async () => {
    let called = false;
    const core = { protect: async () => { called = true; return { allowed: false, reason: "ai-bot", response: () => new Response(null, { status: 402 }) }; } } as any;
    const proxy = verivyxProxy({ ...opts(core), match: ["/articles/*"] });
    expect(await proxy(new Request("https://x.com/pricing", { headers: { "user-agent": "GPTBot" } }))).toBeUndefined();
    expect(called).toBe(false);
  });
});
