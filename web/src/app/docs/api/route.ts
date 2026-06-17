import { NextResponse } from 'next/server';

// Public API reference. Rendered with Swagger UI (loaded from CDN), driven by the
// static OpenAPI specs in /public/openapi. Internal/admin endpoints are NOT in
// these specs — they live behind /docs/api/internal.
//
// Served as a standalone HTML document via a Route Handler so it gets the full
// viewport instead of inheriting the narrow /docs layout.

const SWAGGER = '5.18.2';

const URLS = [
  { url: '/openapi/x402-gateway.yaml', name: 'Payment Gateway (x402)' },
  { url: '/openapi/hydration.yaml', name: 'Content Hydration' },
  { url: '/openapi/auth.yaml', name: 'Auth & Creator API' },
  { url: '/openapi/mcp.yaml', name: 'x402 MCP Server' },
  { url: '/openapi/playground.yaml', name: 'Playground Agent' },
];

function html(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Verivyx API Reference</title>
    <link rel="icon" href="/icon.svg" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER}/swagger-ui.css" />
    <style>
      body { margin: 0; }
      .vx-topbar {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 16px; border-bottom: 1px solid #ececec;
        font: 500 14px/1.2 ui-sans-serif, system-ui, sans-serif;
      }
      .vx-topbar a { color: #1f1f1f; text-decoration: none; }
      .vx-topbar .vx-sep { color: #c9c9c9; }
      .swagger-ui .topbar { background: #1f2937; }
    </style>
  </head>
  <body>
    <div class="vx-topbar">
      <a href="/docs">&larr; Verivyx Docs</a>
      <span class="vx-sep">/</span>
      <span>API Reference</span>
    </div>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER}/swagger-ui-bundle.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER}/swagger-ui-standalone-preset.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        urls: ${JSON.stringify(URLS)},
        "urls.primaryName": ${JSON.stringify(URLS[0].name)},
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        plugins: [SwaggerUIBundle.plugins.DownloadUrl],
        layout: 'StandaloneLayout',
        tryItOutEnabled: true,
        persistAuthorization: true,
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
