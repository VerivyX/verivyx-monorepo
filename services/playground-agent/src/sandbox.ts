import { config } from "./config.js";

// The agent's payment tool may only ever fetch the demo resource. This blocks
// prompt-injection or a misbehaving model from paying arbitrary x402 services.
export function assertAllowedUrl(url: string): void {
  let ok = false;
  try {
    // basic URL validity
    new URL(url);
    ok = config.allowedPaymentPrefixes.some((p) => url.startsWith(p));
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      `Sandbox: this playground can only pay the demo resource. Refused URL: ${url}`,
    );
  }
}
