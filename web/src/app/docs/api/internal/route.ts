import { NextResponse } from 'next/server';

// Internal & admin API reference. Admin-gated: the page shell loads only the
// Scalar runtime, then client JS reads the admin session from localStorage and
// fetches the specs from the gated spec server (which re-validates the admin
// token server-side). Non-admins never receive the specs.

const SOURCES = [
  { url: '/docs/api/internal/spec/internal', title: 'Internal & Admin API', slug: 'internal' },
  { url: '/docs/api/internal/spec/wordpress', title: 'WordPress Plugin REST', slug: 'wordpress' },
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
    <style>
      body { margin: 0; font: 400 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: #1f1f1f; }
      .vx-topbar {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 16px; border-bottom: 1px solid #ececec; font-weight: 500; font-size: 14px;
      }
      .vx-topbar a { color: #1f1f1f; text-decoration: none; }
      .vx-topbar .vx-sep { color: #c9c9c9; }
      .vx-badge { margin-left: auto; background: #fde68a; color: #713f12; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
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
    <div id="app"></div>
    <div id="gate" class="vx-gate" style="display:none">
      <h1>Admin access required</h1>
      <p id="gate-msg">Sign in with a Verivyx admin account to view the internal &amp; admin API reference.</p>
      <a class="btn" href="/login">Go to login</a>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.59.3"></script>
    <script>
      (function () {
        var sources = ${JSON.stringify(SOURCES)};
        function showGate(msg) {
          document.getElementById('app').style.display = 'none';
          if (msg) document.getElementById('gate-msg').textContent = msg;
          document.getElementById('gate').style.display = 'block';
        }
        var token = null, user = null;
        try {
          token = localStorage.getItem('paywall_token');
          user = JSON.parse(localStorage.getItem('paywall_user') || 'null');
        } catch (e) {}
        if (!token || !user || user.role !== 'ADMIN') { showGate(); return; }
        Promise.all(
          sources.map(function (s) {
            return fetch(s.url, { headers: { Authorization: 'Bearer ' + token } }).then(function (r) {
              if (!r.ok) throw r.status;
              return r.text();
            }).then(function (content) { return { content: content, title: s.title, slug: s.slug }; });
          })
        ).then(function (resolved) {
          Scalar.createApiReference('#app', { sources: resolved, theme: 'default' });
        }).catch(function (status) {
          showGate('Could not load the internal specs (status ' + status + '). Your admin session may have expired — sign in again.');
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
