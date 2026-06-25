export type Framework = "next" | "express" | "hono";
export const FRAMEWORKS: Framework[] = ["next", "express", "hono"];
export interface FrameworkSnippet { id: Framework; label: string; install: string; codeFile: string; code: string; }

export function envBlock(domain: string): string {
  return `VERIVYX_TOKEN=…            # the token shown above\nVERIVYX_DOMAIN=${domain || "example.com"}`;
}

export function snippetFor(fw: Framework, domain: string): FrameworkSnippet {
  switch (fw) {
    case "next":
      return { id: "next", label: "Next.js", install: "npm i @verivyx/paywall-next",
        codeFile: "app/articles/[slug]/route.ts",
        code: `import { verivyxNext } from "@verivyx/paywall-next";\nconst vx = verivyxNext();           // reads VERIVYX_TOKEN / VERIVYX_DOMAIN\nexport const GET = vx.protect(async (_req, ctx) => {\n  const { slug } = (await ctx.params) ?? {};\n  return Response.json(await getArticle(slug));\n});` };
    case "express":
      return { id: "express", label: "Express", install: "npm i @verivyx/paywall-express",
        codeFile: "server.ts",
        code: `import express from "express";\nimport { verivyxExpress } from "@verivyx/paywall-express";\nconst vx = verivyxExpress();        // reads VERIVYX_TOKEN / VERIVYX_DOMAIN\nconst app = express();\napp.get("/articles/:slug", vx.protect((req, res) =>\n  res.json(getArticle(req.params.slug))));` };
    case "hono":
      return { id: "hono", label: "Hono (Workers/Edge)", install: "npm i @verivyx/paywall-hono",
        codeFile: "src/index.ts",
        code: `import { Hono } from "hono";\nimport { verivyxHono } from "@verivyx/paywall-hono";\nconst vx = verivyxHono();           // reads VERIVYX_TOKEN / VERIVYX_DOMAIN\nconst app = new Hono();\napp.get("/articles/:slug", vx.protect((c) =>\n  c.json(getArticle(c.req.param("slug")))));\nexport default app;` };
  }
}
