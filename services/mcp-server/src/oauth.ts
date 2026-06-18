import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Build the RFC 9728 Protected Resource Metadata document for this server.
 */
export function buildProtectedResourceMetadata(resourceUri: string, issuer: string) {
  return {
    resource: resourceUri,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid"],
  };
}

/**
 * Build the WWW-Authenticate header value that points an unauthorized client
 * at our Protected Resource Metadata document.
 */
export function wwwAuthenticateValue(resourceMetadataUrl: string): string {
  return `Bearer error="unauthorized", resource_metadata="${resourceMetadataUrl}"`;
}

/**
 * Build a stateful JWT verifier that fetches Hydra's JWKS on first use and
 * caches the key set for subsequent calls.
 */
export function makeTokenVerifier(opts: { jwksUrl: string; issuer: string; audience: string }) {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  return async (token: string): Promise<{ sub: string; scope?: string }> => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: opts.issuer,
      audience: opts.audience,
    });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("token missing sub");
    return {
      sub: payload.sub,
      scope: typeof payload.scope === "string" ? payload.scope : undefined,
    };
  };
}
