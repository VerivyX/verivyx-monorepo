/**
 * gate.min.js — Verivyx embed script
 *
 * Drop-in (satu baris, berlaku untuk semua creator):
 *   <script src="https://api.verivyx.com/gate.min.js"
 *           data-domain="yourdomain.com"
 *           data-api="https://api.verivyx.com"
 *           async></script>
 *
 * Flow:
 *   1. Inject CSS hide-first — konten tersembunyi sebelum apapun terlihat
 *   2. Cek session (sessionStorage, domain-scoped)
 *   3. Score-based bot detection (10+ sinyal)
 *   4. Human  → PoW silent → verify → reveal (~300ms, tidak terasa)
 *   5. Bot/AI → overlay 402 + konten tetap hidden → poll sampai bayar → reveal
 */

(function () {
  'use strict';

  // ─── Capture currentScript synchronously ──────────────────────────────────
  // Hanya valid selama eksekusi script tag — null setelah async boundary.
  const _script = document.currentScript as HTMLScriptElement | null;

  // ─── Hide-First: inject segera sebelum apapun ────────────────────────────
  // Ini yang membuat AI browser tidak bisa baca konten sebelum verifikasi.
  const _hideStyle = document.createElement('style');
  _hideStyle.id = 'vx-hide';
  _hideStyle.textContent = 'html{visibility:hidden!important}#vx-gate,#vx-gate *{visibility:visible!important}';
  try { (document.head || document.documentElement).appendChild(_hideStyle); } catch { /* noop */ }

  function revealContent(): void {
    const el = document.getElementById('vx-hide');
    if (el) el.remove();
    document.documentElement.style.removeProperty('visibility');
  }

  // Safety: kalau script error atau timeout, jangan biarkan halaman blank selamanya.
  const _safetyReveal = setTimeout(revealContent, 4000);

  // ─── Interfaces ────────────────────────────────────────────────────────────

  interface VxConfig {
    domain: string;
    api: string;
    slug: string;
  }

  interface Fingerprint {
    webdriver: boolean;
    languages: string[];
    hardwareConcurrency: number;
    screenWidth: number;
    screenHeight: number;
    userAgent: string;
    webglVendor: string | null;
    webglRenderer: string | null;
    mouseMoved: boolean;
  }

  interface ChallengeResponse {
    challenge: string;
    salt: string;
    difficulty: number;
    ttlSeconds: number;
    powSalt?: string;
  }

  interface VerifyResponse {
    sessionToken: string;
    ttlSeconds: number;
  }

  interface PaymentRequirement {
    amount: string | number;
    network: string;
  }

  interface PaymentRequirementsResponse {
    accepts?: PaymentRequirement[];
  }

  // ─── Session Management (sessionStorage, domain-scoped) ───────────────────
  // sessionStorage: bertahan selama tab aktif, hilang saat tab ditutup.
  // Tidak ke localStorage/cookie — sesuai security model.

  const SESSION_PREFIX = 'vx_s_';

  function getSession(domain: string): string | null {
    try {
      const raw = sessionStorage.getItem(SESSION_PREFIX + domain);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { token: string; expiresAt: number };
      if (Date.now() > parsed.expiresAt) {
        sessionStorage.removeItem(SESSION_PREFIX + domain);
        return null;
      }
      return parsed.token;
    } catch {
      return null;
    }
  }

  function saveSession(domain: string, token: string, ttlSeconds: number): void {
    try {
      sessionStorage.setItem(
        SESSION_PREFIX + domain,
        JSON.stringify({ token, expiresAt: Date.now() + ttlSeconds * 1000 }),
      );
    } catch {
      /* sessionStorage mungkin diblokir (private mode ketat) — tidak fatal */
    }
    // Also set a cookie so the WordPress plugin can verify the session server-side.
    // SameSite=Lax: sent on same-site navigation, not cross-site requests.
    try {
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `vx_session=${token}; path=/; SameSite=Lax${secure}; max-age=${ttlSeconds}`;
    } catch {
      /* cookie mungkin diblokir (iframe sandboxed) — tidak fatal */
    }
  }

  // ─── Bot Score Detection ───────────────────────────────────────────────────
  // Score-based, synchronous, berjalan < 5ms.
  // Score >= 50 → BOT path. Score < 50 → HUMAN path.

  interface BotSignal {
    name: string;
    score: number;
  }

  function calcBotScore(): { score: number; signals: BotSignal[] } {
    const signals: BotSignal[] = [];
    let score = 0;

    function add(name: string, points: number): void {
      signals.push({ name, score: points });
      score += points;
    }

    try {
      const nav = navigator as Navigator & {
        webdriver?: boolean;
        plugins?: PluginArray;
      };
      const ua = navigator.userAgent.toLowerCase();
      const win = window as Window & {
        chrome?: unknown;
        _phantom?: unknown;
        __nightmare?: unknown;
        callPhantom?: unknown;
      };

      // ── Hard signals (100 pts = langsung BOT) ────────────────────────────
      if (nav.webdriver === true)
        add('webdriver', 100);

      const botUAs = [
        'googlebot', 'bingbot', 'slurp', 'crawl', 'spider',
        'bot/', 'headless', 'python-requests', 'python-urllib',
        'go-http-client', 'libwww-perl', 'curl/', 'wget/',
        'scrapy', 'httpclient', 'apache-httpclient',
      ];
      if (botUAs.some((b) => ua.includes(b)))
        add('bot_ua', 100);

      if (typeof win._phantom !== 'undefined' || typeof win.callPhantom !== 'undefined')
        add('phantom', 100);

      if (typeof win.__nightmare !== 'undefined')
        add('nightmare', 100);

      // ── Strong signals (30-50 pts) ────────────────────────────────────
      if (!navigator.languages || navigator.languages.length === 0)
        add('no_languages', 40);

      // Chrome UA tapi tidak ada window.chrome — Puppeteer/headless Chrome
      if (ua.includes('chrome') && !ua.includes('edge') && !ua.includes('opr') && !win.chrome)
        add('chrome_no_runtime', 45);

      if (navigator.plugins && navigator.plugins.length === 0 && !ua.includes('firefox'))
        add('no_plugins', 30);

      if (navigator.hardwareConcurrency === 0)
        add('no_cpu_cores', 30);

      // ── Medium signals (10-25 pts) ───────────────────────────────────
      // Headless default screen dimensions
      if (
        (screen.width === 800 && screen.height === 600) ||
        (screen.width === 1280 && screen.height === 720 && window.devicePixelRatio === 1)
      ) add('headless_screen', 25);

      // Outer == inner → tidak ada browser chrome (toolbar, dll)
      if (
        window.outerWidth > 0 &&
        window.outerHeight > 0 &&
        window.outerWidth === window.innerWidth &&
        window.outerHeight === window.innerHeight
      ) add('no_browser_chrome', 20);

      // Permissions API: headless Chrome mengembalikan nilai yang tidak wajar
      try {
        // Tidak async — hanya cek keberadaan API
        if (typeof navigator.permissions === 'undefined')
          add('no_permissions_api', 15);
      } catch { /* noop */ }

      // Connection: bots sering tidak punya NetworkInformation
      if (!(navigator as Navigator & { connection?: unknown }).connection)
        add('no_network_info', 10);

    } catch {
      /* browser bisa restrict — tidak fatal */
    }

    return { score, signals };
  }

  // ─── Overlay Styles ────────────────────────────────────────────────────────

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

  // ─── Panel Templates ───────────────────────────────────────────────────────

  function renderPaymentPanel(cfg: VxConfig, priceUsdc: string, network: string): string {
    const reqUrl = `${cfg.api}/api/v1/payment/requirements?domain=${encodeURIComponent(cfg.domain)}&slug=${encodeURIComponent(cfg.slug)}`;
    return `
      <div class="vx-panel">
        <div class="vx-badge">&#9889; X402 Protocol</div>
        <h2>AI Agent Access Required</h2>
        <p>This content is monetized. Pay once with USDC, access for 1 hour.</p>
        <div class="vx-row">
          <span class="vx-label">Price</span>
          <span class="vx-value">${priceUsdc} USDC</span>
        </div>
        <div class="vx-row">
          <span class="vx-label">Network</span>
          <span class="vx-value">${network}</span>
        </div>
        <div class="vx-row">
          <span class="vx-label">Session</span>
          <span class="vx-value">1 hour</span>
        </div>
        <div class="vx-url">GET ${reqUrl}</div>
      </div>`;
  }

  function renderVerifyingPanel(): string {
    return `
      <div class="vx-panel">
        <div class="vx-spinner"></div>
        <p style="margin:0;opacity:0.6;font-size:13px">Verifying access…</p>
      </div>`;
  }

  function renderErrorPanel(message: string): string {
    return `
      <div class="vx-panel">
        <h2>Verification Error</h2>
        <p>${message}</p>
      </div>`;
  }

  // ─── Overlay Helpers ───────────────────────────────────────────────────────

  let _overlayEl: HTMLDivElement | null = null;

  function ensureStyles(): void {
    if (document.getElementById('vx-gate-styles')) return;
    const style = document.createElement('style');
    style.id = 'vx-gate-styles';
    style.textContent = OVERLAY_STYLES;
    (document.head || document.documentElement).appendChild(style);
  }

  function showOverlay(content: string): void {
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

  function hideOverlay(): void {
    if (!_overlayEl) return;
    _overlayEl.classList.remove('vx-visible');
    setTimeout(() => {
      _overlayEl?.remove();
      _overlayEl = null;
    }, 300);
  }

  // ─── Fingerprint Collector ─────────────────────────────────────────────────

  async function collectFingerprint(): Promise<Fingerprint> {
    const nav = navigator as Navigator & { webdriver?: boolean };

    let webglVendor: string | null = null;
    let webglRenderer: string | null = null;
    try {
      const canvas = document.createElement('canvas');
      const gl =
        (canvas.getContext('webgl') as WebGLRenderingContext | null) ||
        (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          webglVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
          webglRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
        }
      }
    } catch { /* browser mungkin restrict WebGL */ }

    let mouseMoved = false;
    await new Promise<void>((resolve) => {
      const handler = (): void => { mouseMoved = true; resolve(); };
      window.addEventListener('mousemove', handler, { once: true, passive: true });
      window.addEventListener('touchstart', handler, { once: true, passive: true });
      setTimeout(resolve, 500);
    });

    return {
      webdriver: Boolean(nav.webdriver),
      languages: (() => { try { return Array.from(navigator.languages || []); } catch { return []; } })(),
      hardwareConcurrency: (() => { try { return navigator.hardwareConcurrency || 0; } catch { return 0; } })(),
      screenWidth: (() => { try { return window.screen.width || 0; } catch { return 0; } })(),
      screenHeight: (() => { try { return window.screen.height || 0; } catch { return 0; } })(),
      userAgent: navigator.userAgent,
      webglVendor,
      webglRenderer,
      mouseMoved,
    };
  }

  // ─── PoW Solver (inline blob Worker) ──────────────────────────────────────

  const WORKER_CODE = `
    var MAX_ITER_PER_CHECK = 1024;
    function leadingZeroBits(buf) {
      var bits = 0;
      for (var i = 0; i < buf.length; i++) {
        var byte_ = buf[i] !== undefined ? buf[i] : 0;
        if (byte_ === 0) { bits += 8; continue; }
        for (var b = 7; b >= 0; b--) {
          if ((byte_ >> b) & 1) return bits;
          bits += 1;
        }
        return bits;
      }
      return bits;
    }
    async function sha256(input) {
      var bytes = new TextEncoder().encode(input);
      var digest = await crypto.subtle.digest('SHA-256', bytes);
      return new Uint8Array(digest);
    }
    self.onmessage = async function(e) {
      var challenge = e.data.challenge, salt = e.data.salt;
      var difficulty = e.data.difficulty;
      var budgetMs = e.data.budgetMs !== undefined ? e.data.budgetMs : 15000;
      var start = performance.now();
      var nonce = BigInt(0);
      var iterations = 0;
      while (performance.now() - start < budgetMs) {
        for (var i = 0; i < MAX_ITER_PER_CHECK; i++) {
          var h = await sha256(challenge + ':' + salt + ':' + nonce.toString(16));
          iterations++;
          if (leadingZeroBits(h) >= difficulty) {
            self.postMessage({ ok: true, nonce: nonce.toString(16), iterations: iterations, durationMs: performance.now() - start });
            return;
          }
          nonce++;
        }
        await new Promise(function(r) { setTimeout(r, 0); });
      }
      self.postMessage({ ok: false, reason: 'budget_exceeded' });
    };
  `;

  interface PoWResult { nonce: string; durationMs: number; }
  type WorkerDoneMsg = { ok: true; nonce: string; durationMs: number } | { ok: false; reason: string };

  async function solvePoW(challenge: string, salt: string, difficulty: number): Promise<PoWResult> {
    return new Promise((resolve, reject) => {
      let worker!: Worker;
      try {
        const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        worker = new Worker(blobUrl);
        URL.revokeObjectURL(blobUrl);
      } catch {
        reject(new Error('Failed to create PoW worker'));
        return;
      }
      worker.onmessage = (e: MessageEvent<WorkerDoneMsg>) => {
        worker.terminate();
        e.data.ok ? resolve({ nonce: e.data.nonce, durationMs: e.data.durationMs }) : reject(new Error(e.data.reason));
      };
      worker.onerror = (err: ErrorEvent) => { worker.terminate(); reject(new Error(err.message || 'worker_error')); };
      worker.postMessage({ challenge, salt, difficulty, budgetMs: 20000 });
    });
  }

  // ─── Human Verification Path ───────────────────────────────────────────────

  async function runHumanVerification(cfg: VxConfig): Promise<void> {
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
    revealContent();
    clearTimeout(_safetyReveal);
    window.dispatchEvent(new CustomEvent('vx:access', {
      detail: { domain: cfg.domain, token: ver.sessionToken, method: 'human' },
    }));
  }

  // ─── Bot / AI Payment Flow ─────────────────────────────────────────────────

  async function runBotFlow(cfg: VxConfig, signals: BotSignal[]): Promise<void> {
    void signals; // used for future server-side telemetry

    // Fetch payment requirements
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

    // Konten tetap hidden — show overlay di atas
    showOverlay(renderPaymentPanel(cfg, priceUsdc, network));

    // Poll sampai bot bayar (max 10 menit)
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
          revealContent();
          clearTimeout(_safetyReveal);
          window.dispatchEvent(new CustomEvent('vx:access', {
            detail: { domain: cfg.domain, token: null, method: 'paid_agent' },
          }));
        }
      } catch { /* keep polling */ }
    }, 2000);
  }

  // ─── Entry Point ───────────────────────────────────────────────────────────

  async function init(): Promise<void> {
    const domain = _script?.dataset?.domain?.trim();
    const apiRaw = _script?.dataset?.api?.trim();
    if (!domain || !apiRaw) {
      revealContent();
      clearTimeout(_safetyReveal);
      return;
    }
    const api = apiRaw.replace(/\/$/, '');
    const slug = (location.pathname.replace(/^\//, '').split('/')[0] || '').trim() || 'index';
    const cfg: VxConfig = { domain, api, slug };

    // Cek session yang masih valid — validasi ke server dulu sebelum reveal
    const existingToken = getSession(domain);
    if (existingToken) {
      try {
        const r = await fetch(`${api}/api/v1/content/hydrate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${existingToken}` },
          body: JSON.stringify({ domain, slug }),
        });
        if (r.ok) {
          revealContent();
          clearTimeout(_safetyReveal);
          return;
        }
        // Token rejected by server (expired/invalid) — clear and re-verify
        sessionStorage.removeItem(SESSION_PREFIX + domain);
      } catch {
        // Network error — reveal anyway to avoid blocking human on flaky connection
        revealContent();
        clearTimeout(_safetyReveal);
        return;
      }
    }

    // Score-based bot detection
    const { score, signals } = calcBotScore();
    const isBot = score >= 50;

    if (isBot) {
      // BOT: konten tetap hidden, show payment overlay
      runBotFlow(cfg, signals).catch(() => {
        showOverlay(renderErrorPanel('Could not load payment information. Please retry.'));
      });
    } else {
      // HUMAN: verify silent, reveal setelah PoW
      // Tampilkan spinner halus agar tidak blank terlalu lama
      showOverlay(renderVerifyingPanel());
      runHumanVerification(cfg)
        .then(() => hideOverlay())
        .catch(() => {
          // Verify gagal → fallback ke bot flow
          hideOverlay();
          runBotFlow(cfg, [{ name: 'verify_failed', score: 0 }]).catch(() => {
            revealContent();
            clearTimeout(_safetyReveal);
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
})();
