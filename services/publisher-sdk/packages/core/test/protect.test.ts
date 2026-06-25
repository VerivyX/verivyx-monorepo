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

  it("a human request yields reason 'human-unverified' (not 'crawler')", async () => {
    const v = verivyx.mock({ classification: "human" });
    const decision = await v.protect(
      req("https://pub.example.com/blog/secret", {
        "user-agent": "Mozilla/5.0",
      }),
    );
    expect(decision.reason).toBe("human-unverified");
    expect(decision.allowed).toBe(false);
    expect(decision.response().status).toBe(402);
  });

  it("a DNS-verified crawler yields reason 'crawler'", async () => {
    // Do NOT force classification — exercise the real classifier so a verified
    // Googlebot (DNS ok) classifies as 'crawler'.
    const v = verivyx.mock({
      verifyCrawlerDns: async () => true,
    });
    const decision = await v.protect(
      req("https://pub.example.com/blog/secret", {
        "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
        "x-real-ip": "66.249.66.1",
      }),
    );
    expect(decision.reason).toBe("crawler");
  });

  it("an unverified (spoofed) crawler downgrades to bot-unpaid, not 'crawler'", async () => {
    const v = verivyx.mock(); // no verifyCrawlerDns → spoof defense → ai-bot
    const decision = await v.protect(
      req("https://pub.example.com/blog/secret", {
        "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
      }),
    );
    expect(decision.reason).toBe("bot-unpaid");
  });
});

// ---------------------------------------------------------------------------
// onDecision + signals wiring (FIX 3)
// ---------------------------------------------------------------------------

describe("onDecision + signals wiring", () => {
  it("onDecision is invoked on the wrapped-handler path with the decision", async () => {
    const seen: GateDecision[] = [];
    const handler = vi.fn(okHandler);
    const v = verivyx.mock({
      classification: "ai-bot",
      onDecision: (d) => seen.push(d),
    });
    const wrapped = v.protect(handler);
    await wrapped(
      req("https://pub.example.com/blog/secret", { "user-agent": "GPTBot/1.0" }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe("bot-unpaid");
  });

  it("classifier signals reach onDecision (real classifier, no forced class)", async () => {
    const seen: GateDecision[] = [];
    const handler = vi.fn(okHandler);
    const v = verivyx.mock({
      onDecision: (d) => seen.push(d),
    });
    const wrapped = v.protect(handler);
    await wrapped(
      req("https://pub.example.com/blog/secret", { "user-agent": "GPTBot/1.0" }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signals).toBeDefined();
    expect(seen[0]!.signals).toContain("ua:gptbot");
  });

  it("logger.warn fires on backend-unreachable failMode", async () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const handler = vi.fn(okHandler);
    // Use the real factory so a custom logger can be injected.
    const v = verivyx(
      {
        domain: "pub.example.com",
        token: "t",
        failMode: "closed",
        logger,
      },
      { verifyWebBotAuth: async () => false },
    );
    // Force the backend to be unreachable by injecting a failing fetch.
    const vFail = verivyx(
      {
        domain: "pub.example.com",
        token: "t",
        failMode: "closed",
        logger,
      },
      {
        verifyWebBotAuth: async () => false,
        fetch: (async () => {
          throw new TypeError("network down");
        }) as typeof fetch,
      },
    );
    void v;
    const wrapped = vFail.protect(handler);
    const res = await wrapped(
      req("https://pub.example.com/blog/secret", { "user-agent": "GPTBot/1.0" }),
    );
    expect(res.status).toBe(503); // failMode closed
    expect(warn).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
