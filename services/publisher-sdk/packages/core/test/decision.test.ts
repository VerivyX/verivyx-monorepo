import { describe, it, expect } from "vitest";
import {
  makeDecision,
  applyFailMode,
  type GateDecision,
  type GateReason,
} from "../src/decision";
import { resolveConfig } from "../src/config";
import type { PaymentRequirement } from "../src/types";

// Minimal resolved config for tests
const cfg = resolveConfig(
  { domain: "example.com", token: "test-token", failMode: "closed" },
  {},
);
const cfgTeaser = resolveConfig(
  { domain: "example.com", token: "test-token", failMode: "teaser" },
  {},
);
const cfgOpen = resolveConfig(
  { domain: "example.com", token: "test-token", failMode: "open" },
  {},
);

const samplePaymentRequirements: PaymentRequirement[] = [
  {
    scheme: "x402",
    network: "stellar",
    asset: "USDC",
    amount: "0.01",
    payTo: "GABC1234",
  },
];

describe("makeDecision", () => {
  it("bot-unpaid: response() returns 402 with PAYMENT-REQUIRED header and JSON body", async () => {
    const decision = makeDecision(
      { reason: "bot-unpaid", paymentRequirements: samplePaymentRequirements },
      cfg,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("bot-unpaid");

    const res = decision.response();
    expect(res.status).toBe(402);

    // Body should be JSON with x402Version and accepts array
    const body = await res.json() as { x402Version: number; accepts: PaymentRequirement[] };
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toEqual(samplePaymentRequirements);

    // PAYMENT-REQUIRED header must be base64 of the same JSON
    const headerVal = res.headers.get("PAYMENT-REQUIRED");
    expect(headerVal).toBeTruthy();
    const decoded = JSON.parse(atob(headerVal!)) as { x402Version: number; accepts: PaymentRequirement[] };
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toEqual(samplePaymentRequirements);
  });

  it("bot-unpaid: response() returns 402 with empty accepts when no paymentRequirements", async () => {
    const decision = makeDecision({ reason: "bot-unpaid" }, cfg);
    expect(decision.allowed).toBe(false);
    const res = decision.response();
    expect(res.status).toBe(402);
    const body = await res.json() as { x402Version: number; accepts: PaymentRequirement[] };
    expect(body.accepts).toEqual([]);
  });

  it("paid: response() returns 200", () => {
    const decision = makeDecision({ reason: "paid", transaction: "tx123" }, cfg);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("paid");
    expect(decision.transaction).toBe("tx123");
    const res = decision.response();
    expect(res.status).toBe(200);
  });

  it("verified: allowed=true", () => {
    const decision = makeDecision({ reason: "verified" }, cfg);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("verified");
  });

  it("human-unverified: response() returns 402 when no preview builders", () => {
    const decision = makeDecision({ reason: "human-unverified" }, cfg);
    expect(decision.allowed).toBe(false);
    const res = decision.response();
    // no preview builders -> falls back to 402
    expect(res.status).toBe(402);
  });

  it("crawler: response() returns 402 when no preview builders", () => {
    const decision = makeDecision({ reason: "crawler" }, cfg);
    expect(decision.allowed).toBe(false);
    const res = decision.response();
    expect(res.status).toBe(402);
  });

  it("error: response() uses failMode=closed -> 503", () => {
    const decision = makeDecision({ reason: "error" }, cfg);
    expect(decision.allowed).toBe(false);
    const res = decision.response();
    expect(res.status).toBe(503);
  });
});

describe("applyFailMode", () => {
  it('closed -> 503 response, not allowed', () => {
    const decision = applyFailMode(cfg, {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("error");
    const res = decision.response();
    expect(res.status).toBe(503);
  });

  it('open -> allowed decision', () => {
    const decision = applyFailMode(cfgOpen, {});
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("error");
    // open mode: handler runs, response is 200
    const res = decision.response();
    expect(res.status).toBe(200);
  });

  it('teaser -> preview response (200) when preview builder provided', async () => {
    const previewHtml = "<p>Preview content</p>";
    const decision = applyFailMode(cfgTeaser, {
      buildPreview: async () => previewHtml,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("error");
    const res = decision.response();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(previewHtml);
  });

  it('teaser -> 402 when no preview builder', () => {
    const decision = applyFailMode(cfgTeaser, {});
    expect(decision.allowed).toBe(false);
    const res = decision.response();
    // no preview builder, fallback to 402
    expect(res.status).toBe(402);
  });
});

describe("GateDecision reason types", () => {
  const reasons: GateReason[] = [
    "paid",
    "verified",
    "bot-unpaid",
    "crawler",
    "human-unverified",
    "error",
  ];

  it("covers all expected reason codes", () => {
    expect(reasons).toHaveLength(6);
    for (const r of reasons) {
      const d = makeDecision({ reason: r }, cfg);
      expect(d.reason).toBe(r);
    }
  });
});
