# Verivyx

**The gate between creator content and the AI world.**

Creators add Verivyx to their site — a WordPress plugin, a one-line embed script, or the
[`@verivyx/paywall`](https://www.npmjs.com/package/@verivyx/paywall) SDK (one middleware file for
Next.js / Express / Hono). Humans read free (verified via Proof-of-Work), verified search crawlers get
an SEO preview, and AI agents pay USDC over the [x402](https://x402.org) protocol on Stellar. Content
stays on the creator's own server; Verivyx only controls who is allowed to see it.

> Security model: **economic, not cryptographic.** Anyone can read the HTML source — but an AI agent
> that wants legitimate, reliable access pays for it. The monetization target is the sophisticated
> agent, not the casual scraper.

This is the full platform monorepo: backend services, on-chain contracts, and the web app.

---

## Repository layout

```
verivyx/
├── services/          # Backend services + on-chain contracts
│   ├── auth-service/        # Identity, RBAC, PoW, sessions, analytics (Node/Prisma)
│   ├── x402-gateway/        # x402 protocol, payment requirements, session cache (Go)
│   ├── hydration-service/   # Human-vs-bot gate, content delivery (Go)
│   ├── payment-relayer/     # XDR validation, Stellar TX submission (Node)
│   ├── mcp-server/          # Remote x402 payment MCP server, multi-chain (Node)
│   ├── soroban-contracts/   # On-chain domain registry + trustless pay/split (Rust)
│   ├── embed-script/        # gate.min.js browser embed (TypeScript)
│   ├── publisher-sdk/       # @verivyx/paywall — publisher SDK (Next/Express/Hono middleware)
│   ├── playground-agent/    # Sandboxed x402 playground backend (Node)
│   └── wordpress-plugin/    # WordPress integration (PHP)
├── web/               # Frontend — dashboard, admin, docs, MCP page, playground (Next.js)
├── scripts/           # Deploy + setup helpers
├── docker-compose.yml # Brings up the whole stack
└── .env.example       # Every configurable value, documented
```

Services talk to each other over HTTP with an `X-Internal-Token` header. No service reads another
service's database directly.

---

## Integrations (how publishers gate content)

| Path | Best for | Docs |
|---|---|---|
| **`@verivyx/paywall` SDK** | Any Node app — one middleware file gates the whole app (Next.js `verivyxProxy`, Express `verivyxMiddleware`, Hono `verivyxHonoMiddleware`) | [/docs/sdk](https://docs.verivyx.com/docs/sdk) |
| **WordPress plugin** | WordPress sites — one-click install | [/docs/wordpress](https://docs.verivyx.com/docs/wordpress) |
| **Embed script** | Any site — one `<script>` tag (soft paywall) | [/docs/embed](https://docs.verivyx.com/docs/embed) |

All three: humans read free (in-page proof-of-work unlock), verified search crawlers get an SEO
preview, AI agents pay per-request via x402, and protected content is withheld at the server. The SDK
is on npm — `@verivyx/paywall` (core) + `-express` / `-next` / `-hono` — and lives in
[`services/publisher-sdk/`](services/publisher-sdk/). Live demos:
[demo-sdk-next](https://demo-sdk-next.verivyx.com/seven-wonders) ·
[demo-sdk-express](https://demo-sdk-express.verivyx.com/seven-wonders).

---

## Public hosts

| Host | Serves |
|---|---|
| `verivyx.com` | Frontend app (`web/`) |
| `api.verivyx.com` | All REST APIs + `gate.min.js` (nginx path-routes to each service) |
| `docs.verivyx.com` | Developer docs (`web` `/docs` route) |
| `mcp.verivyx.com` | x402 MCP server page (`web` `/mcp` route) |
| `playground.verivyx.com` | Sandboxed x402 playground |

The frontend talks to the backend over `api.verivyx.com` and authenticates with a bearer token, so
the two halves can be deployed and scaled independently.

---

## Quick start

```bash
cp .env.example .env
# Fill in secrets, Stellar addresses, and API_PUBLIC_URL (e.g. https://api.verivyx.com).

# Whole stack (backend + frontend):
docker compose up -d --build
docker compose exec auth-service npx prisma migrate deploy
```

Bring up only the backend (without the frontend):

```bash
docker compose up -d auth-service x402-gateway hydration-service payment-relayer mcp-server edge-embed
```

For local development without a funded Stellar wallet, set `FACILITATOR_MODE=stub` and
`ALLOW_STUB_MODE=true` in `.env`.

---

## On-chain contracts (Stellar testnet)

The domain registry and settlement logic run trustlessly on Stellar Soroban — anyone can verify the
live deployment on-chain:

- **`paywall_core`** — [`CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH`](https://stellar.expert/explorer/testnet/contract/CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH) — domain registry + settlement split (`register` / `distribute`); the live settlement path.
- **`verivyx_pay_adapter`** — [`CADDPCS2CAP4O66GBHRNO6G4SUJ6S6PCLM25Q5WAZ4Q43MACYMUITUC5`](https://stellar.expert/explorer/testnet/contract/CADDPCS2CAP4O66GBHRNO6G4SUJ6S6PCLM25Q5WAZ4Q43MACYMUITUC5) — trustless single-TX atomic 3-way split (deployed + tested; not yet the live path).

Full deployment evidence (deploy / init / upgrade transactions, WASM hash) is in
[`services/soroban-contracts/README.md`](services/soroban-contracts/README.md).

---

## Conventions

- USDC amounts are atomic units: `1 USDC = 10_000_000`. Never use floating-point arithmetic.
- Every required environment variable is guarded — the process exits with a clear message if it is
  missing. Secrets never fall back to a hardcoded default. Keep `.env.example` in sync.
- On testnet, network constants (USDC issuer, RPC endpoints) have safe defaults; on **mainnet** they
  must be set explicitly.
- On the classic `distribute` path, the split is two payment operations: the creator and the
  platform wallet. (The `verivyx_pay_adapter` path does a 3-way split, adding the flat MCP fee.)
- TypeScript: no `any` (use `unknown` + narrowing). Go: structured `log.Printf`. No secrets in logs.

---

Built on [Stellar](https://stellar.org) · x402 Protocol v2 · USDC micropayments
