import { describe, it, expect } from "vitest";
import { verivyx } from "@verivyx/paywall";
import { makeApp } from "../src/index.js";

describe("hono-worker smoke", () => {
  it("returns 402 for an AI bot and does NOT return the full article body", async () => {
    const app = makeApp({
      domain: "example.com",
      token: "test-token",
      _core: verivyx.mock({ classification: "ai-bot" }),
    });
    const res = await app.request("/articles/my-post", {
      headers: { "user-agent": "GPTBot/1.0" },
    });
    expect(res.status).toBe(402);
    const body = await res.text();
    expect(body).not.toContain("full article");
  });

  it("returns 200 with the full article body for a paid request", async () => {
    const app = makeApp({
      domain: "example.com",
      token: "test-token",
      _core: verivyx.mock({
        classification: "paid",
        authorize: { authorized: true, transaction: "tx-smoke" },
      }),
    });
    const res = await app.request("/articles/my-post", {
      headers: { "payment-signature": "sig-smoke" },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { body: string };
    expect(data).toEqual({ body: "full article my-post" });
  });
});
