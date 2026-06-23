import { describe, it, expect } from "vitest";
import { classify } from "../src/detect.js";
import type { Classification } from "../src/detect.js";
import { resolveConfig } from "../src/config.js";

// Minimal config used throughout — detect() doesn't inspect config fields
// yet, but the signature requires one for future use (logging, etc.).
const cfg = resolveConfig({ domain: "example.com", token: "tok" }, {});

// Helpers for building test Requests
function makeReq(
  ua: string,
  extra: Record<string, string> = {},
  cookie?: string,
): Request {
  const headers: Record<string, string> = { "user-agent": ua, ...extra };
  if (cookie) headers["cookie"] = cookie;
  return new Request("https://example.com/article", { headers });
}

// Stub deps — no network I/O in tests
const noopDeps = {
  verifyWebBotAuth: async (_req: Request): Promise<boolean> => false,
};

// ---------------------------------------------------------------------------
// 1. paid — payment header present
// ---------------------------------------------------------------------------
describe("paid classification", () => {
  it("classifies PAYMENT-SIGNATURE header as paid", async () => {
    const req = makeReq("Mozilla/5.0", { "PAYMENT-SIGNATURE": "sig123" });
    const result = await classify(req, cfg, noopDeps);
    expect(result.classification).toBe<Classification>("paid");
    expect(result.signals).toContain("payment-header:PAYMENT-SIGNATURE");
  });

  it("classifies X-PAYMENT header as paid (legacy)", async () => {
    const req = makeReq("Mozilla/5.0", { "X-PAYMENT": "legacy_sig" });
    const result = await classify(req, cfg, noopDeps);
    expect(result.classification).toBe<Classification>("paid");
    expect(result.signals).toContain("payment-header:X-PAYMENT");
  });

  it("paid wins over verified session (payment header + cookie both present)", async () => {
    const req = makeReq(
      "Mozilla/5.0",
      { "PAYMENT-SIGNATURE": "sig" },
      "vx_session=abc123",
    );
    const result = await classify(req, cfg, noopDeps);
    expect(result.classification).toBe<Classification>("paid");
  });
});

// ---------------------------------------------------------------------------
// 2. verified — human session token present
// ---------------------------------------------------------------------------
describe("verified classification", () => {
  it("classifies vx_session cookie as verified", async () => {
    const req = makeReq("Mozilla/5.0", {}, "vx_session=tok123");
    const result = await classify(req, cfg, noopDeps);
    expect(result.classification).toBe<Classification>("verified");
    expect(result.signals).toContain("session:cookie");
  });

  it("classifies Authorization: Bearer header as verified", async () => {
    const req = makeReq("Mozilla/5.0", { "authorization": "Bearer jwt.token.here" });
    const result = await classify(req, cfg, noopDeps);
    expect(result.classification).toBe<Classification>("verified");
    expect(result.signals).toContain("session:bearer");
  });
});

// ---------------------------------------------------------------------------
// 3. signed-agent — verifyWebBotAuth returns true
// ---------------------------------------------------------------------------
describe("signed-agent classification", () => {
  it("classifies request as signed-agent when verifyWebBotAuth returns true", async () => {
    const req = makeReq("SomeAgentBot/1.0");
    const deps = {
      verifyWebBotAuth: async (_req: Request): Promise<boolean> => true,
    };
    const result = await classify(req, cfg, deps);
    expect(result.classification).toBe<Classification>("signed-agent");
    expect(result.signals).toContain("webbotauth:signed");
  });
});

// ---------------------------------------------------------------------------
// 4. ai-bot — UA matches known AI/scraper list
// ---------------------------------------------------------------------------
describe("ai-bot classification", () => {
  const aiBotUAs = [
    ["gptbot", "GPTBot/1.0"],
    ["claudebot", "ClaudeBot/1.0"],
    ["perplexity", "PerplexityBot/1.0"],
    ["ccbot", "CCBot/2.0"],
    ["bytespider", "Bytespider; spider-feedback@bytedance.com"],
    ["amazonbot", "Amazonbot/0.1"],
    ["oai-search", "OAI-SearchBot/1.0"],
    ["openai", "OpenAI/1.0"],
    ["anthropic", "Anthropic/1.0"],
    ["google-extended", "Google-Extended/1.0"],
    ["googleother", "GoogleOther/1.0"],
    ["headless", "HeadlessChrome/114.0"],
    ["puppeteer", "Mozilla/5.0 (puppeteer)"],
    ["playwright", "Mozilla/5.0 (playwright)"],
    ["selenium", "Mozilla/5.0 (selenium)"],
    ["python-requests", "python-requests/2.31.0"],
    ["curl/", "curl/7.87.0"],
    ["wget/", "Wget/1.21.3"],
    ["scrapy", "Scrapy/2.11.0"],
    ["node-fetch", "node-fetch/1.0.0"],
    ["axios", "axios/1.6.0"],
    ["go-http-client", "Go-http-client/2.0"],
    ["python-urllib", "Python-urllib/3.11"],
    ["libwww-perl", "libwww-perl/6.67"],
    ["httpclient", "HTTPClient/0.3"],
    ["apache-httpclient", "Apache-HttpClient/5.3"],
    ["phantomjs", "PhantomJS/2.1.1"],
  ];

  for (const [label, ua] of aiBotUAs) {
    it(`classifies "${label}" UA as ai-bot`, async () => {
      const req = makeReq(ua);
      const result = await classify(req, cfg, noopDeps);
      expect(result.classification).toBe<Classification>("ai-bot");
      expect(result.signals.some((s) => s.startsWith("ua:"))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. crawler — verified search engine (DNS check passes)
// ---------------------------------------------------------------------------
describe("crawler classification", () => {
  it("classifies googlebot UA with passing DNS as crawler", async () => {
    const req = makeReq("Googlebot/2.1 (+http://www.google.com/bot.html)", {
      "x-forwarded-for": "66.249.64.1",
    });
    const deps = {
      verifyWebBotAuth: async (_req: Request): Promise<boolean> => false,
      verifyCrawlerDns: async (_ip: string, _ua: string): Promise<boolean> => true,
    };
    const result = await classify(req, cfg, deps);
    expect(result.classification).toBe<Classification>("crawler");
    expect(result.signals).toContain("ua:googlebot");
    expect(result.signals).toContain("dns:verified");
  });

  it("classifies bingbot UA with passing DNS as crawler", async () => {
    const req = makeReq("bingbot/2.0 (+http://www.bing.com/bingbot.htm)", {
      "x-real-ip": "40.77.167.0",
    });
    const deps = {
      verifyWebBotAuth: async (_req: Request): Promise<boolean> => false,
      verifyCrawlerDns: async (_ip: string, _ua: string): Promise<boolean> => true,
    };
    const result = await classify(req, cfg, deps);
    expect(result.classification).toBe<Classification>("crawler");
    expect(result.signals).toContain("ua:bingbot");
    expect(result.signals).toContain("dns:verified");
  });

  it("classifies slurp (Yahoo) UA with passing DNS as crawler", async () => {
    const req = makeReq("Yahoo! Slurp/3.0", {
      "x-real-ip": "209.191.88.254",
    });
    const deps = {
      verifyWebBotAuth: async (_req: Request): Promise<boolean> => false,
      verifyCrawlerDns: async (_ip: string, _ua: string): Promise<boolean> => true,
    };
    const result = await classify(req, cfg, deps);
    expect(result.classification).toBe<Classification>("crawler");
    expect(result.signals).toContain("ua:slurp");
    expect(result.signals).toContain("dns:verified");
  });
});

// ---------------------------------------------------------------------------
// 6. ai-bot — crawler UA but DNS fails (spoof-defense)
// ---------------------------------------------------------------------------
describe("crawler spoofing → ai-bot", () => {
  it("classifies googlebot UA with FAILING DNS as ai-bot", async () => {
    const req = makeReq("Googlebot/2.1", { "x-forwarded-for": "1.2.3.4" });
    const deps = {
      verifyWebBotAuth: async (_req: Request): Promise<boolean> => false,
      verifyCrawlerDns: async (_ip: string, _ua: string): Promise<boolean> => false,
    };
    const result = await classify(req, cfg, deps);
    expect(result.classification).toBe<Classification>("ai-bot");
    expect(result.signals).toContain("ua:googlebot");
    expect(result.signals).toContain("dns:unverified→ai-bot");
  });

  it("classifies googlebot UA with NO DNS dep as ai-bot", async () => {
    const req = makeReq("Googlebot/2.1");
    const result = await classify(req, cfg, noopDeps);
    expect(result.classification).toBe<Classification>("ai-bot");
    expect(result.signals).toContain("ua:googlebot");
    expect(result.signals).toContain("dns:unverified→ai-bot");
  });
});

// ---------------------------------------------------------------------------
// 7. human — plain browser UA, no signals
// ---------------------------------------------------------------------------
describe("human classification", () => {
  it("classifies a plain Chrome UA as human", async () => {
    const req = makeReq(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    const result = await classify(req, cfg, noopDeps);
    expect(result.classification).toBe<Classification>("human");
    expect(result.signals).toContain("ua:human");
  });

  it("classifies a plain Firefox UA as human", async () => {
    const req = makeReq(
      "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/117.0",
    );
    const result = await classify(req, cfg, noopDeps);
    expect(result.classification).toBe<Classification>("human");
  });

  it("classifies empty UA as human (fail-open on is-human)", async () => {
    const req = makeReq("");
    const result = await classify(req, cfg, noopDeps);
    expect(result.classification).toBe<Classification>("human");
  });
});
