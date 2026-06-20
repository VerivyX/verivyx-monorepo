-- MCP wallet binding: binds a Hydra OAuth sub to the caller's on-chain smart account
-- and the delegated session signer the MCP uses to pay on their behalf.
-- The owner master key is never stored; sessionSignerSecretEnc holds the AES-256-GCM
-- encrypted session signer secret (key: MCP_WALLET_ENC_KEY in mcp-server).

CREATE TABLE IF NOT EXISTS "McpWallet" (
    "oauthSub"               TEXT             NOT NULL,
    "smartAccount"           TEXT             NOT NULL,
    "sessionSignerPubkey"    TEXT             NOT NULL,
    "sessionSignerSecretEnc" TEXT             NOT NULL,
    "budgetAtomic"           DECIMAL(65,30)   NOT NULL,
    "expiryLedger"           BIGINT           NOT NULL,
    "createdAt"              TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "McpWallet_pkey" PRIMARY KEY ("oauthSub")
);
