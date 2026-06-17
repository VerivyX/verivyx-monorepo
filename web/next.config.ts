import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The internal OpenAPI specs live outside /public so they are not statically
  // downloadable. Trace them into the standalone build so the admin-gated spec
  // route can read them at runtime.
  outputFileTracingIncludes: {
    "/docs/api/internal/spec/[name]": ["./openapi-internal/**/*"],
  },
};

export default nextConfig;
