import { resolveConfig, ConfigError } from "../src/config";
import { describe, it, expect } from "vitest";

describe("resolveConfig", () => {
  it("code arg wins over env", () => {
    const c = resolveConfig({ domain: "a.com", token: "t" }, { VERIVYX_DOMAIN: "b.com" });
    expect(c.domain).toBe("a.com");
    expect(c.apiBase).toBe("https://api.verivyx.com");
    expect(c.failMode).toBe("teaser");
    expect(c.timeoutMs).toBe(800);
  });

  it("throws without token", () => {
    expect(() => resolveConfig({ domain: "a.com" }, {})).toThrow(ConfigError);
  });

  it("reads env when no arg", () => {
    const c = resolveConfig(undefined, { VERIVYX_DOMAIN: "b.com", VERIVYX_TOKEN: "t", VERIVYX_MATCH: "/a/*,/b/*" });
    expect(c.domain).toBe("b.com");
    expect(c.match).toEqual(["/a/*", "/b/*"]);
  });

  it("throws ConfigError when VERIVYX_TIMEOUT_MS is non-numeric", () => {
    expect(() =>
      resolveConfig(
        { domain: "a.com", token: "t" },
        { VERIVYX_TIMEOUT_MS: "abc" },
      ),
    ).toThrow(ConfigError);
  });

  it("accepts a numeric VERIVYX_TIMEOUT_MS from env", () => {
    const c = resolveConfig(
      { domain: "a.com", token: "t" },
      { VERIVYX_TIMEOUT_MS: "1500" },
    );
    expect(c.timeoutMs).toBe(1500);
  });

  it("throws ConfigError when token is whitespace-only", () => {
    expect(() =>
      resolveConfig({ domain: "a.com", token: "   " }, {}),
    ).toThrow(ConfigError);
  });

  // --- settleTimeoutMs ---

  it("settleTimeoutMs defaults to 60000", () => {
    const c = resolveConfig({ domain: "a.com", token: "t" }, {});
    expect(c.settleTimeoutMs).toBe(60_000);
  });

  it("settleTimeoutMs reads from VERIVYX_SETTLE_TIMEOUT_MS env", () => {
    const c = resolveConfig(
      { domain: "a.com", token: "t" },
      { VERIVYX_SETTLE_TIMEOUT_MS: "90000" },
    );
    expect(c.settleTimeoutMs).toBe(90_000);
  });

  it("opts.settleTimeoutMs wins over env VERIVYX_SETTLE_TIMEOUT_MS", () => {
    const c = resolveConfig(
      { domain: "a.com", token: "t", settleTimeoutMs: 45_000 },
      { VERIVYX_SETTLE_TIMEOUT_MS: "90000" },
    );
    expect(c.settleTimeoutMs).toBe(45_000);
  });

  it("throws ConfigError when VERIVYX_SETTLE_TIMEOUT_MS is non-numeric", () => {
    expect(() =>
      resolveConfig(
        { domain: "a.com", token: "t" },
        { VERIVYX_SETTLE_TIMEOUT_MS: "not-a-number" },
      ),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError when VERIVYX_SETTLE_TIMEOUT_MS is zero", () => {
    expect(() =>
      resolveConfig(
        { domain: "a.com", token: "t" },
        { VERIVYX_SETTLE_TIMEOUT_MS: "0" },
      ),
    ).toThrow(ConfigError);
  });

  it("settleTimeoutMs is independent of timeoutMs", () => {
    const c = resolveConfig(
      { domain: "a.com", token: "t", timeoutMs: 500, settleTimeoutMs: 120_000 },
      {},
    );
    expect(c.timeoutMs).toBe(500);
    expect(c.settleTimeoutMs).toBe(120_000);
  });
});
