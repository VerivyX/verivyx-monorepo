import type { VxConfig, BotSignal, ChallengeResponse, VerifyResponse, PaymentRequirementsResponse } from './types';
import { solvePoW } from './pow';
import { collectFingerprint } from './fingerprint';
import { saveSession } from './session';
import { hydrateInject, showRetry } from './hydrate';
import { showOverlay, hideOverlay, renderPaymentPanel } from './overlay';

// HUMAN: silent PoW → verify-human → issue session → hydrate + inject the body.
export async function runHumanVerification(cfg: VxConfig): Promise<void> {
  const chalRes = await fetch(`${cfg.api}/api/v1/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: cfg.domain, slug: cfg.slug }),
  });
  if (!chalRes.ok) throw new Error('challenge_failed');
  const chal = (await chalRes.json()) as ChallengeResponse;

  const [pow, fingerprint] = await Promise.all([
    solvePoW(chal.challenge, chal.salt, chal.difficulty),
    collectFingerprint(),
  ]);

  const verRes = await fetch(`${cfg.api}/api/v1/auth/verify-human`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challenge: chal.challenge,
      nonce: pow.nonce,
      fingerprint,
      powDurationMs: Math.max(0, Math.round(pow.durationMs)),
    }),
  });
  if (!verRes.ok) throw new Error('verify_failed');
  const ver = (await verRes.json()) as VerifyResponse;

  saveSession(cfg.domain, ver.sessionToken, ver.ttlSeconds);
  if (!(await hydrateInject(cfg, { Authorization: 'Bearer ' + ver.sessionToken }))) showRetry();
  window.dispatchEvent(new CustomEvent('vx:access', {
    detail: { domain: cfg.domain, token: ver.sessionToken, method: 'human' },
  }));
}

// BOT / AI: show the x402 payment overlay and poll until paid, then inject the body.
export async function runBotFlow(cfg: VxConfig, signals: BotSignal[]): Promise<void> {
  void signals; // reserved for future server-side telemetry

  let priceUsdc = '0.0050';
  let network = 'stellar:testnet';
  try {
    const reqRes = await fetch(
      `${cfg.api}/api/v1/payment/requirements?domain=${encodeURIComponent(cfg.domain)}&slug=${encodeURIComponent(cfg.slug)}`,
    );
    if (reqRes.ok || reqRes.status === 402) {
      const data = (await reqRes.json()) as PaymentRequirementsResponse;
      const req = data?.accepts?.[0];
      if (req) {
        priceUsdc = (Number(req.amount) / 1e7).toFixed(4);
        network = req.network;
      }
    }
  } catch { /* use defaults */ }

  showOverlay(renderPaymentPanel(cfg, priceUsdc, network));

  const startTime = Date.now();
  const poll = setInterval(async () => {
    if (Date.now() - startTime > 10 * 60 * 1000) { clearInterval(poll); return; }
    try {
      const res = await fetch(`${cfg.api}/api/v1/content/hydrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: cfg.domain, slug: cfg.slug }),
      });
      if (res.ok) {
        clearInterval(poll);
        hideOverlay();
        if (!(await hydrateInject(cfg, {}))) showRetry();
        window.dispatchEvent(new CustomEvent('vx:access', {
          detail: { domain: cfg.domain, token: null, method: 'paid_agent' },
        }));
      }
    } catch { /* keep polling */ }
  }, 2000);
}
