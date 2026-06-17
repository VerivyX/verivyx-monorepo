import { NextResponse } from 'next/server';

// Internal & admin API reference. Admin-gated: the page shell loads only Swagger
// UI, then client JS reads the admin session from localStorage and renders the
// specs from the gated spec server (which re-validates the admin token
// server-side). A requestInterceptor attaches the Bearer token to every request,
// including Swagger UI's own fetch of the spec definitions.

const SWAGGER = '5.18.2';

const URLS = [
  { url: '/docs/api/internal/spec/internal', name: 'Internal & Admin API' },
  { url: '/docs/api/internal/spec/relayer', name: 'Payment Relayer' },
  { url: '/docs/api/internal/spec/wordpress', name: 'WordPress Plugin REST' },
];

function html(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Verivyx Internal API Reference</title>
    <link rel="icon" href="/icon.svg" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER}/swagger-ui.css" />
    <style>
      body { margin: 0; font: 400 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: #1f1f1f; }
      .vx-topbar {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 16px; border-bottom: 1px solid #ececec; font-weight: 500; font-size: 14px;
      }
      .vx-topbar a { color: #1f1f1f; text-decoration: none; }
      .vx-topbar .vx-sep { color: #c9c9c9; }
      .vx-badge { margin-left: auto; background: #fde68a; color: #713f12; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
      .swagger-ui .topbar { background: #1f2937; }
      .vx-gate { max-width: 460px; margin: 18vh auto; text-align: center; padding: 0 20px; }
      .vx-gate h1 { font-size: 20px; margin-bottom: 8px; }
      .vx-gate p { color: #555; }
      .vx-gate a.btn { display: inline-block; margin-top: 16px; background: #facc15; color: #1f1f1f; border-radius: 10px; padding: 9px 18px; text-decoration: none; font-weight: 600; }
    </style>
  </head>
  <body>
    <div class="vx-topbar">
      <a href="/docs">&larr; Verivyx Docs</a>
      <span class="vx-sep">/</span>
      <span>Internal API Reference</span>
      <span class="vx-badge">Admin only</span>
    </div>
    <div id="swagger-ui"></div>
    <div id="gate" class="vx-gate" style="display:none">
      <h1>Admin access required</h1>
      <p id="gate-msg">Sign in with a Verivyx admin account to view the internal &amp; admin API reference.</p>
      <a class="btn" href="/login">Go to login</a>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER}/swagger-ui-bundle.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER}/swagger-ui-standalone-preset.js"></script>
    <script>
      (function () {
        var urls = ${JSON.stringify(URLS)};
        function showGate(msg) {
          document.getElementById('swagger-ui').style.display = 'none';
          if (msg) document.getElementById('gate-msg').textContent = msg;
          document.getElementById('gate').style.display = 'block';
        }
        var token = null, user = null;
        try {
          token = localStorage.getItem('paywall_token');
          user = JSON.parse(localStorage.getItem('paywall_user') || 'null');
        } catch (e) {}
        if (!token || !user || user.role !== 'ADMIN') { showGate(); return; }
        window.ui = SwaggerUIBundle({
          urls: urls,
          "urls.primaryName": urls[0].name,
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          plugins: [SwaggerUIBundle.plugins.DownloadUrl],
          layout: 'StandaloneLayout',
          tryItOutEnabled: true,
          persistAuthorization: true,
          requestInterceptor: function (req) {
            // Attach the admin token to the gated spec fetches (and any try-it-out
            // calls to internal endpoints on this origin).
            if (req.url.indexOf('/docs/api/internal/spec/') !== -1) {
              req.headers['Authorization'] = 'Bearer ' + token;
            }
            return req;
          },
          responseInterceptor: function (res) {
            if ((res.status === 401 || res.status === 403) && res.url.indexOf('/docs/api/internal/spec/') !== -1) {
              showGate('Your admin session may have expired — sign in again.');
            }
            return res;
          },
        });
      })();
    </script>
  </body>
</html>`;
}

export function GET() {
  return new NextResponse(html(), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
