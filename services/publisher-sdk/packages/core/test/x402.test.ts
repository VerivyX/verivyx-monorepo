import { describe, it, expect } from "vitest";
import { buildPaymentRequired, readPaymentHeader, toBase64Utf8 } from "../src/x402";
import type { PaymentRequirement } from "../src/x402";

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const sampleReq: PaymentRequirement = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  amount: "0.05",
  payTo: "GABC1234EFGH5678",
  maxTimeoutSeconds: 300,
};

const sampleReqWithExtra: PaymentRequirement = {
  scheme: "exact",
  network: "stellar:pubnet",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVV",
  amount: "1.23",
  payTo: "GPAY9999",
  maxTimeoutSeconds: 60,
  extra: { memo: "invoice-42" },
};

const resource = {
  url: "https://example.com/articles/secret",
  mimeType: "text/html",
};

// ---------------------------------------------------------------------------
// buildPaymentRequired
// ---------------------------------------------------------------------------

describe("buildPaymentRequired", () => {
  it("emits x402Version 2 in the body", () => {
    const { body } = buildPaymentRequired([sampleReq], resource, "Payment required");
    expect((body as Record<string, unknown>).x402Version).toBe(2);
  });

  it("emits top-level resource field", () => {
    const { body } = buildPaymentRequired([sampleReq], resource, "Payment required");
    const b = body as Record<string, unknown>;
    expect(b.resource).toBeDefined();
    const res = b.resource as Record<string, unknown>;
    expect(res.url).toBe(resource.url);
    expect(res.mimeType).toBe(resource.mimeType);
  });

  it("emits top-level accepts array", () => {
    const { body } = buildPaymentRequired([sampleReq], resource, "Payment required");
    const b = body as Record<string, unknown>;
    expect(Array.isArray(b.accepts)).toBe(true);
    expect((b.accepts as unknown[]).length).toBe(1);
  });

  it("emits top-level error field", () => {
    const { body } = buildPaymentRequired([sampleReq], resource, "Payment required");
    const b = body as Record<string, unknown>;
    expect(b.error).toBe("Payment required");
  });

  it("does NOT mutate or recompute requirement amounts — passes amount verbatim", () => {
    const { body } = buildPaymentRequired([sampleReq], resource, "Payment required");
    const accepts = (body as Record<string, unknown>).accepts as PaymentRequirement[];
    const first = accepts[0];
    expect(first).toBeDefined();
    expect(first!.amount).toBe("0.05");
    expect(first!.payTo).toBe("GABC1234EFGH5678");
    expect(first!.network).toBe("stellar:testnet");
    expect(first!.scheme).toBe("exact");
  });

  it("preserves extra field on requirements", () => {
    const { body } = buildPaymentRequired([sampleReqWithExtra], resource, "err");
    const accepts = (body as Record<string, unknown>).accepts as PaymentRequirement[];
    const first = accepts[0];
    expect(first).toBeDefined();
    expect(first!.extra).toEqual({ memo: "invoice-42" });
  });

  it("handles multiple requirements, preserving all verbatim", () => {
    const { body } = buildPaymentRequired(
      [sampleReq, sampleReqWithExtra],
      resource,
      "err",
    );
    const accepts = (body as Record<string, unknown>).accepts as PaymentRequirement[];
    expect(accepts.length).toBe(2);
    expect(accepts[0]!.amount).toBe("0.05");
    expect(accepts[1]!.amount).toBe("1.23");
  });

  it("header is base64 of JSON.stringify(body)", () => {
    const { body, header } = buildPaymentRequired([sampleReq], resource, "Payment required");
    const decoded = atob(header);
    expect(JSON.parse(decoded)).toEqual(body);
  });

  it("handles empty accepts array", () => {
    const { body, header } = buildPaymentRequired([], resource, "No requirements");
    const b = body as Record<string, unknown>;
    expect(Array.isArray(b.accepts)).toBe(true);
    expect((b.accepts as unknown[]).length).toBe(0);
    const decoded = atob(header);
    expect(JSON.parse(decoded)).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// toBase64Utf8
// ---------------------------------------------------------------------------

describe("toBase64Utf8", () => {
  it("round-trips ASCII strings identically to btoa", () => {
    const s = '{"x402Version":2,"error":"Payment required"}';
    expect(toBase64Utf8(s)).toBe(btoa(s));
  });

  it("does NOT throw on non-ASCII input (btoa would throw)", () => {
    const nonAscii = "支払いが必要です";
    // Confirm btoa actually throws so we know the helper solves a real problem
    expect(() => btoa(nonAscii)).toThrow();
    // Helper must not throw
    expect(() => toBase64Utf8(nonAscii)).not.toThrow();
  });

  it("round-trips non-ASCII via UTF-8 decode", () => {
    const s = "支払いが必要です";
    const encoded = toBase64Utf8(s);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// buildPaymentRequired — unicode safety
// ---------------------------------------------------------------------------

describe("buildPaymentRequired unicode safety", () => {
  it("does not throw when error contains non-ASCII characters", () => {
    const nonAsciiError = "支払いが必要です";
    expect(() =>
      buildPaymentRequired([sampleReq], resource, nonAsciiError),
    ).not.toThrow();
  });

  it("header base64 decodes (UTF-8) back to JSON with original non-ASCII error", () => {
    const nonAsciiError = "支払いが必要です";
    const { header } = buildPaymentRequired([sampleReq], resource, nonAsciiError);
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(header), (c) => c.charCodeAt(0)),
      ),
    );
    expect((decoded as Record<string, unknown>).error).toBe(nonAsciiError);
  });

  it("preserves non-ASCII unicode in extra field through header round-trip", () => {
    const unicodeExtra: PaymentRequirement = {
      ...sampleReq,
      extra: { title: "مقال مدفوع" },
    };
    const { header } = buildPaymentRequired([unicodeExtra], resource, "err");
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(header), (c) => c.charCodeAt(0)),
      ),
    );
    const accepts = (decoded as Record<string, unknown>).accepts as PaymentRequirement[];
    expect(accepts[0]!.extra).toEqual({ title: "مقال مدفوع" });
  });
});

// ---------------------------------------------------------------------------
// readPaymentHeader
// ---------------------------------------------------------------------------

describe("readPaymentHeader", () => {
  it("returns null when neither PAYMENT-SIGNATURE nor X-PAYMENT present", () => {
    const req = new Request("https://example.com/articles/secret");
    expect(readPaymentHeader(req)).toBeNull();
  });

  it("returns { raw, version: 2 } for PAYMENT-SIGNATURE header", () => {
    const payload = "test-payment-signature-v2";
    const req = new Request("https://example.com/articles/secret", {
      headers: { "payment-signature": payload },
    });
    const result = readPaymentHeader(req);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(result!.raw).toBe(payload);
  });

  it("returns { raw, version: 1 } for X-PAYMENT header", () => {
    const payload = "test-payment-v1";
    const req = new Request("https://example.com/articles/secret", {
      headers: { "x-payment": payload },
    });
    const result = readPaymentHeader(req);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.raw).toBe(payload);
  });

  it("prefers PAYMENT-SIGNATURE (v2) over X-PAYMENT (v1) when both present", () => {
    const req = new Request("https://example.com/articles/secret", {
      headers: {
        "payment-signature": "v2-token",
        "x-payment": "v1-token",
      },
    });
    const result = readPaymentHeader(req);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(result!.raw).toBe("v2-token");
  });

  it("is case-insensitive for header lookup (uppercase header name)", () => {
    // The Fetch API Headers object normalises to lowercase internally
    const req = new Request("https://example.com/articles/secret", {
      headers: { "X-PAYMENT": "case-test" },
    });
    const result = readPaymentHeader(req);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.raw).toBe("case-test");
  });
});
