-- AlterTable: add on-chain transaction proof + recorded split to Event
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "distributeTransaction" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "creatorAmountUsdc" DECIMAL(65,30);
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "platformAmountUsdc" DECIMAL(65,30);
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "network" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "asset" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "payer" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "status" TEXT;
