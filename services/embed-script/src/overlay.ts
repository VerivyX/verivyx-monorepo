import type { VxConfig } from './types';

// Full-screen blurred overlay + panel templates shown to paying agents / during
// verification. Owns its own DOM element state.

const OVERLAY_STYLES = `
  #vx-gate {
    position: fixed; inset: 0; z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    background: rgba(0,0,0,0.65);
    opacity: 0; transition: opacity 0.3s ease;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #vx-gate.vx-visible { opacity: 1; }
  .vx-panel {
    background: rgba(255,255,255,0.07); backdrop-filter: blur(24px);
    border: 1px solid rgba(255,255,255,0.13); border-radius: 18px;
    padding: 36px 32px; max-width: 420px; width: 90%;
    color: #fff; text-align: center;
  }
  .vx-panel h2 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
  .vx-panel p  { margin: 0 0 20px; font-size: 14px; opacity: 0.7; line-height: 1.6; }
  .vx-row {
    display: flex; justify-content: space-between; padding: 10px 0;
    border-bottom: 1px solid rgba(255,255,255,0.09); font-size: 14px;
  }
  .vx-row:last-of-type { border-bottom: none; }
  .vx-label { opacity: 0.55; }
  .vx-value  { font-weight: 500; font-family: monospace; }
  .vx-url {
    margin-top: 20px; padding: 12px; background: rgba(0,0,0,0.3);
    border-radius: 8px; font-family: monospace; font-size: 11px;
    word-break: break-all; text-align: left; opacity: 0.75;
  }
  .vx-badge {
    display: inline-block; padding: 4px 10px; border-radius: 20px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.5px;
    background: rgba(99,102,241,0.25); border: 1px solid rgba(99,102,241,0.45);
    margin-bottom: 16px; text-transform: uppercase;
  }
  .vx-spinner {
    width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.2);
    border-top-color: #fff; border-radius: 50%;
    animation: vx-spin 0.8s linear infinite; margin: 0 auto 12px;
  }
  @keyframes vx-spin { to { transform: rotate(360deg); } }
`;

export function renderPaymentPanel(cfg: VxConfig, priceUsdc: string, network: string): string {
  const reqUrl = `${cfg.api}/api/v1/payment/requirements?domain=${encodeURIComponent(cfg.domain)}&slug=${encodeURIComponent(cfg.slug)}`;
  return `
    <div class="vx-panel">
      <div class="vx-badge">&#9889; X402 Protocol</div>
      <h2>AI Agent Access Required</h2>
      <p>This content is monetized. Pay once with USDC, access for 1 hour.</p>
      <div class="vx-row"><span class="vx-label">Price</span><span class="vx-value">${priceUsdc} USDC</span></div>
      <div class="vx-row"><span class="vx-label">Network</span><span class="vx-value">${network}</span></div>
      <div class="vx-row"><span class="vx-label">Session</span><span class="vx-value">1 hour</span></div>
      <div class="vx-url">GET ${reqUrl}</div>
    </div>`;
}

export function renderVerifyingPanel(): string {
  return `
    <div class="vx-panel">
      <div class="vx-spinner"></div>
      <p style="margin:0;opacity:0.6;font-size:13px">Verifying access…</p>
    </div>`;
}

export function renderErrorPanel(message: string): string {
  return `
    <div class="vx-panel">
      <h2>Verification Error</h2>
      <p>${message}</p>
    </div>`;
}

let _overlayEl: HTMLDivElement | null = null;

function ensureStyles(): void {
  if (document.getElementById('vx-gate-styles')) return;
  const style = document.createElement('style');
  style.id = 'vx-gate-styles';
  style.textContent = OVERLAY_STYLES;
  (document.head || document.documentElement).appendChild(style);
}

export function showOverlay(content: string): void {
  ensureStyles();
  if (!_overlayEl) {
    _overlayEl = document.createElement('div');
    _overlayEl.id = 'vx-gate';
    (document.body || document.documentElement).appendChild(_overlayEl);
  }
  _overlayEl.innerHTML = content;
  requestAnimationFrame(() => {
    if (_overlayEl) _overlayEl.classList.add('vx-visible');
  });
}

export function hideOverlay(): void {
  if (!_overlayEl) return;
  _overlayEl.classList.remove('vx-visible');
  setTimeout(() => {
    _overlayEl?.remove();
    _overlayEl = null;
  }, 300);
}
