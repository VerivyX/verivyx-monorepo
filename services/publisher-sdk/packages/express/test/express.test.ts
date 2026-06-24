import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { verivyx } from "@verivyx/paywall";
import type { DiscoveryOptions } from "@verivyx/paywall";
import { verivyxExpress, sendWebResponse } from "../src/index.js";

// Build an Express app whose underlying paywall core is mocked (no network).
// `_core` is the internal injection seam — pass a `verivyx.mock(...)` instance.
function makeApp(
  coreOverrides: Parameters<typeof verivyx.mock>[0],
  adapterOpts?: { advertise?: DiscoveryOptions },
) {
  const vx = verivyxExpress({
    domain: "ex.com",
    token: "t",
    _core: verivyx.mock(coreOverrides),
    ...adapterOpts,
  });
  const app = express();
  const handler = vi.fn((_req: express.Request, res: express.Response) =>
    res.status(200).send("SECRET BODY"),
  );
  app.get("/articles/:slug", vx.protect(handler));
  return { app, handler };
}

describe("verivyxExpress", () => {
  it("returns 402 for an AI bot and does NOT run the handler", async () => {
    const { app, handler } = makeApp({ classification: "ai-bot" });
    const res = await request(app)
      .get("/articles/my-post")
      .set("User-Agent", "GPTBot");
    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler for a mocked-paid request and returns 200 with body", async () => {
    const { app, handler } = makeApp({
      classification: "paid",
      authorize: { authorized: true, transaction: "tx1" },
    });
    const res = await request(app)
      .get("/articles/my-post")
      .set("PAYMENT-SIGNATURE", "sig");
    expect(res.status).toBe(200);
    expect(res.text).toBe("SECRET BODY");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("attaches PAYMENT-RESPONSE header when authorize returns paymentResponse", async () => {
    const { app, handler } = makeApp({
      classification: "paid",
      authorize: {
        authorized: true,
        transaction: "tx2",
        paymentResponse: "eyJtb2NrIjoidHJ1ZSJ9",
      },
    });
    const res = await request(app)
      .get("/articles/my-post")
      .set("PAYMENT-SIGNATURE", "sig");
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    // PAYMENT-RESPONSE header should be set before handler runs
    expect(
      res.headers["payment-response"] ?? res.headers["PAYMENT-RESPONSE"],
    ).toBe("eyJtb2NrIjoidHJ1ZSJ9");
  });

  it("returns 402 for a human visitor (no preview configured)", async () => {
    const { app, handler } = makeApp({ classification: "human" });
    const res = await request(app)
      .get("/articles/my-post")
      .set("User-Agent", "Mozilla/5.0");
    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
  });

  it("seoPreview: crawler request receives 200 HTML with JSON-LD, handler not called", async () => {
    const vx = verivyxExpress({
      domain: "ex.com",
      token: "t",
      _core: verivyx.mock({ classification: "crawler" }),
    });
    const app = express();
    const handler = vi.fn((_req: express.Request, res: express.Response) =>
      res.status(200).send("SECRET BODY"),
    );
    app.get("/articles/:slug", vx.protect(handler, {
      seoPreview: ({ slug }) => ({ title: `Article: ${slug}`, excerpt: "A teaser." }),
    }));
    const res = await request(app)
      .get("/articles/my-post")
      .set("User-Agent", "Googlebot/2.1");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toMatch(/isAccessibleForFree|vx-paywalled/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("seoPreview: human-unverified request receives 200 HTML with JSON-LD, handler not called", async () => {
    const vx = verivyxExpress({
      domain: "ex.com",
      token: "t",
      _core: verivyx.mock({ classification: "human" }),
    });
    const app = express();
    const handler = vi.fn((_req: express.Request, res: express.Response) =>
      res.status(200).send("SECRET BODY"),
    );
    app.get("/articles/:slug", vx.protect(handler, {
      seoPreview: () => ({ title: "Title", excerpt: "Excerpt." }),
    }));
    const res = await request(app)
      .get("/articles/my-post")
      .set("User-Agent", "Mozilla/5.0");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toMatch(/isAccessibleForFree|vx-paywalled/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("attaches Link + Content-Usage headers when advertise is set (denied path)", async () => {
    const { app, handler } = makeApp(
      { classification: "ai-bot" },
      { advertise: { licenseUrl: "https://ex.com/license.xml" } },
    );
    const res = await request(app)
      .get("/articles/my-post")
      .set("User-Agent", "GPTBot");
    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
    expect(res.headers["content-usage"]).toBe("train-ai=n, search=y");
    expect(res.headers["link"]).toContain('rel="license"');
  });

  it("omits advertise headers by default (no advertise option)", async () => {
    const { app } = makeApp({ classification: "ai-bot" });
    const res = await request(app)
      .get("/articles/my-post")
      .set("User-Agent", "GPTBot");
    expect(res.status).toBe(402);
    expect(res.headers["content-usage"]).toBeUndefined();
  });

  it("allowed path: PAYMENT-RESPONSE and advertise headers coexist on same response", async () => {
    const { app, handler } = makeApp(
      {
        classification: "paid",
        authorize: { authorized: true, transaction: "tx", paymentResponse: "cmVjZWlwdA==" },
      },
      { advertise: { licenseUrl: "https://ex.com/license.xml" } },
    );
    const res = await request(app)
      .get("/articles/my-post")
      .set("PAYMENT-SIGNATURE", "sig");
    expect(res.status).toBe(200);
    expect(res.text).toBe("SECRET BODY");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      res.headers["payment-response"] ?? res.headers["PAYMENT-RESPONSE"],
    ).toBe("cmVjZWlwdA==");
    expect(res.headers["content-usage"]).toBe("train-ai=n, search=y");
    expect(res.headers["link"]).toContain('rel="license"');
  });

  it("propagates errors from protect() to next(err)", async () => {
    const vx = verivyxExpress({
      domain: "ex.com",
      token: "t",
      _core: verivyx.mock({ authorizeThrows: true, classification: "paid" }),
    });
    const app = express();
    app.get("/articles/:slug", vx.protect((_req, res) => res.send("ok")));
    // Express default error handler returns 500 for unhandled errors
    const res = await request(app)
      .get("/articles/my-post")
      .set("PAYMENT-SIGNATURE", "sig");
    // authorizeThrows throws BackendUnreachableError — core applies failMode (default "closed" → 503)
    // Either way, it must NOT be 200 and handler must not have run
    expect(res.status).not.toBe(200);
  });
});

describe("sendWebResponse — Set-Cookie accumulation", () => {
  it("preserves multiple Set-Cookie headers (not replaced by last value)", async () => {
    // Build a Web Response carrying two distinct Set-Cookie headers.
    // The Web Headers API folds same-name values with ", " when accessed via
    // get(), but forEach emits them as separate calls — exactly the scenario
    // that triggers the res.setHeader() replacement bug.
    const webRes = new Response("body", {
      status: 402,
      headers: [
        ["Set-Cookie", "session=abc; Path=/; HttpOnly"],
        ["Set-Cookie", "tracking=xyz; Path=/; SameSite=Strict"],
      ],
    });

    // Wire up a minimal Express response via supertest so we can read the
    // actual headers that were sent on the wire.
    const app = express();
    app.get("/test", (_req, res) => {
      void sendWebResponse(res, webRes);
    });

    const result = await request(app).get("/test");

    // Both cookies must survive — not just the last one.
    const cookies = result.headers["set-cookie"] as string[] | string | undefined;
    const cookieArray = Array.isArray(cookies) ? cookies : [cookies].filter(Boolean);

    expect(cookieArray.length).toBe(2);
    expect(cookieArray.some((c) => c?.startsWith("session=abc"))).toBe(true);
    expect(cookieArray.some((c) => c?.startsWith("tracking=xyz"))).toBe(true);
  });
});
