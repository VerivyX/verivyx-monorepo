/**
 * TDD tests for wallet HTTP endpoints (P3-T1).
 *
 * Tests the full lifecycle: session-signer issuance (idempotent), binding confirmation,
 * status reads, revoke, and non-oauth 403 rejection. Registry is injected (no live DB).
 *
 * Run via: docker run --rm -v "$PWD/services/mcp-server":/app -w /app node:20-alpine sh -c "npm ci && npm test"
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// Set encryption key before any imports that touch registry
process.env.MCP_WALLET_ENC_KEY = "a".repeat(64); // 32 bytes as 64 hex chars
// Minimal env vars needed by config.ts (which is loaded transitively)
process.env.MCP_STELLAR_SECRET = "SDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY";
process.env.INTERNAL_TOKEN = "test-internal-token";
process.env.PLATFORM_STELLAR_ADDRESS = "GDUMMY000000000000000000000000000000000000000000000000000000";

import type { Querier } from "../src/wallet/registry.js";
import { getBinding, getWalletStatus, isEarlyAccessGranted } from "../src/wallet/registry.js";
import {
  buildWalletRouter,
  type WalletRegistryOps,
} from "../src/wallet/endpoints.js";
import express, { type Request, type Response } from "express";
import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// In-memory fake registry store for endpoint tests
// ---------------------------------------------------------------------------

/**
 * makeFakeStore builds an in-memory registry for endpoint tests.
 *
 * @param earlyAccess - Whether the fake User row has mcpEarlyAccess=true (default true).
 *   Set to false to test the early-access gate (403 path).
 */
function makeFakeStore(earlyAccess = true): {
  ops: WalletRegistryOps;
  querier: Querier;
  store: Map<string, Record<string, unknown>>;
} {
  const store = new Map<string, Record<string, unknown>>();

  const querier: Querier = {
    async query(sql: string, params: unknown[]) {
      if (/INSERT/i.test(sql)) {
        const [sub, smartAccount, pubkey, secretEnc, budget, expiry] = params as string[];
        store.set(sub, {
          oauthSub: sub,
          smartAccount,
          sessionSignerPubkey: pubkey,
          sessionSignerSecretEnc: secretEnc,
          budgetAtomic: budget,
          expiryLedger: expiry,
        });
        return { rows: [] };
      } else if (/UPDATE/i.test(sql)) {
        // bindWallet: UPDATE "McpWallet" SET "smartAccount" = $2, "budgetAtomic" = $3, "expiryLedger" = $4 WHERE "oauthSub" = $1
        const [sub, smartAccount, budget, expiry] = params as string[];
        const existing = store.get(sub);
        if (existing) {
          store.set(sub, { ...existing, smartAccount, budgetAtomic: budget, expiryLedger: expiry });
        }
        return { rows: [] };
      } else if (/DELETE/i.test(sql)) {
        const [sub] = params as string[];
        store.delete(sub);
        return { rows: [] };
      } else if (/SELECT/i.test(sql)) {
        // Distinguish between McpWallet SELECT (oauthSub param) and User SELECT (id param).
        // The User early-access query is: SELECT "mcpEarlyAccess" FROM "User" WHERE id = $1
        // We detect it by looking for the "User" table or "mcpEarlyAccess" column in the SQL.
        if (/FROM\s+"User"/i.test(sql)) {
          // Always return a User row for any numeric id — mcpEarlyAccess reflects the option.
          return { rows: [{ mcpEarlyAccess: earlyAccess }] };
        }
        // McpWallet SELECT: keyed by oauthSub
        const [sub] = params as string[];
        const row = store.get(sub);
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };

  const ops: WalletRegistryOps = {
    getBinding: (sub) => getBinding(sub, querier),
    getWalletStatus: (sub) => getWalletStatus(sub, querier),
    isEarlyAccessGranted: (sub) => isEarlyAccessGranted(sub, querier),
    upsertBinding: async (binding) => {
      const { upsertBinding } = await import("../src/wallet/registry.js");
      return upsertBinding(binding, querier);
    },
    bindWallet: async (sub, smartAccount, budgetAtomic, expiryLedger) => {
      await querier.query(
        `UPDATE "McpWallet" SET "smartAccount" = $2, "budgetAtomic" = $3, "expiryLedger" = $4 WHERE "oauthSub" = $1`,
        [sub, smartAccount, budgetAtomic.toString(), expiryLedger.toString()],
      );
    },
    deleteBinding: async (sub) => {
      await querier.query(`DELETE FROM "McpWallet" WHERE "oauthSub" = $1`, [sub]);
    },
  };

  return { ops, querier, store };
}

// ---------------------------------------------------------------------------
// HTTP test helper: create an Express app with the wallet router + run one request
// ---------------------------------------------------------------------------

type McpUser =
  | { kind: "oauth"; sub: string }
  | { kind: "key"; label: string };

async function callEndpoint(opts: {
  method: "GET" | "POST";
  path: string;
  mcpUser?: McpUser;
  body?: Record<string, unknown>;
  ops: WalletRegistryOps;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());

  // Inject mcpUser onto the request (simulates requireMcpAuth)
  if (opts.mcpUser !== undefined) {
    const user = opts.mcpUser;
    app.use((_req: Request, _res: Response, next) => {
      ((_req as unknown) as Record<string, unknown>).mcpUser = user;
      next();
    });
  }

  const walletRouter = buildWalletRouter(opts.ops);
  app.use("/wallet", walletRouter);

  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/wallet${opts.path}`;

      const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
      const reqOpts: RequestInit = {
        method: opts.method,
        headers: { "content-type": "application/json" },
        body: bodyStr,
      };

      fetch(url, reqOpts)
        .then(async (r) => {
          const body = await r.json() as Record<string, unknown>;
          server.close(() => resolve({ status: r.status, body }));
        })
        .catch((err) => {
          server.close(() => reject(err));
        });
    });
  });
}

// ---------------------------------------------------------------------------
// Registry unit tests: getBinding returns null for pending row (smartAccount="")
// ---------------------------------------------------------------------------

test("getBinding returns null for a pending row (smartAccount empty string)", async () => {
  const { querier } = makeFakeStore();
  const { upsertBinding } = await import("../src/wallet/registry.js");

  // Insert a pending row: session key issued, no smart account yet
  await upsertBinding(
    {
      oauthSub: "user:pending:001",
      smartAccount: "",
      sessionSignerPubkey: "GCAFE000000000000000000000000000000000000000000000000000000",
      sessionSignerSecret: "SDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF1",
      budgetAtomic: 0n,
      expiryLedger: 0n,
    },
    querier,
  );

  // getBinding must return null — pay path must treat pending as no binding
  const result = await getBinding("user:pending:001", querier);
  assert.equal(result, null, "getBinding must return null for pending row (smartAccount='')");
});

test("getBinding returns a binding for a fully-bound row (smartAccount set)", async () => {
  const { querier } = makeFakeStore();
  const { upsertBinding } = await import("../src/wallet/registry.js");

  await upsertBinding(
    {
      oauthSub: "user:bound:002",
      smartAccount: "CBOUND00000000000000000000000000000000000000000000000000000",
      sessionSignerPubkey: "GCAFE000000000000000000000000000000000000000000000000000000",
      sessionSignerSecret: "SDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF1",
      budgetAtomic: 5_000_000n,
      expiryLedger: 99999n,
    },
    querier,
  );

  const result = await getBinding("user:bound:002", querier);
  assert.ok(result !== null, "getBinding must return a binding for a bound row");
  assert.equal(result.smartAccount, "CBOUND00000000000000000000000000000000000000000000000000000");
});

test("getWalletStatus returns the raw pending row (smartAccount empty)", async () => {
  const { querier } = makeFakeStore();
  const { upsertBinding } = await import("../src/wallet/registry.js");

  await upsertBinding(
    {
      oauthSub: "user:status:003",
      smartAccount: "",
      sessionSignerPubkey: "GCAFE000000000000000000000000000000000000000000000000000000",
      sessionSignerSecret: "SDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF1",
      budgetAtomic: 0n,
      expiryLedger: 0n,
    },
    querier,
  );

  const status = await getWalletStatus("user:status:003", querier);
  assert.ok(status !== null, "getWalletStatus must return the pending row");
  assert.equal(status.smartAccount, "", "pending row has empty smartAccount");
  assert.equal(status.sessionSignerPubkey, "GCAFE000000000000000000000000000000000000000000000000000000");
  // Secret must NOT appear on the returned object
  assert.ok(
    !("sessionSignerSecret" in status),
    "getWalletStatus must NOT expose the decrypted session secret",
  );
});

// ---------------------------------------------------------------------------
// Endpoint: non-oauth callers (static key) must receive 403 on all wallet routes
// ---------------------------------------------------------------------------

test("POST /wallet/session-signer with static-key caller returns 403", async () => {
  const { ops } = makeFakeStore();
  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "key", label: "playground" },
    ops,
  });
  assert.equal(status, 403, "static-key must get 403");
  assert.ok(
    String(body.error ?? "").includes("OAuth"),
    `error message must mention OAuth — got: ${JSON.stringify(body)}`,
  );
});

test("POST /wallet/binding with static-key caller returns 403", async () => {
  const { ops } = makeFakeStore();
  const { status } = await callEndpoint({
    method: "POST",
    path: "/binding",
    mcpUser: { kind: "key", label: "playground" },
    body: { smartAccount: "C" + "A".repeat(55), budgetAtomic: "5000000", expiryLedger: "99999" },
    ops,
  });
  assert.equal(status, 403);
});

test("GET /wallet/status with static-key caller returns 403", async () => {
  const { ops } = makeFakeStore();
  const { status } = await callEndpoint({
    method: "GET",
    path: "/status",
    mcpUser: { kind: "key", label: "playground" },
    ops,
  });
  assert.equal(status, 403);
});

test("POST /wallet/revoke with static-key caller returns 403", async () => {
  const { ops } = makeFakeStore();
  const { status } = await callEndpoint({
    method: "POST",
    path: "/revoke",
    mcpUser: { kind: "key", label: "playground" },
    ops,
  });
  assert.equal(status, 403);
});

test("POST /wallet/session-signer without mcpUser returns 403", async () => {
  const { ops } = makeFakeStore();
  const { status } = await callEndpoint({
    method: "POST",
    path: "/session-signer",
    // no mcpUser
    ops,
  });
  assert.equal(status, 403);
});

// ---------------------------------------------------------------------------
// Endpoint: session-signer issuance
// ---------------------------------------------------------------------------

test("POST /wallet/session-signer returns a valid ed25519 G-pubkey for oauth caller", async () => {
  const { ops } = makeFakeStore();
  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub: "1001" },
    ops,
  });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.ok(typeof body.sessionPubkey === "string", "must return sessionPubkey string");
  // ed25519 Stellar G-address: starts with 'G', 56 chars
  assert.ok(
    /^G[A-Z2-7]{55}$/.test(body.sessionPubkey as string),
    `sessionPubkey must be a valid Stellar G-address, got: ${body.sessionPubkey}`,
  );
});

test("POST /wallet/session-signer does NOT include the session secret in response", async () => {
  const { ops } = makeFakeStore();
  const { body } = await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub: "1002" },
    ops,
  });
  const bodyStr = JSON.stringify(body);
  // No S-address (secret key format) should appear in the response
  assert.ok(
    !/^S[A-Z2-7]{55}/.test(bodyStr),
    "response must not contain a Stellar secret key (S-address)",
  );
  // Must not have a key called 'secret' or 'sessionSignerSecret'
  assert.ok(!("secret" in body), "response must not have 'secret' field");
  assert.ok(!("sessionSignerSecret" in body), "response must not have 'sessionSignerSecret' field");
  assert.ok(!("sessionSignerSecretEnc" in body), "response must not have 'sessionSignerSecretEnc' field");
});

test("POST /wallet/session-signer is idempotent — second call returns same pubkey", async () => {
  const { ops } = makeFakeStore();
  const sub = "1003";

  const { body: body1 } = await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub },
    ops,
  });
  const { body: body2 } = await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub },
    ops,
  });

  assert.equal(
    body1.sessionPubkey,
    body2.sessionPubkey,
    "idempotent: second call must return the same pubkey as the first",
  );
});

// ---------------------------------------------------------------------------
// Endpoint: binding confirmation
// ---------------------------------------------------------------------------

test("POST /wallet/binding without prior session-signer returns 409 no_session_signer", async () => {
  const { ops } = makeFakeStore();
  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/binding",
    mcpUser: { kind: "oauth", sub: "1004" },
    body: {
      smartAccount: "C" + "A".repeat(55),
      budgetAtomic: "5000000",
      expiryLedger: "99999",
    },
    ops,
  });
  assert.equal(status, 409, `expected 409, got ${status}: ${JSON.stringify(body)}`);
  assert.ok(
    String(body.error ?? "").includes("no_session_signer"),
    `error must be no_session_signer — got: ${JSON.stringify(body)}`,
  );
});

test("POST /wallet/binding after session-signer returns 200 linked", async () => {
  const { ops } = makeFakeStore();
  const sub = "1005";

  // First: issue session signer
  await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub },
    ops,
  });

  // Then: confirm binding
  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/binding",
    mcpUser: { kind: "oauth", sub },
    body: {
      smartAccount: "C" + "A".repeat(55),
      budgetAtomic: "5000000",
      expiryLedger: "99999",
    },
    ops,
  });

  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.status, "linked");
});

test("POST /wallet/binding validates smartAccount is a C-address", async () => {
  const { ops } = makeFakeStore();
  const sub = "1006";

  await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub },
    ops,
  });

  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/binding",
    mcpUser: { kind: "oauth", sub },
    body: {
      smartAccount: "GNOT_A_CONTRACT_ADDRESS_1234567890123456789012345678901234",
      budgetAtomic: "5000000",
      expiryLedger: "99999",
    },
    ops,
  });
  assert.equal(status, 400, `expected 400 for G-address, got ${status}: ${JSON.stringify(body)}`);
});

test("POST /wallet/binding validates budgetAtomic is a positive integer string", async () => {
  const { ops } = makeFakeStore();
  const sub = "1007";

  await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub },
    ops,
  });

  const { status } = await callEndpoint({
    method: "POST",
    path: "/binding",
    mcpUser: { kind: "oauth", sub },
    body: {
      smartAccount: "C" + "A".repeat(55),
      budgetAtomic: "0",
      expiryLedger: "99999",
    },
    ops,
  });
  assert.equal(status, 400, "budgetAtomic=0 must be rejected");
});

// ---------------------------------------------------------------------------
// Endpoint: status
// ---------------------------------------------------------------------------

test("GET /wallet/status reflects pending state (no session-signer yet)", async () => {
  const { ops } = makeFakeStore();
  const { status, body } = await callEndpoint({
    method: "GET",
    path: "/status",
    mcpUser: { kind: "oauth", sub: "1008" },
    ops,
  });
  assert.equal(status, 200);
  assert.equal(body.linked, false);
  assert.equal(body.smartAccount, null);
  assert.equal(body.sessionPubkey, null);
});

test("GET /wallet/status reflects pending after session-signer (not yet bound)", async () => {
  const { ops } = makeFakeStore();
  const sub = "1009";

  await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub },
    ops,
  });

  const { status, body } = await callEndpoint({
    method: "GET",
    path: "/status",
    mcpUser: { kind: "oauth", sub },
    ops,
  });
  assert.equal(status, 200);
  assert.equal(body.linked, false, "linked must be false before binding is confirmed");
  assert.ok(typeof body.sessionPubkey === "string", "sessionPubkey should be present");
  assert.equal(body.smartAccount, null, "smartAccount must be null for pending");
});

test("GET /wallet/status reflects bound state after binding confirmed", async () => {
  const { ops } = makeFakeStore();
  const sub = "1010";

  await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub },
    ops,
  });
  await callEndpoint({
    method: "POST",
    path: "/binding",
    mcpUser: { kind: "oauth", sub },
    body: { smartAccount: "C" + "A".repeat(55), budgetAtomic: "5000000", expiryLedger: "99999" },
    ops,
  });

  const { status, body } = await callEndpoint({
    method: "GET",
    path: "/status",
    mcpUser: { kind: "oauth", sub },
    ops,
  });
  assert.equal(status, 200);
  assert.equal(body.linked, true);
  assert.equal(body.smartAccount, "C" + "A".repeat(55));
  assert.ok(typeof body.sessionPubkey === "string");
  assert.equal(body.budgetAtomic, "5000000");
  assert.equal(body.expiryLedger, "99999");
});

test("GET /wallet/status does NOT expose session secret", async () => {
  const { ops } = makeFakeStore();
  const sub = "1011";

  await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub },
    ops,
  });

  const { body } = await callEndpoint({
    method: "GET",
    path: "/status",
    mcpUser: { kind: "oauth", sub },
    ops,
  });
  assert.ok(!("sessionSignerSecret" in body), "status must not expose session secret");
  assert.ok(!("sessionSignerSecretEnc" in body), "status must not expose encrypted secret");
  assert.ok(!("secret" in body), "status must not expose 'secret' field");
});

// ---------------------------------------------------------------------------
// Endpoint: revoke
// ---------------------------------------------------------------------------

test("POST /wallet/revoke clears the binding and status returns unlinked", async () => {
  const { ops } = makeFakeStore();
  const sub = "1012";

  // Set up bound state
  await callEndpoint({ method: "POST", path: "/session-signer", mcpUser: { kind: "oauth", sub }, ops });
  await callEndpoint({
    method: "POST",
    path: "/binding",
    mcpUser: { kind: "oauth", sub },
    body: { smartAccount: "C" + "A".repeat(55), budgetAtomic: "5000000", expiryLedger: "99999" },
    ops,
  });

  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/revoke",
    mcpUser: { kind: "oauth", sub },
    ops,
  });
  assert.equal(status, 200);
  assert.equal(body.status, "unlinked");

  // Status must now show unlinked
  const { body: statusBody } = await callEndpoint({
    method: "GET",
    path: "/status",
    mcpUser: { kind: "oauth", sub },
    ops,
  });
  assert.equal(statusBody.linked, false);
  assert.equal(statusBody.smartAccount, null);
  assert.equal(statusBody.sessionPubkey, null);
});

test("POST /wallet/revoke on a non-existent binding returns 200 unlinked (idempotent)", async () => {
  const { ops } = makeFakeStore();
  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/revoke",
    mcpUser: { kind: "oauth", sub: "1013" },
    ops,
  });
  assert.equal(status, 200);
  assert.equal(body.status, "unlinked");
});

// ---------------------------------------------------------------------------
// isEarlyAccessGranted unit tests
// ---------------------------------------------------------------------------

test("isEarlyAccessGranted returns true when User row has mcpEarlyAccess=true", async () => {
  // Fake querier that always returns mcpEarlyAccess=true for numeric ids
  const querier: Querier = {
    async query(_sql, _params) {
      return { rows: [{ mcpEarlyAccess: true }] };
    },
  };
  const result = await isEarlyAccessGranted("42", querier);
  assert.equal(result, true, "must return true when mcpEarlyAccess=true");
});

test("isEarlyAccessGranted returns false when User row has mcpEarlyAccess=false", async () => {
  const querier: Querier = {
    async query(_sql, _params) {
      return { rows: [{ mcpEarlyAccess: false }] };
    },
  };
  const result = await isEarlyAccessGranted("7", querier);
  assert.equal(result, false, "must return false when mcpEarlyAccess=false");
});

test("isEarlyAccessGranted returns false when no User row found", async () => {
  const querier: Querier = {
    async query(_sql, _params) {
      return { rows: [] };
    },
  };
  const result = await isEarlyAccessGranted("99", querier);
  assert.equal(result, false, "must return false when user row is missing");
});

test("isEarlyAccessGranted returns false for non-numeric sub", async () => {
  // querier must NOT be called for non-numeric sub
  let queryCalled = false;
  const querier: Querier = {
    async query(_sql, _params) {
      queryCalled = true;
      return { rows: [{ mcpEarlyAccess: true }] };
    },
  };
  const result = await isEarlyAccessGranted("not-a-number", querier);
  assert.equal(result, false, "non-numeric sub must return false");
  assert.equal(queryCalled, false, "querier must not be called for non-numeric sub");
});

test("isEarlyAccessGranted returns false for empty string sub", async () => {
  let queryCalled = false;
  const querier: Querier = {
    async query(_sql, _params) {
      queryCalled = true;
      return { rows: [{ mcpEarlyAccess: true }] };
    },
  };
  const result = await isEarlyAccessGranted("", querier);
  assert.equal(result, false, "empty sub must return false");
  assert.equal(queryCalled, false, "querier must not be called for empty sub");
});

// ---------------------------------------------------------------------------
// Early-access gate: POST /wallet/session-signer and POST /wallet/binding
// are gated on mcpEarlyAccess=true; GET /wallet/status and POST /wallet/revoke
// are NOT gated (safe to call regardless of early-access state).
// ---------------------------------------------------------------------------

test("POST /wallet/session-signer returns 403 early_access_required when mcpEarlyAccess=false", async () => {
  const { ops } = makeFakeStore(false); // earlyAccess=false
  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub: "42" },
    ops,
  });
  assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "early_access_required", `error must be early_access_required — got: ${JSON.stringify(body)}`);
});

test("POST /wallet/session-signer proceeds (200) when mcpEarlyAccess=true", async () => {
  const { ops } = makeFakeStore(true); // earlyAccess=true
  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/session-signer",
    mcpUser: { kind: "oauth", sub: "42" },
    ops,
  });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.ok(typeof body.sessionPubkey === "string", "must return sessionPubkey");
});

test("POST /wallet/binding returns 403 early_access_required when mcpEarlyAccess=false", async () => {
  const { ops } = makeFakeStore(false); // earlyAccess=false
  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/binding",
    mcpUser: { kind: "oauth", sub: "42" },
    body: { smartAccount: "C" + "A".repeat(55), budgetAtomic: "5000000", expiryLedger: "99999" },
    ops,
  });
  assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "early_access_required", `error must be early_access_required — got: ${JSON.stringify(body)}`);
});

test("POST /wallet/binding proceeds (200/409) when mcpEarlyAccess=true (no prior session → 409)", async () => {
  const { ops } = makeFakeStore(true); // earlyAccess=true
  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/binding",
    mcpUser: { kind: "oauth", sub: "42" },
    body: { smartAccount: "C" + "A".repeat(55), budgetAtomic: "5000000", expiryLedger: "99999" },
    ops,
  });
  // Gets past the early-access gate → hits the no_session_signer check (409)
  assert.equal(status, 409, `expected 409 (past gate, no session signer), got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "no_session_signer");
});

test("GET /wallet/status is ungated — succeeds regardless of mcpEarlyAccess=false", async () => {
  const { ops } = makeFakeStore(false); // earlyAccess=false
  const { status, body } = await callEndpoint({
    method: "GET",
    path: "/status",
    mcpUser: { kind: "oauth", sub: "42" },
    ops,
  });
  // Must not return 403 early_access_required — must proceed normally (200)
  assert.equal(status, 200, `status must be ungated (200), got ${status}: ${JSON.stringify(body)}`);
  assert.notEqual(body.error, "early_access_required", "status must not be gated by early-access");
});

test("POST /wallet/revoke is ungated — succeeds regardless of mcpEarlyAccess=false", async () => {
  const { ops } = makeFakeStore(false); // earlyAccess=false
  const { status, body } = await callEndpoint({
    method: "POST",
    path: "/revoke",
    mcpUser: { kind: "oauth", sub: "42" },
    ops,
  });
  // Must not return 403 early_access_required — revoke is always safe (cleanup)
  assert.equal(status, 200, `revoke must be ungated (200), got ${status}: ${JSON.stringify(body)}`);
  assert.notEqual(body.error, "early_access_required", "revoke must not be gated by early-access");
});
