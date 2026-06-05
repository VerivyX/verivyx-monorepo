#!/bin/bash

# Helper to generate random 32-char hex string
gen_secret() {
  openssl rand -hex 16
}

echo "🛠️ Paywall AI Environment Setup"
echo "=============================="

if [ -f .env ]; then
  echo "⚠️ .env file already exists. Backing up to .env.bak"
  cp .env .env.bak
fi

# Copy example as base
cp .env.example .env

# Generate secrets
JWT_SECRET=$(gen_secret)
SESSION_SECRET=$(gen_secret)
INTERNAL_TOKEN=$(gen_secret)
POW_SALT=$(gen_secret)

# Update .env using sed (works on macOS and Linux)
sed -i.tmp "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
sed -i.tmp "s/SESSION_SECRET=.*/SESSION_SECRET=$SESSION_SECRET/" .env
sed -i.tmp "s/INTERNAL_TOKEN=.*/INTERNAL_TOKEN=$INTERNAL_TOKEN/" .env
sed -i.tmp "s/POW_SALT=.*/POW_SALT=$POW_SALT/" .env
rm .env.tmp

echo "✅ Generated new secrets in .env"
echo "👉 Now edit .env to set your STELLAR_NETWORK and FACILITATOR details."
