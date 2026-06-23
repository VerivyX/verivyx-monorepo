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
});
