import assert from "node:assert/strict";
import { test } from "node:test";

import { buildProtectedResourceMetadata, wwwAuthenticateValue } from "../src/oauth.js";

const RESOURCE_URI = "https://mcp.verivyx.com/mcp";
const ISSUER = "https://hydra.verivyx.com";
const PRM_URL = "https://mcp.verivyx.com/.well-known/oauth-protected-resource";

test("buildProtectedResourceMetadata: resource matches resourceUri", () => {
  const prm = buildProtectedResourceMetadata(RESOURCE_URI, ISSUER);
  assert.equal(prm.resource, RESOURCE_URI);
});

test("buildProtectedResourceMetadata: authorization_servers contains issuer", () => {
  const prm = buildProtectedResourceMetadata(RESOURCE_URI, ISSUER);
  assert.deepEqual(prm.authorization_servers, [ISSUER]);
});

test("buildProtectedResourceMetadata: bearer_methods_supported is [header]", () => {
  const prm = buildProtectedResourceMetadata(RESOURCE_URI, ISSUER);
  assert.deepEqual(prm.bearer_methods_supported, ["header"]);
});

test("wwwAuthenticateValue: starts with Bearer", () => {
  const value = wwwAuthenticateValue(PRM_URL);
  assert.match(value, /^Bearer /);
});

test("wwwAuthenticateValue: contains resource_metadata with the PRM URL", () => {
  const value = wwwAuthenticateValue(PRM_URL);
  assert.ok(
    value.includes(`resource_metadata="${PRM_URL}"`),
    `Expected resource_metadata="${PRM_URL}" in: ${value}`,
  );
});
