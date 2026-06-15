# Infra

Reproducible host configuration notes for the Verivyx deployment.

## nginx

Host nginx terminates TLS and reverse-proxies to the docker-compose services
(all published on `127.0.0.1`). The **full vhost files are managed on the VM and
are not published here** (they carry internal routing details); this is just a
reference. Routing overview:

| Host | Proxies to |
|---|---|
| `verivyx.com` | dashboard-ui `:3000` (+ `/api/v1/mcp-waitlist` → auth `:8083`) |
| `api.verivyx.com` | path-routes: `/api/v1/{auth,admin}` → auth `:8083`, `/api/v1/payment` → gateway `:8081`, `/api/v1/content` → hydration `:8082`, `gate.min.js` → edge-embed `:8085` |
| `playground.verivyx.com` | dashboard-ui `:3000`, `/api/v1/playground/*` → playground-agent `:8087` |
| `docs.verivyx.com` / `mcp.verivyx.com` | dashboard-ui `:3000` (host-rewrite → `/docs` / `/mcp`) |

Representative snippet (the `api.verivyx.com` path-routing — abridged):

```nginx
server {
    listen 443 ssl http2;
    server_name api.verivyx.com;

    # x402 PAYMENT-REQUIRED (base64) header overflows the default buffer → 502.
    proxy_buffer_size 16k;
    proxy_buffers     8 16k;

    location = /gate.min.js   { proxy_pass http://127.0.0.1:8085; }
    location /api/v1/auth/     { proxy_pass http://127.0.0.1:8083; }
    location /api/v1/payment/  { proxy_pass http://127.0.0.1:8081; }
    location /api/v1/content/  { proxy_pass http://127.0.0.1:8082; }
}
```

TLS certs are issued by certbot on the host (`/etc/letsencrypt`, ACME webroot
`/var/www/certbot`) — not in the repo. Renew with `certbot renew`.

## Deploy

```bash
scripts/deploy.sh   # build + (re)create the stack, then reload nginx if present
```

Stack identity is pinned via `COMPOSE_PROJECT_NAME=verivyx` in `.env` so the
existing `verivyx_postgres_data` volume (live user/event data) is reused.
