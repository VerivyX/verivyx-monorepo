-- AlterTable: add apiKey and platformFee to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiKey" TEXT UNIQUE DEFAULT gen_random_uuid()::TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "platformFee" DECIMAL(10,7) NOT NULL DEFAULT 0.0010000;

-- CreateUniqueIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_apiKey_key" ON "User"("apiKey");
