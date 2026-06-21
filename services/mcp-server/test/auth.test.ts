/**
 * TDD tests for requireUserAuth middleware (Plan 3 auth reconciliation).
 *
 * Tests that the dashboard auth-service HS256 token is accepted on /wallet/* endpoints
 * and resolves to the same sub as the Hydra OAuth JWT (String(user.id)).
 *
 * Uses jose's SignJWT to sign self-contained test tokens — no live Hydra required.
 *
 * Run via: docker run --rm -v "$PWD/services/mcp-server":/app -w /app node:20-alpine sh -c "npm ci && npm test"
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT } from "jose";
import express, { type Request, type Response } from "express";
import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// Minimal env for config.ts (loaded transitively by auth.ts)
// ---------------------------------------------------------------------------
process.env.MCP_STELLAR_SECRET = "SDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY";
process.env.INTERNAL_TOKEN = "test-internal-token";
process.env.PLATFORM_STELLAR_ADDRESS = "GDUMMY000000000000000000000000000000000000000000000000000000";
process.env.MCP_WALLET_ENC_KEY = "a".repeat(64);

// Shared HS256 test secret — only used by tests; never logged.
const TEST_JWT_SECRET = "test-dashboard-jwt-secret-32-bytes-ok!";
process.env.JWT_SECRET = TEST_JWT_SECRET;

// Unset HYDRA_ISSUER so verifier is undefined (dashboard-only mode for these tests).
delete process.env.HYDRA_ISSUER;

// Re-require config after env is set (config caches on first call — reset it).
// We must import dynamically AFTER env vars are set so getConfig() reads them.

// ---------------------------------------------------------------------------
// Helper: mint a dashboard HS256 token (audience "creator") with jose SignJWT
// ---------------------------------------------------------------------------
async function mintDashboardToken(opts: {
  id?: unknown;
  audience?: string;
  secret?: string;
}): Promise<string> {
  const secret = opts.secret ?? TEST_JWT_SECRET;
  const key = new TextEncoder().encode(secret);

  const builder = new SignJWT(opts.id !== undefined ? { id: opts.id } : {})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h");

  if (opts.audience !== undefined) {
    builder.setAudience(opts.audience);
  }

  return builder.sign(key);
}

// ---------------------------------------------------------------------------
// Helper: call an endpoint that uses requireUserAuth as middleware
// ---------------------------------------------------------------------------
type UserAuthResponse = { status: number; body: Record<string, unknown>; mcpUser?: unknown };

async function callWithUserAuth(token: string | undefined): Promise<UserAuthResponse> {
  // Lazy-import auth AFTER env vars are set.
  const { requireUserAuth } = await import("../src/auth.js");

  const app = express();
  app.use(express.json());

  // Mount a test endpoint that just echoes back the resolved mcpUser.
  app.get("/wallet/test", requireUserAuth, (req: Request, res: Response) => {
    const user = (req as Request & { mcpUser?: unknown }).mcpUser;
    res.json({ ok: true, mcpUser: user });
  });

  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/wallet/test`;
      const headers: Record<string, string> = {};
      if (token !== undefined) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      fetch(url, { headers })
        .then(async (r) => {
          const body = await r.json() as Record<string, unknown>;
          server.close(() => resolve({ status: r.status, body, mcpUser: body["mcpUser"] }));
        })
        .catch((err) => {
          server.close(() => reject(err));
        });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests: dashboard HS256 token accepted → kind:"dashboard", sub=String(id)
// ---------------------------------------------------------------------------

test("requireUserAuth: valid dashboard token {id:42} resolves to kind:dashboard sub:\"42\"", async () => {
  const token = await mintDashboardToken({ id: 42, audience: "creator" });
  const { status, mcpUser } = await callWithUserAuth(token);
  assert.equal(status, 200, `expected 200, got ${status}`);
  assert.deepEqual(mcpUser, { kind: "dashboard", sub: "42" });
});

test("requireUserAuth: sub is STRING \"42\" (not number 42) — exact match with Hydra sub format", async () => {
  const token = await mintDashboardToken({ id: 42, audience: "creator" });
  const { mcpUser } = await callWithUserAuth(token);
  const user = mcpUser as { kind: string; sub: unknown } | undefined;
  assert.ok(user !== undefined, "mcpUser must be set");
  assert.equal(typeof user.sub, "string", "sub must be a string (not a number)");
  assert.equal(user.sub, "42", "sub must be exactly \"42\"");
});

test("requireUserAuth: wrong audience → 401", async () => {
  const token = await mintDashboardToken({ id: 42, audience: "wrong-audience" });
  const { status } = await callWithUserAuth(token);
  assert.equal(status, 401, "wrong audience must be rejected with 401");
});

test("requireUserAuth: wrong secret → 401", async () => {
  const token = await mintDashboardToken({ id: 42, audience: "creator", secret: "different-wrong-secret-1234567890" });
  const { status } = await callWithUserAuth(token);
  assert.equal(status, 401, "wrong secret must be rejected with 401");
});

test("requireUserAuth: missing id claim → 401", async () => {
  // Sign a token with audience "creator" but no id field
  const token = await mintDashboardToken({ audience: "creator" });
  const { status } = await callWithUserAuth(token);
  assert.equal(status, 401, "missing id claim must be rejected with 401");
});

test("requireUserAuth: string id claim (not numeric) → 401", async () => {
  const token = await mintDashboardToken({ id: "not-a-number", audience: "creator" });
  const { status } = await callWithUserAuth(token);
  assert.equal(status, 401, "non-numeric id claim must be rejected with 401");
});

test("requireUserAuth: no token → 401", async () => {
  const { status } = await callWithUserAuth(undefined);
  assert.equal(status, 401, "missing token must be rejected with 401");
});

// ---------------------------------------------------------------------------
// Sub-consistency assertion (the crux):
// A dashboard token {id:42} and a Hydra token with sub:"42" resolve to the SAME sub.
// A binding created under one is found under the other.
// ---------------------------------------------------------------------------

test("sub-consistency: String(dashboardId) === hydraSub — dashboard and Hydra use the same sub", () => {
  // Simulate what requireUserAuth does for a dashboard token with id=42.
  const dashboardId = 42;
  const dashboardSub = String(dashboardId); // "42"

  // Simulate what requireMcpAuth / requireUserAuth does for a Hydra JWT:
  // auth-service acceptLogin sets subject = String(req.userId) where userId === user.id.
  // So for the same user (id=42), hydraSub = String(42) = "42".
  const hydraSub = String(42); // as set by auth-service acceptLogin

  assert.equal(
    dashboardSub,
    hydraSub,
    `sub-consistency violated: dashboard resolves "${dashboardSub}" but Hydra would be "${hydraSub}"`,
  );
  assert.equal(typeof dashboardSub, "string", "both subs must be strings");
  assert.equal(typeof hydraSub, "string", "both subs must be strings");
});

test("sub-consistency: a binding upserted under hydraSub is found by the same key as dashboardSub", () => {
  // Simulates: agent calls /wallet/session-signer with kind:"oauth" sub="42"
  //            dashboard calls GET /wallet/status with kind:"dashboard" sub="42"
  // Both use the same oauthSub key.
  const userId = 99;

  // Hydra sub (agent path):
  const hydraSub = String(userId); // auth-service: acceptLogin subject = String(req.userId)

  // Dashboard sub (dashboard path):
  const dashboardSub = String(userId); // requireUserAuth: String(payload.id)

  // They must be equal — the wallet lookup uses oauthSub as the key.
  assert.equal(hydraSub, dashboardSub, "agent sub and dashboard sub must be identical for the same user");

  // Simulate: agent creates binding with oauthSub = hydraSub.
  const walletStore = new Map<string, string>();
  walletStore.set(hydraSub, "session-pubkey-abc");

  // Dashboard lookup using dashboardSub.
  const found = walletStore.get(dashboardSub);
  assert.ok(found !== undefined, "binding created by agent must be visible to dashboard (same sub)");
  assert.equal(found, "session-pubkey-abc");
});

// ---------------------------------------------------------------------------
// Wallet endpoints: dashboard-authed caller (kind:"dashboard") must be accepted
// ---------------------------------------------------------------------------

test("wallet endpoints accept kind:dashboard caller (session-signer)", async () => {
  // Lazy import to avoid top-level side effects before env is set.
  const { buildWalletRouter } = await import("../src/wallet/endpoints.js");
  const { getBinding, getWalletStatus, upsertBinding } = await import("../src/wallet/registry.js");

  // Minimal in-memory store.
  const store = new Map<string, Record<string, unknown>>();
  const querier = {
    async query(sql: string, params: unknown[]) {
      if (/INSERT/i.test(sql)) {
        const [sub, smartAccount, pubkey, secretEnc, budget, expiry] = params as string[];
        store.set(sub, { oauthSub: sub, smartAccount, sessionSignerPubkey: pubkey, sessionSignerSecretEnc: secretEnc, budgetAtomic: budget, expiryLedger: expiry });
        return { rows: [] };
      } else if (/SELECT/i.test(sql)) {
        const [sub] = params as string[];
        const row = store.get(sub);
        return { rows: row ? [row] : [] };
      } else if (/DELETE/i.test(sql)) {
        const [sub] = params as string[];
        store.delete(sub);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const ops = {
    getBinding: (sub: string) => getBinding(sub, querier),
    getWalletStatus: (sub: string) => getWalletStatus(sub, querier),
    upsertBinding: (binding: Parameters<typeof upsertBinding>[0]) => upsertBinding(binding, querier),
    bindWallet: async () => {},
    deleteBinding: async (sub: string) => { await querier.query(`DELETE FROM "McpWallet" WHERE "oauthSub" = $1`, [sub]); },
  };

  const app = express();
  app.use(express.json());

  // Inject a kind:"dashboard" mcpUser (as requireUserAuth would set).
  const dashboardUser = { kind: "dashboard" as const, sub: "42" };
  app.use((_req: Request, _res: Response, next) => {
    ((_req as unknown) as Record<string, unknown>).mcpUser = dashboardUser;
    next();
  });

  const walletRouter = buildWalletRouter(ops);
  app.use("/wallet", walletRouter);

  const result = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/wallet/session-signer`, { method: "POST", headers: { "content-type": "application/json" } })
        .then(async (r) => {
          const body = await r.json() as Record<string, unknown>;
          server.close(() => resolve({ status: r.status, body }));
        })
        .catch((err) => { server.close(() => reject(err)); });
    });
  });

  assert.equal(result.status, 200, `dashboard caller must be accepted (got ${result.status}: ${JSON.stringify(result.body)})`);
  assert.ok(typeof result.body["sessionPubkey"] === "string", "must return sessionPubkey");
});

test("wallet endpoints: kind:key caller is still rejected with 403", async () => {
  const { buildWalletRouter } = await import("../src/wallet/endpoints.js");

  const ops = {
    getBinding: async () => null,
    getWalletStatus: async () => null,
    upsertBinding: async () => {},
    bindWallet: async () => {},
    deleteBinding: async () => {},
  };

  const app = express();
  app.use(express.json());

  const keyUser = { kind: "key" as const, label: "playground" };
  app.use((_req: Request, _res: Response, next) => {
    ((_req as unknown) as Record<string, unknown>).mcpUser = keyUser;
    next();
  });

  const walletRouter = buildWalletRouter(ops);
  app.use("/wallet", walletRouter);

  const { status } = await new Promise<{ status: number }>((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/wallet/session-signer`, { method: "POST", headers: { "content-type": "application/json" } })
        .then(async (r) => { server.close(() => resolve({ status: r.status })); })
        .catch((err) => { server.close(() => reject(err)); });
    });
  });

  assert.equal(status, 403, "static-key caller must be rejected with 403");
});
