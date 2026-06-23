import { describe, it, expect, vi } from "vitest";
import { createSearchCrawlerVerifier, ipInCidr } from "../src/crawlerverify.js";

const googleJson = { prefixes: [{ ipv4Prefix: "66.249.64.0/19" }, { ipv6Prefix: "2001:4860:4801::/48" }] };
const bingJson = { prefixes: [{ ipv4Prefix: "40.77.167.0/24" }] };

function mockFetch(map: Record<string, unknown>) {
  return vi.fn(async (url: string) => ({
    ok: true,
    json: async () => map[url],
  })) as unknown as typeof fetch;
}

describe("ipInCidr", () => {
  it("matches IPv4 inside range and rejects outside", () => {
    expect(ipInCidr("66.249.66.1", "66.249.64.0/19")).toBe(true);
    expect(ipInCidr("8.8.8.8", "66.249.64.0/19")).toBe(false);
  });
  it("matches IPv6 inside range", () => {
    expect(ipInCidr("2001:4860:4801:1::5", "2001:4860:4801::/48")).toBe(true);
    expect(ipInCidr("2001:4860:4802::1", "2001:4860:4801::/48")).toBe(false);
  });
});

describe("createSearchCrawlerVerifier", () => {
  const urls = {
    g: "https://developers.google.com/search/apis/ipranges/googlebot.json",
    b: "https://www.bing.com/toolbox/bingbot.json",
  };
  it("verifies a real Googlebot IP for a googlebot UA", async () => {
    const fetch = mockFetch({ [urls.g]: googleJson, [urls.b]: bingJson });
    const verify = createSearchCrawlerVerifier({ fetch, googlebotUrl: urls.g, bingbotUrl: urls.b });
    expect(await verify("66.249.66.1", "Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
  });
  it("rejects a spoofed IP claiming googlebot", async () => {
    const fetch = mockFetch({ [urls.g]: googleJson, [urls.b]: bingJson });
    const verify = createSearchCrawlerVerifier({ fetch, googlebotUrl: urls.g, bingbotUrl: urls.b });
    expect(await verify("8.8.8.8", "Googlebot")).toBe(false);
  });
  it("verifies Bingbot ranges for a bingbot UA", async () => {
    const fetch = mockFetch({ [urls.g]: googleJson, [urls.b]: bingJson });
    const verify = createSearchCrawlerVerifier({ fetch, googlebotUrl: urls.g, bingbotUrl: urls.b });
    expect(await verify("40.77.167.5", "Mozilla/5.0 (compatible; bingbot/2.0)")).toBe(true);
  });
  it("returns false for a non-crawler UA without fetching", async () => {
    const fetch = mockFetch({});
    const verify = createSearchCrawlerVerifier({ fetch, googlebotUrl: urls.g, bingbotUrl: urls.b });
    expect(await verify("66.249.66.1", "Mozilla/5.0 (Chrome)")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed when the fetch throws", async () => {
    const fetch = vi.fn(async () => { throw new Error("net"); }) as unknown as typeof fetch;
    const verify = createSearchCrawlerVerifier({ fetch, googlebotUrl: urls.g, bingbotUrl: urls.b });
    expect(await verify("66.249.66.1", "Googlebot")).toBe(false);
  });
  it("caches the range list within the TTL (one fetch per provider)", async () => {
    const fetch = mockFetch({ [urls.g]: googleJson, [urls.b]: bingJson });
    const verify = createSearchCrawlerVerifier({ fetch, googlebotUrl: urls.g, bingbotUrl: urls.b, cacheTtlMs: 1000, now: () => 0 });
    await verify("66.249.66.1", "Googlebot");
    await verify("66.249.66.2", "Googlebot");
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });
});
