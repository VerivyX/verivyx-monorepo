import { describe, it, expect } from "vitest";
import { verivyx } from "@verivyx/paywall";
import { makeGET } from "../app/articles/[slug]/route.js";

describe("next-app-router smoke", () => {
  it("returns 402 for an AI bot and does NOT return the full article body", async () => {
    const GET = makeGET({
      domain: "example.com",
      token: "test-token",
      _core: verivyx.mock({ classification: "ai-bot" }),
    } as never);
    const res = await GET(
      new Request("https://example.com/articles/my-post", {
        headers: { "user-agent": "GPTBot/1.0" },
      }),
      { params: Promise.resolve({ slug: "my-post" }) },
    );
    expect(res.status).toBe(402);
    const body = await res.text();
    expect(body).not.toContain("full article");
  });

  it("returns 200 with the full article body for a paid request", async () => {
    const GET = makeGET({
      domain: "example.com",
      token: "test-token",
      _core: verivyx.mock({
        classification: "paid",
        authorize: { authorized: true, transaction: "tx-smoke" },
      }),
    } as never);
    const res = await GET(
      new Request("https://example.com/articles/my-post", {
        headers: { "payment-signature": "sig-smoke" },
      }),
      { params: Promise.resolve({ slug: "my-post" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { body: string };
    expect(data).toEqual({ body: "full article my-post" });
  });
});
