import assert from "node:assert/strict";
import { test } from "node:test";

import { rateLimit } from "../src/rateLimit.js";

test("rateLimit allows up to max within the window, then blocks", () => {
  const key = `t:${Math.random()}`;
  assert.equal(rateLimit(key, 3, 60_000), true);
  assert.equal(rateLimit(key, 3, 60_000), true);
  assert.equal(rateLimit(key, 3, 60_000), true);
  assert.equal(rateLimit(key, 3, 60_000), false, "4th hit over max=3 must be blocked");
});

test("rateLimit resets after the window elapses", async () => {
  const key = `t:${Math.random()}`;
  assert.equal(rateLimit(key, 1, 30), true);
  assert.equal(rateLimit(key, 1, 30), false, "2nd hit within window blocked");
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(rateLimit(key, 1, 30), true, "allowed again after window reset");
});

test("rateLimit keys are independent", () => {
  const a = `a:${Math.random()}`;
  const b = `b:${Math.random()}`;
  assert.equal(rateLimit(a, 1, 60_000), true);
  assert.equal(rateLimit(a, 1, 60_000), false);
  assert.equal(rateLimit(b, 1, 60_000), true, "different key has its own bucket");
});
