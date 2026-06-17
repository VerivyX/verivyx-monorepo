import type { Request, Response } from "express";
import { config } from "./config.js";

// The "premium" content the agent unlocks after paying. Markdown.
const PREMIUM_CONTENT = `# 🛰️ Verivyx Premium Brief — Unlocked

You just paid for this with an on-chain **testnet USDC** micropayment via the
**x402** protocol on Stellar. No subscription, no signup — the AI agent settled
a fraction of a cent and the paywall opened.

## How it worked
1. The agent requested this resource and got **HTTP 402 Payment Required**.
2. It signed a USDC transfer to the Verivyx paywall contract on Stellar.
3. Verivyx verified + settled on-chain, then **distribute()** split the payment
   between the creator and the platform — trustlessly.
4. The content was released.

This is how AI agents pay for content, data, and tools in the agent economy.
`;

// Decode an x402 payment header (base64 of the PaymentPayload JSON). Tolerates both
// standard and URL-safe base64, mirroring the hydration service.
function decodePaymentHeader(value: string): unknown {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = Buffer.from(normalized, "base64").toString("utf8");
  return JSON.parse(raw);
}

// x402-protected demo resource for the playground.
//
// Unlike a real creator site, the demo domain (playground.verivyx.com) has no origin
// website to hydrate a body from — the premium content lives here as a constant. So we
// talk to the gateway directly instead of the hydration service:
//   • no payment  → relay the gateway's 402 + payment requirements
//   • with payment → settle via the gateway's internal endpoint, then serve PREMIUM_CONTENT
export async function demoResource(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.slug || config.demoSlug);
  const xPayment = req.header("PAYMENT-SIGNATURE") || req.header("X-Payment") || "";

  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, X-Payment-Required, PAYMENT-RESPONSE");

  // --- Unpaid: relay the gateway's 402 + requirements ---------------------------------
  if (!xPayment) {
    let gr: globalThis.Response;
    try {
      const qs = `domain=${encodeURIComponent(config.demoDomain)}&slug=${encodeURIComponent(slug)}`;
      gr = await fetch(`${config.gatewayUrl}/api/v1/payment/requirements?${qs}`);
    } catch (e) {
      res.status(502).json({ error: "gateway_unreachable", detail: e instanceof Error ? e.message : "" });
      return;
    }
    const body = await gr.text();
    const pr = gr.headers.get("payment-required");
    const xpr = gr.headers.get("x-payment-required");
    if (pr) res.setHeader("PAYMENT-REQUIRED", pr);
    if (xpr) res.setHeader("X-Payment-Required", xpr);
    // The gateway returns 402 when the paywall is enabled (the demo always is).
    res.status(gr.status === 200 ? 402 : gr.status).type("application/json").send(body);
    return;
  }

  // --- Paid: settle via the gateway, then serve the premium content -------------------
  let xp: unknown;
  try {
    xp = decodePaymentHeader(xPayment);
  } catch {
    res.status(400).json({ error: "invalid_payment_header" });
    return;
  }

  let sr: globalThis.Response;
  try {
    sr = await fetch(`${config.gatewayUrl}/api/v1/payment/internal/x-payment-settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": config.internalToken },
      body: JSON.stringify({ domain: config.demoDomain, slug, agent: "playground", category: "demo", xPayment: xp }),
    });
  } catch (e) {
    res.status(502).json({ error: "gateway_unreachable", detail: e instanceof Error ? e.message : "" });
    return;
  }

  if (sr.ok) {
    const settle = await sr.text().catch(() => "");
    // Surface PAYMENT-RESPONSE (base64 of the settlement) for parity with production.
    if (settle) res.setHeader("PAYMENT-RESPONSE", Buffer.from(settle).toString("base64"));
    res.status(200).type("text/markdown").send(PREMIUM_CONTENT);
    return;
  }

  const detail = await sr.text().catch(() => "");
  res.status(502).json({ error: "demo_settle_failed", status: sr.status, detail: detail.slice(0, 300) });
}
