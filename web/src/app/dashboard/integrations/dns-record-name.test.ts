import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { dnsRecordName } from "./dns-record-name.js";
describe("dnsRecordName", () => {
  it("subdomain -> label before the root", () => {
    assert.deepEqual(dnsRecordName("web-test.verivyx.com"), { host: "web-test.verivyx.com", name: "web-test" });
  });
  it("apex -> @", () => {
    assert.deepEqual(dnsRecordName("example.com"), { host: "example.com", name: "@" });
  });
  it("deep subdomain -> multi-label name", () => {
    assert.deepEqual(dnsRecordName("a.b.example.com"), { host: "a.b.example.com", name: "a.b" });
  });
});
