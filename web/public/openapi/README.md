# Verivyx OpenAPI specs

Hand-written OpenAPI 3.1 specs for every Verivyx API, rendered with
[Swagger UI](https://swagger.io/tools/swagger-ui/) inside the docs app.

## Layout

| File | Surface | Where it renders |
| --- | --- | --- |
| `x402-gateway.yaml` | x402 payment gateway (public) | `/docs/api` |
| `hydration.yaml` | content hydration (public) | `/docs/api` |
| `auth.yaml` | auth + creator + connect (public) | `/docs/api` |
| `mcp.yaml` | x402 MCP server (public) | `/docs/api` |
| `playground.yaml` | playground agent (public) | `/docs/api` |
| `../../openapi-internal/internal.yaml` | admin + service-mesh (internal) | `/docs/api/internal` (admin-gated) |
| `../../openapi-internal/wordpress-plugin.yaml` | WP plugin REST (internal) | `/docs/api/internal` (admin-gated) |

The **public** specs live here in `web/public/openapi/` and are served as static
files. The **internal** specs live in `web/openapi-internal/` (outside `public/`)
so they are never statically downloadable; they are served only through the
admin-gated route `GET /docs/api/internal/spec/[name]`, which validates the
caller's Bearer token against auth-service `/auth/me` (role `ADMIN`).

## Rendering

- `web/src/app/docs/api/route.ts` — public Swagger UI reference (multi-spec dropdown).
- `web/src/app/docs/api/internal/route.ts` — internal Swagger UI shell + client-side
  admin gate (requestInterceptor attaches the admin Bearer token).
- `web/src/app/docs/api/internal/spec/[name]/route.ts` — admin-gated spec server.

`next.config.ts` traces `openapi-internal/**` into the standalone build so the
gated route can read those specs at runtime.

## Editing & linting

Specs are hand-maintained. After editing, lint via Docker (host has no Node):

```bash
# public specs
docker run --rm -v "$PWD/web/public/openapi":/w -w /w node:20-alpine \
  npx -y @redocly/cli@latest lint *.yaml

# internal specs
docker run --rm -v "$PWD/web/openapi-internal":/w -w /w node:20-alpine \
  npx -y @redocly/cli@latest lint internal.yaml wordpress-plugin.yaml
```

`redocly.yaml` uses the `minimal` ruleset (real OpenAPI structural correctness,
no documentation-completeness style nags). Every operation needs an
`operationId` (enforced; also gives Scalar stable deep links).

## Conventions

- No real tokens/secrets in examples — placeholders only.
- Internal/admin endpoints never appear in the public specs.
- Security schemes: `bearerAuth` (creator/admin JWT), `internalToken`
  (`X-Internal-Token`), `mcpKey` (`X-Verivyx-MCP-Key`), `wpInternalToken`
  (`X-Verivyx-Internal`), `x402Payment` (`X-PAYMENT`/`PAYMENT-SIGNATURE`),
  `humanSession` (human session JWT).
