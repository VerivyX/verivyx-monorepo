import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL?.trim() || "info",
  // Never serialize raw request bodies / secrets.
  redact: {
    paths: ["req.headers.authorization", 'req.headers["x-verivyx-mcp-key"]', "*.secret", "*.secretKey"],
    remove: true,
  },
});
