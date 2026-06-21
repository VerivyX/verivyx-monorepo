/**
 * Identity↔smart-account wallet binding registry.
 *
 * Maps an MCP caller's OAuth identity (Hydra `sub`) to their on-chain smart account
 * and a delegated, budget-capped session signer. The session signer's secret is stored
 * ENCRYPTED at rest using AES-256-GCM (key from MCP_WALLET_ENC_KEY env var).
 *
 * The owner master key is NEVER stored — non-custodial design.
 *
 * If MCP_WALLET_ENC_KEY is unset the wallet feature is DISABLED: all registry
 * functions throw a clear error rather than storing plaintext. There is no
 * plaintext-at-rest fallback.
 *
 * Encryption format (stored in session_signer_secret_enc):
 *   base64(iv):base64(authTag):base64(ciphertext)
 *   - iv: 12 random bytes (GCM standard)
 *   - authTag: 16 bytes (GCM authentication tag)
 *   - ciphertext: encrypted session signer secret
 *
 * The pg querier is injectable via optional parameter to keep unit tests DB-free.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** In-memory representation of a wallet binding (plaintext secret). */
export type WalletBinding = {
  oauthSub: string;
  smartAccount: string;
  sessionSignerPubkey: string;
  /** Plaintext session signer secret — NEVER stored to DB in this form. */
  sessionSignerSecret: string;
  budgetAtomic: bigint;
  expiryLedger: bigint;
};

/** Minimal pg querier interface (injectable for tests). */
export type Querier = {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

// ---------------------------------------------------------------------------
// Encryption key management
// ---------------------------------------------------------------------------

const ENC_ALGO = "aes-256-gcm" as const;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Reads and validates the encryption key from the environment.
 * Throws a clear error if the key is missing — never falls back to plaintext.
 */
function getEncKey(): Buffer {
  const raw = process.env.MCP_WALLET_ENC_KEY?.trim();
  if (!raw) {
    throw new Error(
      "MCP_WALLET_ENC_KEY is not set — wallet binding feature is disabled. " +
        "Set a 32-byte key (hex or base64) to enable encrypted session key storage.",
    );
  }
  // Accept 64-char hex (32 bytes) or base64 (43–44 chars for 32 bytes)
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }
  if (key.length !== 32) {
    throw new Error(
      `MCP_WALLET_ENC_KEY must be exactly 32 bytes (got ${key.length}). ` +
        "Provide it as 64 hex chars or base64.",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypts a plaintext string using AES-256-GCM with a random 12-byte IV.
 * Returns: base64(iv):base64(authTag):base64(ciphertext)
 * The encrypted secret MUST NEVER be logged.
 */
export function encryptSecret(plaintext: string): string {
  const key = getEncKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENC_ALGO, key, iv);
  const ctBufs: Buffer[] = [];
  ctBufs.push(cipher.update(plaintext, "utf8"));
  ctBufs.push(cipher.final());
  const ciphertext = Buffer.concat(ctBufs);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypts a value produced by encryptSecret.
 * Format expected: base64(iv):base64(authTag):base64(ciphertext)
 * Throws if authentication fails (tampered data).
 */
export function decryptSecret(encoded: string): string {
  const key = getEncKey();
  const parts = encoded.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secret format — expected iv:authTag:ciphertext");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");

  if (iv.length !== IV_BYTES) {
    throw new Error(`Invalid IV length: expected ${IV_BYTES} bytes, got ${iv.length}`);
  }
  if (authTag.length !== TAG_BYTES) {
    throw new Error(`Invalid auth tag length: expected ${TAG_BYTES} bytes, got ${authTag.length}`);
  }

  const decipher = createDecipheriv(ENC_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const bufs: Buffer[] = [];
  bufs.push(decipher.update(ciphertext));
  bufs.push(decipher.final());
  return Buffer.concat(bufs).toString("utf8");
}

// ---------------------------------------------------------------------------
// Module-singleton pg Pool (lazy — only created when needed in production)
// ---------------------------------------------------------------------------

let _singletonQuerier: Querier | undefined;

function getSingletonQuerier(): Querier {
  if (_singletonQuerier) return _singletonQuerier;
  // Lazy dynamic import of pg so tests (which inject a fake) never touch pg.
  // We use a sync require-style approach: pg Pool is created once and cached.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg") as typeof import("pg");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  _singletonQuerier = {
    query: (sql, params) => pool.query(sql, params as import("pg").QueryConfigValues<unknown[]>),
  };
  return _singletonQuerier;
}

// ---------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------

/**
 * Retrieves a wallet binding for the given OAuth sub, decrypting the session secret.
 * Returns null if:
 *   - No row exists for this sub, OR
 *   - The row is in pending state (smartAccount === "") — not yet a usable binding.
 *
 * The pay path uses this function and must treat both cases identically (no-wallet).
 * Use getWalletStatus to read raw rows including pending state.
 *
 * @param sub - Hydra OAuth subject identifier
 * @param querier - Optional injected querier (defaults to singleton pg Pool)
 */
export async function getBinding(
  sub: string,
  querier?: Querier,
): Promise<WalletBinding | null> {
  // Validate enc key first — fail fast if feature is disabled.
  // (getEncKey throws if MCP_WALLET_ENC_KEY is unset)
  getEncKey();

  const q = querier ?? getSingletonQuerier();
  const result = await q.query(
    `SELECT "oauthSub", "smartAccount", "sessionSignerPubkey", "sessionSignerSecretEnc", "budgetAtomic", "expiryLedger"
     FROM "McpWallet"
     WHERE "oauthSub" = $1`,
    [sub],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];

  // Pending row: session key issued but no smart account linked yet.
  // Return null so the pay path treats this as no-wallet (same as no row).
  if ((row.smartAccount as string) === "") return null;

  const sessionSignerSecret = decryptSecret(row.sessionSignerSecretEnc as string);

  return {
    oauthSub: row.oauthSub as string,
    smartAccount: row.smartAccount as string,
    sessionSignerPubkey: row.sessionSignerPubkey as string,
    sessionSignerSecret,
    budgetAtomic: BigInt(row.budgetAtomic as string),
    expiryLedger: BigInt(row.expiryLedger as string),
  };
}

/** Raw row from McpWallet — secret is NOT decrypted (suitable for status reads). */
export type WalletStatusRow = {
  oauthSub: string;
  smartAccount: string;
  sessionSignerPubkey: string;
  budgetAtomic: bigint;
  expiryLedger: bigint;
};

/**
 * Retrieves a wallet binding for the given OAuth sub, decrypting the session secret.
 * Returns null if no binding exists OR if the row is pending (smartAccount === "").
 *
 * A pending row (session key issued but no smart account linked yet) is NOT a usable
 * binding — the pay path must keep treating it as no-wallet. Use getWalletStatus to
 * read the raw row including pending rows.
 *
 * @param sub - Hydra OAuth subject identifier
 * @param querier - Optional injected querier (defaults to singleton pg Pool)
 */

/**
 * Retrieves the raw wallet status row for a given OAuth sub WITHOUT decrypting the secret.
 * Returns null if no row exists (but returns the row even if pending / smartAccount="").
 *
 * Use this for the /wallet/status endpoint where you need to see the pending state.
 *
 * @param sub - Hydra OAuth subject identifier
 * @param querier - Optional injected querier (defaults to singleton pg Pool)
 */
export async function getWalletStatus(
  sub: string,
  querier?: Querier,
): Promise<WalletStatusRow | null> {
  getEncKey();

  const q = querier ?? getSingletonQuerier();
  const result = await q.query(
    `SELECT "oauthSub", "smartAccount", "sessionSignerPubkey", "budgetAtomic", "expiryLedger"
     FROM "McpWallet"
     WHERE "oauthSub" = $1`,
    [sub],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    oauthSub: row.oauthSub as string,
    smartAccount: row.smartAccount as string,
    sessionSignerPubkey: row.sessionSignerPubkey as string,
    budgetAtomic: BigInt(row.budgetAtomic as string),
    expiryLedger: BigInt(row.expiryLedger as string),
  };
}

/**
 * Deletes the wallet binding row for the given sub (revoke).
 * Idempotent: no-op if no row exists.
 *
 * @param sub - Hydra OAuth subject identifier
 * @param querier - Optional injected querier (defaults to singleton pg Pool)
 */
export async function deleteBinding(
  sub: string,
  querier?: Querier,
): Promise<void> {
  const q = querier ?? getSingletonQuerier();
  await q.query(`DELETE FROM "McpWallet" WHERE "oauthSub" = $1`, [sub]);
}

/**
 * Partial update: sets smartAccount, budgetAtomic, and expiryLedger on an existing row
 * WITHOUT touching the encrypted session secret. Used by POST /wallet/binding to confirm
 * an on-chain delegation while preserving the existing session keypair.
 *
 * @param sub - Hydra OAuth subject identifier
 * @param smartAccount - Stellar contract C-address of the user's smart account
 * @param budgetAtomic - Delegation spending limit in USDC atomic units
 * @param expiryLedger - Delegation valid_until ledger sequence number
 * @param querier - Optional injected querier (defaults to singleton pg Pool)
 */
export async function bindWallet(
  sub: string,
  smartAccount: string,
  budgetAtomic: bigint,
  expiryLedger: bigint,
  querier?: Querier,
): Promise<void> {
  const q = querier ?? getSingletonQuerier();
  await q.query(
    `UPDATE "McpWallet"
     SET "smartAccount" = $2, "budgetAtomic" = $3, "expiryLedger" = $4
     WHERE "oauthSub" = $1`,
    [sub, smartAccount, budgetAtomic.toString(), expiryLedger.toString()],
  );
}

/**
 * Upserts a wallet binding, encrypting the session secret before storage.
 * The plaintext sessionSignerSecret NEVER touches the DB column.
 *
 * @param binding - Wallet binding (plaintext secret in memory)
 * @param querier - Optional injected querier (defaults to singleton pg Pool)
 */
export async function upsertBinding(
  binding: WalletBinding,
  querier?: Querier,
): Promise<void> {
  const secretEnc = encryptSecret(binding.sessionSignerSecret);

  const q = querier ?? getSingletonQuerier();
  await q.query(
    `INSERT INTO "McpWallet"
       ("oauthSub", "smartAccount", "sessionSignerPubkey", "sessionSignerSecretEnc", "budgetAtomic", "expiryLedger")
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ("oauthSub") DO UPDATE SET
       "smartAccount"             = EXCLUDED."smartAccount",
       "sessionSignerPubkey"      = EXCLUDED."sessionSignerPubkey",
       "sessionSignerSecretEnc"   = EXCLUDED."sessionSignerSecretEnc",
       "budgetAtomic"             = EXCLUDED."budgetAtomic",
       "expiryLedger"             = EXCLUDED."expiryLedger"`,
    [
      binding.oauthSub,
      binding.smartAccount,
      binding.sessionSignerPubkey,
      secretEnc,
      binding.budgetAtomic.toString(),
      binding.expiryLedger.toString(),
    ],
  );
}
