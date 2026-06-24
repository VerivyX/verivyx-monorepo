import { describe, it, expect } from "vitest";
import { rslLinkHeader, rslLinkTag, rslRobotsBlock, contentUsageHeader } from "../src/discovery.js";

const base = { licenseUrl: "https://example.com/license.xml" };

describe("contentUsageHeader", () => {
  it("defaults to train-ai=n, search=y", () => {
    expect(contentUsageHeader(base)).toBe("train-ai=n, search=y");
  });
  it("honours overrides", () => {
    expect(contentUsageHeader({ ...base, trainAi: "y", search: "n" })).toBe("train-ai=y, search=n");
  });
});
describe("rslLinkHeader", () => {
  it("emits an RFC 8288 Link with rel=license", () => {
    expect(rslLinkHeader(base)).toBe('<https://example.com/license.xml>; rel="license"');
  });
  it("appends a payment link when paymentUrl is set", () => {
    expect(rslLinkHeader({ ...base, paymentUrl: "https://api.verivyx.com/api/v1/payment/requirements" }))
      .toBe('<https://example.com/license.xml>; rel="license", <https://api.verivyx.com/api/v1/payment/requirements>; rel="payment"');
  });
});
describe("rslLinkTag", () => {
  it("emits an HTML link tag with the href attribute-escaped", () => {
    expect(rslLinkTag(base)).toBe('<link rel="license" href="https://example.com/license.xml">');
  });
  it("escapes a quote/angle in the url", () => {
    const t = rslLinkTag({ licenseUrl: 'https://x.com/a"b' });
    expect(t).not.toContain('a"b');
    expect(t).toContain("a&quot;b");
  });
});
describe("rslRobotsBlock", () => {
  it("emits the License directive + Content-Usage line", () => {
    expect(rslRobotsBlock(base)).toBe("License: https://example.com/license.xml\nContent-Usage: train-ai=n, search=y");
  });
});
