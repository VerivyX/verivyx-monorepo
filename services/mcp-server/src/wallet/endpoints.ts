/**
 * Wallet lifecycle HTTP endpoints (Plan 3 T1).
 *
 * Mounted at /wallet, behind requireMcpAuth. All endpoints require an OAuth caller
 * (kind:"oauth"); static-key callers receive 403.
 *
 * Lifecycle:
 *   POST /wallet/session-signer  — issue (or retrieve existing) ed25519 session pubkey
 *   POST /wallet/binding         — confirm on-chain delegation (fill smartAccount/budget/expiry)
 *   GET  /wallet/status          — read current binding state
 *   POST /wallet/revoke          — clear server-side binding record
 *
 * The session secret is NEVER logged or returned by any endpoint — only the pubkey.
 * The registry's getBinding returns null for pending rows so the pay path stays correct.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { Router, type Request, type Response } from "express";

import { userLimiter } from "../rateLimit.js";
import type { WalletBinding, WalletStatusRow } from "./registry.js";

// ---------------------------------------------------------------------------
// Injectable registry operations (allows unit tests to inject a fake store)
// ---------------------------------------------------------------------------

export type WalletRegistryOps = {
  getBinding(sub: string): Promise<WalletBinding | null>;
  getWalletStatus(sub: string): Promise<WalletStatusRow | null>;
  /**
   * Returns true only if the user (identified by sub = String(user.id)) has been
   * granted early access to the non-custodial wallet feature (mcpEarlyAccess flag).
   */
  isEarlyAccessGranted(sub: string): Promise<boolean>;
  /** Full upsert — always re-encrypts the session secret. Used on session-signer issuance. */
  upsertBinding(binding: WalletBinding): Promise<void>;
  /**
   * Partial update: set smartAccount/budget/expiry on an existing row WITHOUT touching
   * the existing encrypted session secret. Errors if no row exists for sub.
   */
  bindWallet(sub: string, smartAccount: string, budgetAtomic: bigint, expiryLedger: bigint): Promise<void>;
  deleteBinding(sub: string): Promise<void>;
};

// ---------------------------------------------------------------------------
// Auth guard helper
// ---------------------------------------------------------------------------

type McpUser =
  | { kind: "oauth"; sub: string }
  | { kind: "dashboard"; sub: string }
  | { kind: "key"; label: string };

/**
 * Extracts the user sub from the request for wallet endpoints.
 * Accepts kind:"oauth" (Hydra JWT) and kind:"dashboard" (auth-service HS256 token) —
 * both carry a real user sub = String(user.id).
 * Rejects kind:"key" (static API key has no user identity) with 403.
 * Call at the start of every wallet endpoint handler.
 */
function requireOAuthSub(req: Request, res: Response): string | null {
  const user = (req as Request & { mcpUser?: McpUser }).mcpUser;
  if (!user || user.kind === "key") {
    res.status(403).json({ error: "wallet endpoints require user OAuth" });
    return null;
  }
  return user.sub;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** C-address validation: starts with 'C', 56 base32 chars total (Stellar contract address). */
function isContractAddress(addr: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(addr);
}

/** Positive bigint string: one or more digits, value > 0. */
function isPositiveBigIntString(s: string): boolean {
  if (!/^\d+$/.test(s)) return false;
  try {
    return BigInt(s) > 0n;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Router factory (injectable ops for testability)
// ---------------------------------------------------------------------------

/**
 * Builds the /wallet Express router.
 *
 * @param ops - Injectable registry operations (use live registry in production,
 *   inject a fake in tests to avoid DB/RPC).
 */
export function buildWalletRouter(ops: WalletRegistryOps): Router {
  const router = Router();

  // --------------------------------------------------------------------------
  // POST /wallet/session-signer
  // Issue a per-user ed25519 session keypair and return the pubkey.
  // Idempotent: if a session pubkey already exists for this sub, return it unchanged.
  // Gated: requires mcpEarlyAccess=true on the User row.
  // --------------------------------------------------------------------------
  router.post("/session-signer", userLimiter(20, 3_600_000, "session-signer"), async (req: Request, res: Response) => {
    const sub = requireOAuthSub(req, res);
    if (sub === null) return;

    try {
      if (!(await ops.isEarlyAccessGranted(sub))) {
        res.status(403).json({
          error: "early_access_required",
          detail: "Your account is not yet enabled for non-custodial MCP wallets. Join the early-access waitlist.",
        });
        return;
      }

      // Check for an existing session row (pending or bound)
      const existing = await ops.getWalletStatus(sub);
      if (existing && existing.sessionSignerPubkey) {
        // Return the existing pubkey — idempotent (owner may already reference it in delegation)
        res.json({ sessionPubkey: existing.sessionSignerPubkey });
        return;
      }

      // Generate a fresh ed25519 keypair
      const kp = Keypair.random();
      const pubkey = kp.publicKey();
      const secret = kp.secret();
      // secret is NEVER logged — assigned only to pass into upsertBinding

      await ops.upsertBinding({
        oauthSub: sub,
        smartAccount: "",       // pending: no smart account linked yet
        sessionSignerPubkey: pubkey,
        sessionSignerSecret: secret,
        budgetAtomic: 0n,
        expiryLedger: 0n,
      });

      // Respond with only the pubkey — secret remains server-side only
      res.json({ sessionPubkey: pubkey });
    } catch (err) {
      res.status(500).json({ error: "internal_error", detail: String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // POST /wallet/binding
  // Confirm on-chain delegation: fill smartAccount/budget/expiry onto existing session row.
  // Requires a prior session-signer row (409 if absent).
  // Uses bindWallet to preserve the existing encrypted session secret.
  // Gated: requires mcpEarlyAccess=true on the User row.
  // --------------------------------------------------------------------------
  router.post("/binding", userLimiter(20, 3_600_000, "binding"), async (req: Request, res: Response) => {
    const sub = requireOAuthSub(req, res);
    if (sub === null) return;

    try {
      if (!(await ops.isEarlyAccessGranted(sub))) {
        res.status(403).json({
          error: "early_access_required",
          detail: "Your account is not yet enabled for non-custodial MCP wallets. Join the early-access waitlist.",
        });
        return;
      }
    } catch (err) {
      res.status(500).json({ error: "internal_error", detail: String(err) });
      return;
    }

    const { smartAccount, budgetAtomic, expiryLedger } = (req.body ?? {}) as Record<string, unknown>;

    // Validate smartAccount: must be a C-address (Stellar contract)
    if (typeof smartAccount !== "string" || !isContractAddress(smartAccount)) {
      res.status(400).json({
        error: "invalid_smartAccount",
        detail: "smartAccount must be a Stellar contract C-address (56 chars, C-prefix)",
      });
      return;
    }
    // Validate budgetAtomic: positive integer string
    if (typeof budgetAtomic !== "string" || !isPositiveBigIntString(budgetAtomic)) {
      res.status(400).json({
        error: "invalid_budgetAtomic",
        detail: "budgetAtomic must be a positive integer string",
      });
      return;
    }
    // Validate expiryLedger: positive integer string
    if (typeof expiryLedger !== "string" || !isPositiveBigIntString(expiryLedger)) {
      res.status(400).json({
        error: "invalid_expiryLedger",
        detail: "expiryLedger must be a positive integer string",
      });
      return;
    }

    try {
      // Require an existing session-signer row
      const existing = await ops.getWalletStatus(sub);
      if (!existing || !existing.sessionSignerPubkey) {
        res.status(409).json({
          error: "no_session_signer",
          detail: "call POST /wallet/session-signer first to obtain a session pubkey",
        });
        return;
      }

      // Update account fields only — the existing encrypted session secret is preserved
      await ops.bindWallet(sub, smartAccount, BigInt(budgetAtomic), BigInt(expiryLedger));

      res.json({ status: "linked" });
    } catch (err) {
      res.status(500).json({ error: "internal_error", detail: String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // GET /wallet/status
  // Returns the current binding state for the authenticated OAuth caller.
  // Never exposes the session secret or the encrypted secret column.
  // --------------------------------------------------------------------------
  router.get("/status", userLimiter(60, 60_000, "status"), async (req: Request, res: Response) => {
    const sub = requireOAuthSub(req, res);
    if (sub === null) return;

    try {
      const row = await ops.getWalletStatus(sub);

      if (!row) {
        res.json({
          linked: false,
          smartAccount: null,
          sessionPubkey: null,
          budgetAtomic: null,
          expiryLedger: null,
        });
        return;
      }

      const linked = row.smartAccount !== "";
      res.json({
        linked,
        smartAccount: linked ? row.smartAccount : null,
        sessionPubkey: row.sessionSignerPubkey || null,
        budgetAtomic: linked ? row.budgetAtomic.toString() : null,
        expiryLedger: linked ? row.expiryLedger.toString() : null,
      });
    } catch (err) {
      res.status(500).json({ error: "internal_error", detail: String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // POST /wallet/revoke
  // Clear the server-side binding record. Idempotent (no-op if no row).
  // NOTE: on-chain revoke (remove_signer / policy budget 0) is owner-signed
  //       in the dashboard — this endpoint only clears the server record.
  // --------------------------------------------------------------------------
  router.post("/revoke", userLimiter(20, 3_600_000, "revoke"), async (req: Request, res: Response) => {
    const sub = requireOAuthSub(req, res);
    if (sub === null) return;

    try {
      await ops.deleteBinding(sub);
      res.json({
        status: "unlinked",
        note: "Server record cleared. Also revoke on-chain via the dashboard (remove_signer / spending_limit budget 0).",
      });
    } catch (err) {
      res.status(500).json({ error: "internal_error", detail: String(err) });
    }
  });

  return router;
}
