/**
 * Tests for VerivyxClient (authorize / requirements).
 *
 * All tests use a mock fetch — no network I/O.
 */

import { describe, it, expect, vi } from "vitest";
import { VerivyxClient } from "../src/client.js";
import { BackendUnreachableError } from "../src/errors.js";
import { resolveConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Shared test config
// ---------------------------------------------------------------------------

const cfg = resolveConfig(
  { domain: "example.com", token: "test-token", timeoutMs: 500 },
  {},
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock Response compatible with the fetch Response interface. */
function mockResponse(
  status: number,
  body: object,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// authorize — success (200)
// ---------------------------------------------------------------------------

describe("VerivyxClient.authorize — 200 success", () => {
  it("returns { authorized: true, transaction } on a 200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(
        200,
        { status: "ok", served: true, authorized: true, transaction: "tx123" },
        { "PAYMENT-RESPONSE": "base64settlementinfo" },
      ),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    const result = await client.authorize({ slug: "my-article" });

    expect(result).toEqual({
      authorized: true,
      transaction: "tx123",
      paymentResponse: "base64settlementinfo",
    });
  });

  it("includes paymentResponse from PAYMENT-RESPONSE header", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(
        200,
        { authorized: true, transaction: "tx-abc" },
        { "PAYMENT-RESPONSE": "encoded-settlement" },
      ),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    const result = await client.authorize({ slug: "some-slug" });

    expect("paymentResponse" in result).toBe(true);
    if ("paymentResponse" in result) {
      expect(result.paymentResponse).toBe("encoded-settlement");
    }
  });

  it("omits paymentResponse when PAYMENT-RESPONSE header is absent", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, { authorized: true }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    const result = await client.authorize({ slug: "slug" });

    // The key must be absent — not just undefined — when the header is not present
    expect("paymentResponse" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// authorize — 402 unpaid
// ---------------------------------------------------------------------------

describe("VerivyxClient.authorize — 402 payment required", () => {
  it("returns { status: 402, required } on a 402 response", async () => {
    const requiresBody = {
      x402Version: 2,
      error: "Payment required",
      resource: { url: "https://example.com/my-article", mimeType: "text/html" },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          amount: "0.05",
          payTo: "GABC1234",
          maxTimeoutSeconds: 300,
        },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(402, requiresBody),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    const result = await client.authorize({ slug: "my-article" });

    expect(result).toEqual({ status: 402, required: requiresBody });
  });
});

// ---------------------------------------------------------------------------
// authorize — timeout throws BackendUnreachableError
// ---------------------------------------------------------------------------

describe("VerivyxClient.authorize — timeout", () => {
  /** Returns a mock fetch that hangs until the AbortSignal fires. */
  function hangingFetch() {
    return vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
            } else {
              signal.addEventListener("abort", () => {
                reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
              });
            }
          }
          // Never resolves on its own — waits for abort
        }),
    );
  }

  it("throws BackendUnreachableError when fetch never resolves (settleTimeoutMs expires)", async () => {
    // authorize() uses settleTimeoutMs — a tiny value causes an abort.
    const shortCfg = resolveConfig(
      { domain: "example.com", token: "tok", settleTimeoutMs: 10 },
      {},
    );
    const client = new VerivyxClient(shortCfg, { fetch: hangingFetch() });

    await expect(client.authorize({ slug: "my-article" })).rejects.toThrow(
      BackendUnreachableError,
    );
  });

  it("does NOT abort when settleTimeoutMs is generous and fetch resolves immediately", async () => {
    // timeoutMs is intentionally tiny (1 ms) — if authorize() mistakenly used
    // timeoutMs it would abort before the microtask queue drains. settleTimeoutMs
    // is 60 000 ms so there is plenty of headroom for an immediate resolve.
    const cfg2 = resolveConfig(
      { domain: "example.com", token: "tok", timeoutMs: 1, settleTimeoutMs: 60_000 },
      {},
    );
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ authorized: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new VerivyxClient(cfg2, { fetch: mockFetch });

    const result = await client.authorize({ slug: "article" });
    expect(result).toMatchObject({ authorized: true });
  });

  it("throws BackendUnreachableError on network error (fetch rejects)", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("Network failure"));

    const client = new VerivyxClient(cfg, { fetch: mockFetch });

    await expect(client.authorize({ slug: "my-article" })).rejects.toThrow(
      BackendUnreachableError,
    );
  });
});

// ---------------------------------------------------------------------------
// authorize — header forwarding
// ---------------------------------------------------------------------------

describe("VerivyxClient.authorize — header forwarding", () => {
  it("sends PAYMENT-SIGNATURE header when paymentHeader is given", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, { authorized: true }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await client.authorize({ slug: "article", paymentHeader: "sig-payload-abc" });

    const [_url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["PAYMENT-SIGNATURE"]).toBe("sig-payload-abc");
  });

  it("does NOT send PAYMENT-SIGNATURE when paymentHeader is absent", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, { authorized: true }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await client.authorize({ slug: "article" });

    const [_url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["PAYMENT-SIGNATURE"]).toBeUndefined();
  });

  it("sends Authorization: Bearer header when bearer is given", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, { authorized: true }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await client.authorize({ slug: "article", bearer: "human-jwt-token" });

    const [_url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer human-jwt-token");
  });

  it("does NOT send Authorization header when bearer is absent", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, { authorized: true }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await client.authorize({ slug: "article" });

    const [_url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("always sends X-Verivyx-Mode: authorize", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, { authorized: true }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await client.authorize({ slug: "article" });

    const [_url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Verivyx-Mode"]).toBe("authorize");
  });

  it("POSTs domain+slug in body", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, { authorized: true }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await client.authorize({ slug: "test-slug" });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/content/hydrate");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body.domain).toBe("example.com");
    expect(body.slug).toBe("test-slug");
  });

  it("does NOT forward cfg.token to any outbound header", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, { authorized: true }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await client.authorize({ slug: "article" }); // bearer absent — no user token either

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headerValues = Object.values(init.headers as Record<string, string>).join(" ");
    expect(headerValues).not.toContain(cfg.token);
  });
});

// ---------------------------------------------------------------------------
// authorize — non-2xx/402 error
// ---------------------------------------------------------------------------

describe("VerivyxClient.authorize — server errors", () => {
  it("throws BackendUnreachableError on 500", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(500, { error: "internal error" }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await expect(client.authorize({ slug: "article" })).rejects.toThrow(
      BackendUnreachableError,
    );
  });
});

// ---------------------------------------------------------------------------
// authorize — non-JSON body guard (Fix A)
// ---------------------------------------------------------------------------

describe("VerivyxClient.authorize — non-JSON body", () => {
  it("throws BackendUnreachableError when 200 body is not JSON (WAF intercept)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response("<html>Access Denied</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await expect(client.authorize({ slug: "article" })).rejects.toThrow(
      BackendUnreachableError,
    );
  });

  it("throws BackendUnreachableError when 402 body is not JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response("Payment Required", {
        status: 402,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await expect(client.authorize({ slug: "article" })).rejects.toThrow(
      BackendUnreachableError,
    );
  });

  it("throws BackendUnreachableError when 402 body is empty", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response("", {
        status: 402,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await expect(client.authorize({ slug: "article" })).rejects.toThrow(
      BackendUnreachableError,
    );
  });
});

// ---------------------------------------------------------------------------
// requirements
// ---------------------------------------------------------------------------

describe("VerivyxClient.requirements", () => {
  it("returns { body, header } on a 200 response from requirements endpoint", async () => {
    const requiresBody = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          amount: "0.10",
          payTo: "GPAYTO1234",
          maxTimeoutSeconds: 300,
        },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, requiresBody),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    const result = await client.requirements("premium-article");

    // Verify it called the right endpoint with correct params
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/payment/requirements");
    expect(url).toContain("domain=example.com");
    expect(url).toContain("slug=premium-article");

    // Result should have body and header
    expect(result.body).toBeDefined();
    expect(typeof result.header).toBe("string");
    expect(result.header.length).toBeGreaterThan(0);
  });

  it("returns { body, header } on a 402 response from requirements endpoint", async () => {
    const requiresBody = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          amount: "0.05",
          payTo: "GPAYTO5678",
          maxTimeoutSeconds: 300,
        },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(402, requiresBody),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    const result = await client.requirements("gated-article");

    expect(result.body).toBeDefined();
    expect(typeof result.header).toBe("string");
  });

  it("URL-encodes slug with special characters", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(200, { x402Version: 2, accepts: [] }),
    );

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await client.requirements("article with spaces & symbols");

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("slug=article%20with%20spaces%20%26%20symbols");
  });

  it("throws BackendUnreachableError on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("Network down"));

    const client = new VerivyxClient(cfg, { fetch: mockFetch });
    await expect(client.requirements("article")).rejects.toThrow(
      BackendUnreachableError,
    );
  });

  it("throws BackendUnreachableError when requirements() times out (abort)", async () => {
    const mockFetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
            } else {
              signal.addEventListener("abort", () => {
                reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
              });
            }
          }
          // Never resolves on its own — waits for abort
        });
      },
    );

    const shortCfg = resolveConfig(
      { domain: "example.com", token: "tok", timeoutMs: 10 },
      {},
    );
    const client = new VerivyxClient(shortCfg, { fetch: mockFetch });

    await expect(client.requirements("article")).rejects.toThrow(
      BackendUnreachableError,
    );
  });
});
