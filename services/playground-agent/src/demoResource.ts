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

// x402-protected demo resource. Thin wrapper over the production hydration path:
// no payment → relay the 402 + requirements; with payment → settle then serve content.
export async function demoResource(req: Request, res: Response): Promise<void> {
  const slug = req.params.slug || config.demoSlug;
  const xPayment = req.header("PAYMENT-SIGNATURE") || req.header("X-Payment") || "";

  let r: globalThis.Response;
  try {
    r = await fetch(`${config.hydrationUrl}/api/v1/content/hydrate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(xPayment ? { "PAYMENT-SIGNATURE": xPayment, "X-Payment": xPayment } : {}),
      },
      body: JSON.stringify({ domain: config.demoDomain, slug }),
    });
  } catch (e) {
    res.status(502).json({ error: "hydration_unreachable", detail: e instanceof Error ? e.message : "" });
    return;
  }

  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, X-Payment-Required, PAYMENT-RESPONSE");

  if (r.status === 402) {
    const body = await r.text();
    const pr = r.headers.get("payment-required");
    const xpr = r.headers.get("x-payment-required");
    if (pr) res.setHeader("PAYMENT-REQUIRED", pr);
    if (xpr) res.setHeader("X-Payment-Required", xpr);
    res.status(402).type("application/json").send(body);
    return;
  }

  if (r.ok) {
    const paymentResponse = r.headers.get("payment-response");
    if (paymentResponse) res.setHeader("PAYMENT-RESPONSE", paymentResponse);
    res.status(200).type("text/markdown").send(PREMIUM_CONTENT);
    return;
  }

  const detail = await r.text().catch(() => "");
  res.status(502).json({ error: "demo_settle_failed", status: r.status, detail: detail.slice(0, 300) });
}
