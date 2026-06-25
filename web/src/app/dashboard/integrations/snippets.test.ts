import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { snippetFor, FRAMEWORKS, envBlock } from "./snippets.js";

describe("snippetFor", () => {
  it("covers all three frameworks", () => assert.deepEqual(FRAMEWORKS, ["next", "express", "hono"]));
  it("next snippet uses the next package + vx.protect", () => {
    const s = snippetFor("next", "example.com");
    assert.equal(s.install, "npm i @verivyx/paywall-next");
    assert.match(s.code, /verivyxNext/);
    assert.match(s.code, /vx\.protect/);
  });
  it("express snippet uses the express package", () => {
    assert.equal(snippetFor("express", "x.com").install, "npm i @verivyx/paywall-express");
    assert.match(snippetFor("express", "x.com").code, /verivyxExpress/);
  });
  it("hono snippet uses the hono package", () => {
    assert.equal(snippetFor("hono", "x.com").install, "npm i @verivyx/paywall-hono");
    assert.match(snippetFor("hono", "x.com").code, /verivyxHono/);
  });
  it("envBlock includes the domain", () => {
    const e = envBlock("example.com");
    assert.match(e, /VERIVYX_TOKEN=/);
    assert.match(e, /VERIVYX_DOMAIN=example\.com/);
  });
});
