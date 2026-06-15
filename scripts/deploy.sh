#!/usr/bin/env bash
# Build and (re)deploy the Verivyx stack, then sync + reload host nginx.
# Idempotent: safe to re-run. Reuses the existing Postgres volume via
# COMPOSE_PROJECT_NAME (set in .env).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

echo "==> Validating compose config"
docker compose config --quiet

echo "==> Building images"
docker compose build

echo "==> Bringing up the stack (reuses existing volumes)"
docker compose up -d

# Host nginx vhosts are managed on the VM (not published). If local copies exist
# under infra/nginx/conf.d/ they are synced; otherwise nginx is just reloaded.
echo "==> Reloading host nginx (needs sudo)"
if command -v nginx >/dev/null 2>&1; then
  if compgen -G "infra/nginx/conf.d/*.conf" >/dev/null; then
    sudo cp infra/nginx/conf.d/*.conf /etc/nginx/conf.d/
    echo "    synced local vhosts"
  fi
  sudo nginx -t && sudo nginx -s reload
  echo "    nginx reloaded"
else
  echo "    nginx not installed on host — skipping"
fi

echo "==> Done. Running services:"
docker compose ps
