-- Auth v2: email verification + deferred onboarding (wallet/domain collected later).
-- NOTE: the service entrypoint applies schema via `prisma db push`, so this file is
-- a record of the intended change. The backfill below must also be run once against
-- any pre-existing rows (see deploy step) so current creators are not locked out.

-- Wallet + domain are now optional (set during the onboarding wizard).
ALTER TABLE "User" ALTER COLUMN "stellar_address" DROP NOT NULL;
ALTER TABLE "User" ALTER COLUMN "domain" DROP NOT NULL;

-- Email verification flag (hard gate on login).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing accounts predate verification — treat them as verified so
-- they keep their access. New registrations are created with emailVerified=false.
UPDATE "User" SET "emailVerified" = true;

-- Single-use email tokens (verification, future password reset). Stores only the hash.
CREATE TABLE IF NOT EXISTS "EmailToken" (
    "id"        SERIAL       NOT NULL,
    "userId"    INTEGER      NOT NULL,
    "tokenHash" TEXT         NOT NULL,
    "type"      TEXT         NOT NULL DEFAULT 'VERIFY',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EmailToken_tokenHash_key" ON "EmailToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "EmailToken_userId_idx" ON "EmailToken"("userId");

ALTER TABLE "EmailToken" ADD CONSTRAINT "EmailToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
