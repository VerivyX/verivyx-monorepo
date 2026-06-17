import { NextResponse } from 'next/server';

// Public API reference. Rendered with Scalar (loaded from CDN), driven by the
// static OpenAPI specs in /public/openapi. Internal/admin endpoints are NOT in
// these specs — they live behind /docs/api/internal.
//
// Served as a standalone HTML document via a Route Handler so it gets the full
// viewport instead of inheriting the narrow /docs layout.

const SOURCES = [
  { url: '/openapi/x402-gateway.yaml', title: 'Payment Gateway (x402)', slug: 'gateway' },
  { url: '/openapi/hydration.yaml', title: 'Content Hydration', slug: 'hydration' },
  { url: '/openapi/auth.yaml', title: 'Auth & Creator API', slug: 'auth' },
  { url: '/openapi/mcp.yaml', title: 'x402 MCP Server', slug: 'mcp' },
  { url: '/openapi/playground.yaml', title: 'Playground Agent', slug: 'playground' },
];

function html(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Verivyx API Reference</title>
    <link rel="icon" href="/icon.svg" />
    <style>
      body { margin: 0; }
      .vx-topbar {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 16px; border-bottom: 1px solid #ececec;
        font: 500 14px/1.2 ui-sans-serif, system-ui, sans-serif;
      }
      .vx-topbar a { color: #1f1f1f; text-decoration: none; }
      .vx-topbar .vx-sep { color: #c9c9c9; }
    </style>
  </head>
  <body>
    <div class="vx-topbar">
      <a href="/docs">&larr; Verivyx Docs</a>
      <span class="vx-sep">/</span>
      <span>API Reference</span>
    </div>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.59.3"></script>
    <script>
      Scalar.createApiReference('#app', {
        sources: ${JSON.stringify(SOURCES)},
        theme: 'default',
        hideClientButton: false,
      });
    </script>
  </body>
</html>`;
}

export function GET() {
  return new NextResponse(html(), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
