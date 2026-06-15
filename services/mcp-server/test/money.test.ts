import assert from "node:assert/strict";
import { test } from "node:test";
import { atomsToDecimalString, decimalToBaseUnits, addDecimalStrings } from "../src/money.js";

// USDC has 7 decimals on Stellar, 6 on EVM/Solana. The arithmetic must be exact
// (integer/string only) — any float rounding here loses real money.

test("atomsToDecimalString converts atomic USDC (7 decimals) exactly", () => {
  assert.equal(atomsToDecimalString("50000", 7), "0.005");
  assert.equal(atomsToDecimalString("10000000", 7), "1");
  assert.equal(atomsToDecimalString("1000", 7), "0.0001");
  assert.equal(atomsToDecimalString("0", 7), "0");
  assert.equal(atomsToDecimalString("12340000", 7), "1.234");
});

test("atomsToDecimalString handles 6-decimal assets and negatives", () => {
  assert.equal(atomsToDecimalString("1000000", 6), "1");
  assert.equal(atomsToDecimalString("123", 6), "0.000123");
  assert.equal(atomsToDecimalString("-50000", 7), "-0.005");
});

test("decimalToBaseUnits is the inverse of atomsToDecimalString", () => {
  assert.equal(decimalToBaseUnits("0.005", 7), 50000n);
  assert.equal(decimalToBaseUnits("1", 7), 10000000n);
  assert.equal(decimalToBaseUnits("0.0001", 7), 1000n);
  assert.equal(decimalToBaseUnits("0.001", 6), 1000n);
  // round-trip
  for (const a of ["50000", "1", "1000", "999999999"]) {
    assert.equal(decimalToBaseUnits(atomsToDecimalString(a, 7), 7).toString(), a.replace(/^0+(?=\d)/, ""));
  }
});

test("decimalToBaseUnits truncates beyond the supported precision", () => {
  // more fractional digits than decimals → extra digits dropped, not rounded
  assert.equal(decimalToBaseUnits("0.00012349", 7), 1234n);
});

test("addDecimalStrings adds exactly (the creator + fee split)", () => {
  assert.equal(addDecimalStrings("0.004", "0.001"), "0.005");
  assert.equal(addDecimalStrings("1.5", "2.25"), "3.75");
  assert.equal(addDecimalStrings("0", "0"), "0");
  assert.equal(addDecimalStrings("0.0000001", "0.0000002"), "0.0000003");
});
