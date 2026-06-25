-- Per-domain generic publisher body endpoint for the Publisher SDK.
-- Null means fall back to the WordPress internal path (existing behaviour).

ALTER TABLE "User" ADD COLUMN "contentUrl" TEXT;
