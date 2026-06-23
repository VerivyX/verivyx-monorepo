/**
 * settle.ts — adapter-agnostic post-response settlement helper.
 *
 * Settlement itself happens server-side inside `client.authorize` (the
 * hydration authorize-only endpoint verifies the x402 proof AND settles the
 * payment on-chain).  This module does NOT re-settle.  Its sole job is to take
 * the application handler's `Response` together with the `paymentResponse`
 * string returned by `authorize`, and return a `Response` that carries the
 * x402 `PAYMENT-RESPONSE` header so the paying caller receives its settlement
 * receipt.
 *
 * The Next.js `after()` post-response hook (deferring settlement until after
 * the body is flushed) is an ADAPTER concern handled in Milestone 3; here we
 * keep a tiny, runtime-agnostic helper that works in any Fetch-API runtime.
 *
 * Headers are cloned (never mutated in place on the original response) so the
 * helper is side-effect free with respect to its input.
 */

/**
 * Attach the x402 `PAYMENT-RESPONSE` settlement receipt header to a handler
 * response.
 *
 * @param res             - The application handler's response (unmodified).
 * @param paymentResponse - The settlement receipt string returned by
 *                          `client.authorize`.  When `undefined`, the original
 *                          response is returned unchanged.
 * @returns A new `Response` with the same status, body and headers plus the
 *          `PAYMENT-RESPONSE` header (when a receipt is present).
 */
export function attachPaymentResponse(
  res: Response,
  paymentResponse?: string,
): Response {
  if (paymentResponse === undefined) {
    return res;
  }

  // Clone headers so the original response object is never mutated.
  const headers = new Headers(res.headers);
  headers.set("PAYMENT-RESPONSE", paymentResponse);

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
