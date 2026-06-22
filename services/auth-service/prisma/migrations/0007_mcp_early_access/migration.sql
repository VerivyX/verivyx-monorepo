-- Per-user early-access flag for the non-custodial MCP wallet feature.
-- Defaults false; granted/revoked via POST /api/v1/admin/mcp/early-access.

ALTER TABLE "User" ADD COLUMN "mcpEarlyAccess" BOOLEAN NOT NULL DEFAULT false;
