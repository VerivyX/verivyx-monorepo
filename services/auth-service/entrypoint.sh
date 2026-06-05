#!/bin/sh
set -e

MAX_RETRIES=30
RETRY_INTERVAL=2
attempt=0

echo "⏳ Waiting for database to be ready..."
until npx prisma db push --accept-data-loss 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$MAX_RETRIES" ]; then
    echo "❌ Database not ready after ${MAX_RETRIES} attempts. Exiting."
    exit 1
  fi
  echo "⏳ Database not ready (attempt $attempt/$MAX_RETRIES). Retrying in ${RETRY_INTERVAL}s..."
  sleep "$RETRY_INTERVAL"
done

echo "✅ Database schema synchronized."
echo "🚀 Starting Auth Service..."
exec node dist/index.js
