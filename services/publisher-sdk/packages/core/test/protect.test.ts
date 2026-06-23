import { describe, it, expect, vi } from "vitest";
import { verivyx } from "../src";
import type { GateDecision } from "../src/decision";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const samplePaymentRequirement = {
  scheme: "exact" as const,
  network: "stellar:testnet",
  asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  amount: "0.01",
  payTo: "GABC1234",
  maxTimeoutSeconds: 300,
};

function req(
  url: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { headers });
}

const okHandler = vi.fn(
  async () =>
    new Response("FULL ARTICLE BODY", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }),
);

// ---------------------------------------------------------------------------
// Wrapped-handler (overload A) tests
// ---------------------------------------------------------------------------

describe("verivyx().protect(handler) — wrapped handler", () => {
  it("returns 402 for a gptbot request and does NOT call the handler", async () => {
    const handler = vi.fn(okHandler);
    const v = verivyx.mock({
      classification: "ai-bot",
      requirements: {
        body: { x402Version: 2, accepts: [samplePaymentRequirement] },
        header: "ZmFrZQ==",
      },
    });
    const wrapped = v.protect(handler);

    const res = await wrapped(
      req("https://pub.example.com/blog/secret", {
        "user-agent": "GPTBot/1.0",
      }),
    );

    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns the full handler response for a mocked-paid request with PAYMENT-RESPONSE attached", async () => {
    const handler = vi.fn(okHandler);
    const v = verivyx.mock({
      classification: "paid",
      authorize: { authorized: true, paymentResponse: "settle-receipt-xyz" },
    });
    const wrapped = v.protect(handler);

    const res = await wrapped(
      req("https://pub.example.com/blog/secret", {
        "payment-signature": "proof",
      }),
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("FULL ARTICLE BODY");
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe("settle-receipt-xyz");
  });

  it("returns preview HTML + JSON-LD for a crawler when seoPreview is set, handler NOT called", async () => {
    const handler = vi.fn(okHandler);
    const v = verivyx.mock({ classification: "crawler" });
    const wrapped = v.protect(handler, {
      seoPreview: () => ({ title: "Secret Title", excerpt: "A teaser excerpt." }),
    });

    const res = await wrapped(
      req("https://pub.example.com/blog/secret", {
        "user-agent": "Googlebot/2.1",
      }),
    );

    expect(res.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    const html = await res.text();
    expect(html).toContain("Secret Title");
    expect(html).toContain("A teaser excerpt.");
    expect(html).toContain("application/ld+json");
    expect(html).toContain("isAccessibleForFree");
  });

  it("runs the handler directly for an unmatched route (passthrough)", async () => {
    const handler = vi.fn(okHandler);
    const v = verivyx.mock({
      match: ["/blog/**"],
      classification: "ai-bot", // would 402 if gated
    });
    const wrapped = v.protect(handler);

    const res = await wrapped(
      req("https://pub.example.com/about", { "user-agent": "GPTBot/1.0" }),
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("FULL ARTICLE BODY");
  });

  it("backend-unreachable → failMode teaser response", async () => {
    const handler = vi.fn(okHandler);
    const v = verivyx.mock({
      classification: "paid",
      failMode: "teaser",
      authorizeThrows: true,
    });
    const wrapped = v.protect(handler, {
      seoPreview: () => ({ title: "T", excerpt: "fallback teaser" }),
    });

    const res = await wrapped(
      req("https://pub.example.com/blog/secret", {
        "payment-signature": "proof",
      }),
    );

    // teaser failMode with a preview builder → 200 preview, handler not run
    expect(res.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    expect(await res.text()).toContain("fallback teaser");
  });
});

// ---------------------------------------------------------------------------
// Decision (overload B) tests
// ---------------------------------------------------------------------------

describe("verivyx().protect(req) — decision overload", () => {
  it("returns a GateDecision for a request", async () => {
    const v = verivyx.mock({ classification: "ai-bot" });
    const decision: GateDecision = await v.protect(
      req("https://pub.example.com/blog/secret", {
        "user-agent": "GPTBot/1.0",
      }),
    );

    expect(decision).toHaveProperty("allowed");
    expect(decision).toHaveProperty("reason");
    expect(typeof decision.response).toBe("function");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("bot-unpaid");
    expect(decision.response().status).toBe(402);
  });

  it("returns an allowed paid decision", async () => {
    const v = verivyx.mock({
      classification: "paid",
      authorize: { authorized: true },
    });
    const decision = await v.protect(
      req("https://pub.example.com/blog/secret", {
        "payment-signature": "proof",
      }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("paid");
  });
});
