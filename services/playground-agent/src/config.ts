import dotenv from "dotenv";
dotenv.config();

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[playground-agent] missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function env(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fallback;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const STELLAR_NETWORK = env("STELLAR_NETWORK", "testnet");
// Hard sandbox: this service is testnet-only by design.
if (STELLAR_NETWORK !== "testnet") {
  console.error("[playground-agent] refuses to run: STELLAR_NETWORK must be 'testnet'");
  process.exit(1);
}

// Canonical classic USDC issuer on Stellar testnet (well-known SDF test asset).
// The playground is hard-locked to testnet, so this default keeps it zero-config.
const DEFAULT_TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const config = {
  port: num("PORT", 8087),
  stellarNetwork: STELLAR_NETWORK,
  // CAIP-2 form the MCP server + @x402/stellar expect.
  stellarCaip2: "stellar:testnet",
  stellarRpcUrl: env("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org"),
  horizonUrl: env("HORIZON_URL", "https://horizon-testnet.stellar.org"),
  usdcIssuer: env("USDC_ISSUER", DEFAULT_TESTNET_USDC_ISSUER),

  hydrationUrl: env("HYDRATION_URL", "http://hydration-service:8082"),
  // The demo resource settles directly against the gateway (the demo domain has no
  // origin website, so there is no WordPress body to hydrate). The internal token
  // gates the gateway's internal settle endpoint.
  gatewayUrl: env("GATEWAY_URL", "http://x402-gateway:8081"),
  internalToken: env("INTERNAL_TOKEN", ""),

  // Canonical Verivyx MCP server (Streamable HTTP). The playground drives it with
  // a per-session pooled wallet (X-Session-Stellar-Secret).
  mcpServerUrl: env("MCP_SERVER_URL", "http://mcp-server:8088/mcp"),
  mcpApiKey: (env("MCP_API_KEYS", "").split(",")[0] || "").trim(),

  openrouterApiKey: requireEnv("OPENROUTER_API_KEY"),
  openrouterModel: env("OPENROUTER_MODEL", "openai/gpt-oss-120b:free"),
  openrouterBaseUrl: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),

  // Empty secret → dev bypass (local only). In production this MUST be set.
  turnstileSecret: process.env.TURNSTILE_SECRET_KEY?.trim() ?? "",

  faucetSecret: requireEnv("PLAYGROUND_FAUCET_SECRET"),
  faucetUsdcPerWallet: env("PLAYGROUND_FAUCET_USDC_PER_WALLET", "0.5"),
  faucetDailyCap: num("PLAYGROUND_FAUCET_DAILY_CAP", 50),

  demoDomain: env("PLAYGROUND_DEMO_DOMAIN", "playground.verivyx.com"),
  demoSlug: env("PLAYGROUND_DEMO_SLUG", "article"),
  demoResourceUrl: env("PLAYGROUND_DEMO_RESOURCE_URL", "http://127.0.0.1:8087/api/v1/playground/demo/article"),
  // Base URL the (now external) MCP server uses to reach the demo resource.
  // Must be reachable from the mcp-server container — use the docker service name.
  demoBaseUrl: env("PLAYGROUND_DEMO_BASE", "http://playground-agent:8087"),

  // Second target: a REAL Verivyx-protected WordPress post on web-test.verivyx.com.
  // The agent pays its public URL directly (it returns HTTP 402 to bots), proving the
  // "general web" case end-to-end against a live site.
  webTestUrl: env("PLAYGROUND_WEBTEST_URL", "https://web-test.verivyx.com/2026/05/31/hello-world/"),

  poolSize: num("PLAYGROUND_POOL_SIZE", 6),
  maxSessions: num("PLAYGROUND_MAX_SESSIONS", 10),
  sessionTtlMin: num("PLAYGROUND_SESSION_TTL_MIN", 15),

  allowedPaymentPrefixes: env(
    "ALLOWED_PAYMENT_PREFIXES",
    "http://playground-agent:8087/api/v1/playground/demo,http://127.0.0.1:8087/api/v1/playground/demo,https://playground.verivyx.com/api/v1/playground/demo,https://web-test.verivyx.com/",
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
} as const;
