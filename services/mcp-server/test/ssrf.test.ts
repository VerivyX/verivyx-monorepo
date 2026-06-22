import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedIp, assertPublicHttpsUrl } from "../src/ssrf.js";

// ---- isBlockedIp ----

test("blocks loopback IPv4", () => assert.equal(isBlockedIp("127.0.0.1"), true));
test("blocks IPv4 link-local metadata (169.254.x.x)", () => assert.equal(isBlockedIp("169.254.169.254"), true));
test("blocks RFC-1918 10.x.x.x", () => assert.equal(isBlockedIp("10.0.0.1"), true));
test("blocks RFC-1918 172.16.x.x", () => assert.equal(isBlockedIp("172.16.0.1"), true));
test("blocks RFC-1918 192.168.x.x", () => assert.equal(isBlockedIp("192.168.1.1"), true));
test("blocks IPv6 loopback ::1", () => assert.equal(isBlockedIp("::1"), true));
test("blocks IPv6 ULA fc00::1", () => assert.equal(isBlockedIp("fc00::1"), true));
test("blocks IPv6 link-local fe80::1", () => assert.equal(isBlockedIp("fe80::1"), true));
test("blocks unspecified 0.0.0.0", () => assert.equal(isBlockedIp("0.0.0.0"), true));

test("allows public 8.8.8.8", () => assert.equal(isBlockedIp("8.8.8.8"), false));
test("allows public 1.1.1.1", () => assert.equal(isBlockedIp("1.1.1.1"), false));

// 172.16.0.0/12 boundary checks
test("blocks 172.31.255.255 (top of 172.16/12)", () => assert.equal(isBlockedIp("172.31.255.255"), true));
test("allows 172.15.255.255 (just below 172.16/12)", () => assert.equal(isBlockedIp("172.15.255.255"), false));

// IPv4-mapped IPv6 literal with dotted-quad tail
test("blocks ::ffff:10.0.0.1 (mapped private)", () => assert.equal(isBlockedIp("::ffff:10.0.0.1"), true));

// ---- assertPublicHttpsUrl ----

test("rejects http:// scheme", async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl("http://example.com", async () => ["8.8.8.8"]),
    /https/i,
  );
});

test("rejects when DNS resolves to private IP", async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl("https://example.com", async () => ["10.0.0.5"]),
    /private|blocked|ssrf/i,
  );
});

test("passes for public HTTPS with public IP", async () => {
  await assert.doesNotReject(
    () => assertPublicHttpsUrl("https://example.com", async () => ["8.8.8.8"]),
  );
});
