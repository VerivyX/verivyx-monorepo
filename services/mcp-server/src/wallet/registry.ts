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
 * Returns null if no binding exists for this sub.
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
    `SELECT oauth_sub, smart_account, session_signer_pubkey, session_signer_secret_enc, budget_atomic, expiry_ledger
     FROM "McpWallet"
     WHERE oauth_sub = $1`,
    [sub],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const sessionSignerSecret = decryptSecret(row.session_signer_secret_enc as string);

  return {
    oauthSub: row.oauth_sub as string,
    smartAccount: row.smart_account as string,
    sessionSignerPubkey: row.session_signer_pubkey as string,
    sessionSignerSecret,
    budgetAtomic: BigInt(row.budget_atomic as string),
    expiryLedger: BigInt(row.expiry_ledger as string),
  };
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
       (oauth_sub, smart_account, session_signer_pubkey, session_signer_secret_enc, budget_atomic, expiry_ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (oauth_sub) DO UPDATE SET
       smart_account              = EXCLUDED.smart_account,
       session_signer_pubkey      = EXCLUDED.session_signer_pubkey,
       session_signer_secret_enc  = EXCLUDED.session_signer_secret_enc,
       budget_atomic              = EXCLUDED.budget_atomic,
       expiry_ledger              = EXCLUDED.expiry_ledger`,
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
