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

  // Default target: a REAL Verivyx SDK-protected site (demo-sdk-next.verivyx.com).
  // It returns HTTP 402 to machines, so the MCP agent pays its public URL the normal
  // way — proving the SDK case end-to-end against a live site.
  demoSdkUrl: env("PLAYGROUND_DEMO_SDK_URL", "https://demo-sdk-next.verivyx.com/seven-wonders"),

  // Second target: a REAL Verivyx-protected WordPress post on web-test.verivyx.com.
  // The agent pays its public URL directly (it returns HTTP 402 to bots), proving the
  // "general web" case end-to-end against a live site.
  webTestUrl: env("PLAYGROUND_WEBTEST_URL", "https://web-test.verivyx.com/2026/05/31/hello-world/"),

  poolSize: num("PLAYGROUND_POOL_SIZE", 6),
  maxSessions: num("PLAYGROUND_MAX_SESSIONS", 10),
  sessionTtlMin: num("PLAYGROUND_SESSION_TTL_MIN", 15),

  allowedPaymentPrefixes: env(
    "ALLOWED_PAYMENT_PREFIXES",
    "https://demo-sdk-next.verivyx.com/,https://web-test.verivyx.com/",
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
} as const;
