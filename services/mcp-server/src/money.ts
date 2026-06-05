/**
 * Money helpers — integer/string arithmetic only, never floating point.
 * USDC amounts are atomic units; do not cast to float.
 */

/** Convert an atomic amount string to a human decimal string for the given decimals. */
export function atomsToDecimalString(atoms: string, decimals: number): string {
  const negative = atoms.startsWith("-");
  const digits = (negative ? atoms.slice(1) : atoms).replace(/^0+(?=\d)/, "");
  const padded = digits.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals) || "0";
  const fracPart = decimals > 0 ? padded.slice(padded.length - decimals).replace(/0+$/, "") : "";
  const value = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${value}` : value;
}

/** Convert a human decimal string to atomic base units (bigint) for the given decimals. */
export function decimalToBaseUnits(value: string, decimals: number): bigint {
  const [intPart, fracPart = ""] = value.split(".");
  const padded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** Add two non-negative decimal strings exactly. */
export function addDecimalStrings(a: string, b: string): string {
  const decimals = Math.max(fractionLength(a), fractionLength(b));
  const scale = 10n ** BigInt(decimals);
  return formatScaled(toScaled(a, decimals) + toScaled(b, decimals), scale, decimals);
}

function fractionLength(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

function toScaled(value: string, decimals: number): bigint {
  const [intPart, fracPart = ""] = value.split(".");
  const padded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

function formatScaled(scaled: bigint, scale: bigint, decimals: number): string {
  const intPart = scaled / scale;
  const fracPart = (scaled % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : `${intPart}`;
}
