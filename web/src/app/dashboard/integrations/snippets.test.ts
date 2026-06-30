import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { snippetFor, FRAMEWORKS } from "./snippets.js";

describe("snippetFor", () => {
  it("covers all three frameworks", () => assert.deepEqual(FRAMEWORKS, ["next", "express", "hono"]));
  it("next snippet uses the next package + verivyxProxy with the token inlined", () => {
    const s = snippetFor("next", "vx_test_token");
    assert.equal(s.install, "npm i @verivyx/paywall-next");
    assert.match(s.code, /verivyxProxy/);
    assert.match(s.code, /token: "vx_test_token"/);
  });
  it("express snippet uses the express package + verivyxMiddleware", () => {
    const s = snippetFor("express", "vx_test_token");
    assert.equal(s.install, "npm i @verivyx/paywall-express");
    assert.match(s.code, /verivyxMiddleware/);
    assert.match(s.code, /token: "vx_test_token"/);
  });
  it("hono snippet uses the hono package + verivyxHonoMiddleware", () => {
    const s = snippetFor("hono", "vx_test_token");
    assert.equal(s.install, "npm i @verivyx/paywall-hono");
    assert.match(s.code, /verivyxHonoMiddleware/);
    assert.match(s.code, /token: "vx_test_token"/);
  });
  it("falls back to a placeholder token when none is provided", () => {
    assert.match(snippetFor("next", "").code, /token: "vx_live_/);
  });
});
