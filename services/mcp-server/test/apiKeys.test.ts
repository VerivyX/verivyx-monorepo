import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { parseApiKeys, matchApiKey } from "../src/apiKeys.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("parseApiKeys: labelled hash entry", () => {
  const entries = parseApiKeys("playground:" + sha("k1"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, "playground");
  assert.equal(entries[0].sha256, sha("k1"));
});

test("parseApiKeys: plaintext entry gets auto-label and is hashed", () => {
  const entries = parseApiKeys("rawsecret");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, "key1");
  assert.equal(entries[0].sha256, sha("rawsecret"));
});

test("matchApiKey: returns label on match", () => {
  const entries = parseApiKeys("playground:" + sha("k1") + ",admin:" + sha("k2"));
  assert.equal(matchApiKey("k2", entries), "admin");
});

test("matchApiKey: returns null on no match", () => {
  const entries = parseApiKeys("playground:" + sha("k1") + ",admin:" + sha("k2"));
  assert.equal(matchApiKey("nope", entries), null);
});
