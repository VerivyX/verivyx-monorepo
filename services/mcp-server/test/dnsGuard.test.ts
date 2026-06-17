import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRequestOrigin } from "../src/dnsGuard.js";

const HOSTS = ["mcp.verivyx.com", "mcp-server:8088"];
const ORIGINS = ["https://mcp.verivyx.com", "https://verivyx.com"];

test("allows an allowlisted host with no Origin (typical agent request)", () => {
  assert.deepEqual(checkRequestOrigin("mcp.verivyx.com", undefined, HOSTS, ORIGINS), { ok: true });
  assert.deepEqual(checkRequestOrigin("mcp-server:8088", undefined, HOSTS, ORIGINS), { ok: true });
});

test("rejects a non-allowlisted Host (DNS-rebinding attempt)", () => {
  assert.deepEqual(checkRequestOrigin("attacker.example", undefined, HOSTS, ORIGINS), {
    ok: false,
    reason: "host_not_allowed",
  });
  assert.deepEqual(checkRequestOrigin(undefined, undefined, HOSTS, ORIGINS), {
    ok: false,
    reason: "host_not_allowed",
  });
});

test("rejects a disallowed Origin even when the Host is allowed", () => {
  assert.deepEqual(checkRequestOrigin("mcp.verivyx.com", "https://evil.example", HOSTS, ORIGINS), {
    ok: false,
    reason: "origin_not_allowed",
  });
});

test("allows an allowlisted Origin, case-insensitively", () => {
  assert.deepEqual(checkRequestOrigin("MCP.verivyx.com", "https://verivyx.com", HOSTS, ORIGINS), { ok: true });
});

test('"*" disables a check', () => {
  assert.deepEqual(checkRequestOrigin("anything.example", undefined, ["*"], ORIGINS), { ok: true });
  assert.deepEqual(checkRequestOrigin("mcp.verivyx.com", "https://evil.example", HOSTS, ["*"]), { ok: true });
});

test("empty allowlists disable their checks", () => {
  assert.deepEqual(checkRequestOrigin("anything.example", "https://anything.example", [], []), { ok: true });
});
