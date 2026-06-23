import { describe, it, expect } from "vitest";
import request from "supertest";
import { verivyx } from "@verivyx/paywall";
import { createApp } from "../src/server.js";

describe("express-minimal smoke", () => {
  it("returns 402 for an AI bot and does NOT return the full article body", async () => {
    const app = createApp({
      domain: "example.com",
      token: "test-token",
      _core: verivyx.mock({ classification: "ai-bot" }),
    });
    const res = await request(app)
      .get("/articles/my-post")
      .set("User-Agent", "GPTBot/1.0");
    expect(res.status).toBe(402);
    // The full article body must NOT be revealed.
    expect(res.text).not.toContain("full article");
  });

  it("returns 200 with the full article body for a paid request", async () => {
    const app = createApp({
      domain: "example.com",
      token: "test-token",
      _core: verivyx.mock({
        classification: "paid",
        authorize: { authorized: true, transaction: "tx-smoke" },
      }),
    });
    const res = await request(app)
      .get("/articles/my-post")
      .set("PAYMENT-SIGNATURE", "sig-smoke");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: "full article my-post" });
  });
});
