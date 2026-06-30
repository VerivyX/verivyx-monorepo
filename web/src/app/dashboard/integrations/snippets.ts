export type Framework = "next" | "express" | "hono";
export const FRAMEWORKS: Framework[] = ["next", "express", "hono"];
export interface FrameworkSnippet { id: Framework; label: string; install: string; codeFile: string; code: string; }

// Placeholder used in snippets before the real site token has loaded.
const TOKEN_PLACEHOLDER = "vx_live_…";

// Build the copy-paste integration snippet for a framework, with the site token
// inlined. The SDK is configured token-only — no domain, no DNS verification.
export function snippetFor(fw: Framework, token: string): FrameworkSnippet {
  const t = token || TOKEN_PLACEHOLDER;
  switch (fw) {
    case "next":
      return { id: "next", label: "Next.js", install: "npm i @verivyx/paywall-next",
        codeFile: "middleware.ts",
        code: `import { verivyxProxy } from "@verivyx/paywall-next";\n\nexport const middleware = verivyxProxy({ token: "${t}" });\n\nexport const config = { matcher: ["/articles/:path*"] };` };
    case "express":
      return { id: "express", label: "Express", install: "npm i @verivyx/paywall-express",
        codeFile: "server.ts",
        code: `import express from "express";\nimport { verivyxMiddleware } from "@verivyx/paywall-express";\n\nconst app = express();\napp.use(verivyxMiddleware({ token: "${t}" }));` };
    case "hono":
      return { id: "hono", label: "Hono (Workers/Edge)", install: "npm i @verivyx/paywall-hono",
        codeFile: "src/index.ts",
        code: `import { Hono } from "hono";\nimport { verivyxHonoMiddleware } from "@verivyx/paywall-hono";\n\nconst app = new Hono();\napp.use(verivyxHonoMiddleware({ token: "${t}" }));\nexport default app;` };
  }
}
