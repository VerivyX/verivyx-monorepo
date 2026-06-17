/**
 * gate.min.js — Verivyx embed script (entry / orchestration).
 *
 * Drop-in (one line, same for every creator):
 *   <script src="https://api.verivyx.com/gate.min.js"
 *           data-domain="yourdomain.com"
 *           data-api="https://api.verivyx.com"
 *           async></script>
 *
 * Flow: returning session → hydrate+inject · bot-score → BOT (overlay+poll) or
 * HUMAN (silent PoW → verify → hydrate+inject). Fail-closed: never reveal a body
 * that the server did not authorize. Logic lives in focused modules; this file
 * only wires them together. esbuild (format: iife) wraps the bundle.
 */
import type { VxConfig } from './types';
import { getSession, clearSession } from './session';
import { calcBotScore } from './detect';
import { showOverlay, hideOverlay, renderVerifyingPanel, renderErrorPanel } from './overlay';
import { showRetry } from './hydrate';
import { runHumanVerification, runBotFlow } from './flows';

// Valid only during synchronous script execution — null after the first async boundary.
const _script = document.currentScript as HTMLScriptElement | null;

async function init(): Promise<void> {
  const domain = _script?.dataset?.domain?.trim();
  const apiRaw = _script?.dataset?.api?.trim();
  if (!domain || !apiRaw) {
    showRetry();
    return;
  }
  const api = apiRaw.replace(/\/$/, '');
  const slug = (location.pathname.replace(/^\//, '').split('/')[0] || '').trim() || 'index';
  const cfg: VxConfig = { domain, api, slug };

  // Returning session — hydrate with the stored token; inject on success.
  const existingToken = getSession(domain);
  if (existingToken) {
    try {
      const r = await fetch(`${api}/api/v1/content/hydrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${existingToken}` },
        body: JSON.stringify({ domain, slug }),
      });
      if (r.ok) {
        const data = (await r.json()) as { html?: string };
        const target = document.getElementById('vx-article');
        if (target && typeof data.html === 'string' && data.html !== '') {
          target.innerHTML = data.html;
          return;
        }
        showRetry(); // authorized but no body — fail closed
        return;
      }
      clearSession(domain); // token rejected — clear and re-verify below
    } catch {
      showRetry(); // network error — no body to reveal; fail closed
      return;
    }
  }

  const { score, signals } = calcBotScore();
  const isBot = score >= 50;

  if (isBot) {
    runBotFlow(cfg, signals).catch(() => {
      showOverlay(renderErrorPanel('Could not load payment information. Please retry.'));
    });
  } else {
    showOverlay(renderVerifyingPanel());
    runHumanVerification(cfg)
      .then(() => hideOverlay())
      .catch(() => {
        hideOverlay();
        runBotFlow(cfg, [{ name: 'verify_failed', score: 0 }]).catch(() => {
          showRetry();
          showOverlay(renderErrorPanel('Could not complete verification. Please reload.'));
        });
      });
  }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  void init();
} else {
  document.addEventListener('DOMContentLoaded', () => void init());
}
