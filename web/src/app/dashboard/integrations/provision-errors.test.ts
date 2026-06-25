import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { provisionErrorMessage } from "./provision-errors.js";

describe("provisionErrorMessage", () => {
  it("maps verify_failed to an actionable message", () => {
    assert.match(provisionErrorMessage("verify_failed"), /file|match/i);
  });
  it("maps expired", () => assert.match(provisionErrorMessage("expired"), /expired|restart/i));
  it("maps domain_conflict", () => assert.match(provisionErrorMessage("domain_conflict"), /another account/i));
  it("maps invalid_site", () => assert.match(provisionErrorMessage("invalid_site"), /valid|public/i));
  it("maps unknown_nonce", () => assert.match(provisionErrorMessage("unknown_nonce"), /no longer valid|restart|fresh/i));
  it("maps rate_limited", () => assert.match(provisionErrorMessage("rate_limited"), /too many|wait/i));
  it("has a generic fallback for unknown codes", () => {
    assert.ok(provisionErrorMessage("something_else").length > 0);
  });
});
