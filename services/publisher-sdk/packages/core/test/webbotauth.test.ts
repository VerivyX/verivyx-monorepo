import { describe, it, expect } from "vitest";
import { verifyWebBotAuth } from "../src/webbotauth";

// ---------------------------------------------------------------------------
// Test-vector construction helpers
//
// The official web-bot-auth architecture draft (Appendix A.1.2) only publishes
// an RSA-PSS vector. The Verivyx core verifier is Ed25519-only and edge-portable
// (WebCrypto). Per the task brief we therefore construct a *self-consistent*
// Ed25519 vector at test time: generate a keypair via crypto.subtle, build a
// request with a correct Signature / Signature-Input, sign the reconstructed
// RFC 9421 signature base, set keyid = RFC 7638 base64url SHA-256 thumbprint of
// the public JWK, and inject the public JWK via deps.fetchDirectory.
//
// This proves the round-trip: signature-base reconstruction + Ed25519 verify.
// ---------------------------------------------------------------------------

const TARGET_URL = "https://example.com/articles/secret";
const SIGNATURE_AGENT = "https://signer.example";
const LABEL = "sig1";

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7638 / RFC 8037 A.3 thumbprint for an Ed25519 (OKP) public JWK. */
async function ed25519Thumbprint(jwk: JsonWebKey): Promise<string> {
  // Lexicographic member order for OKP: crv, kty, x
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return b64url(digest);
}

interface VectorParams {
  created?: number;
  expires?: number;
  tag?: string | null;
  components?: string[];
  /** Override the keyid placed in Signature-Input (defaults to real thumbprint). */
  keyidOverride?: string;
  /** Tamper the signature bytes after signing. */
  tamperSig?: boolean;
  /** Sign a base that differs from what the verifier will reconstruct. */
  signWrongTargetUri?: string;
}

interface Vector {
  req: Request;
  publicJwk: JsonWebKey;
  thumbprint: string;
}

function buildSignatureBase(
  url: string,
  signatureAgent: string,
  components: string[],
  paramStr: string,
): string {
  const u = new URL(url);
  const lines: string[] = [];
  for (const c of components) {
    if (c === "@authority") {
      lines.push(`"@authority": ${u.host}`);
    } else if (c === "@target-uri") {
      lines.push(`"@target-uri": ${url}`);
    } else if (c === "signature-agent") {
      lines.push(`"signature-agent": "${signatureAgent}"`);
    } else {
      throw new Error(`unhandled component in test: ${c}`);
    }
  }
  const innerList = components.map((c) => `"${c}"`).join(" ");
  lines.push(`"@signature-params": (${innerList})${paramStr}`);
  return lines.join("\n");
}

async function makeVector(p: VectorParams = {}): Promise<Vector> {
  const now = Math.floor(Date.now() / 1000);
  const created = p.created ?? now - 60;
  const expires = p.expires ?? now + 600;
  const components = p.components ?? ["@authority", "@target-uri", "signature-agent"];

  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const thumbprint = await ed25519Thumbprint(publicJwk);
  const keyid = p.keyidOverride ?? thumbprint;

  // Build the @signature-params parameter string. tag=null omits the tag.
  let paramStr =
    `;created=${created};keyid="${keyid}";alg="ed25519";expires=${expires}`;
  if (p.tag !== null) {
    paramStr += `;tag="${p.tag ?? "web-bot-auth"}"`;
  }

  const base = buildSignatureBase(
    p.signWrongTargetUri ?? TARGET_URL,
    SIGNATURE_AGENT,
    components,
    paramStr,
  );

  const sigBytes = await crypto.subtle.sign(
    { name: "Ed25519" },
    kp.privateKey,
    new TextEncoder().encode(base),
  );
  const sig = new Uint8Array(sigBytes);
  if (p.tamperSig) sig[0]! ^= 0xff;

  const sigInputHeader = `${LABEL}=(${components
    .map((c) => `"${c}"`)
    .join(" ")})${paramStr}`;
  const sigHeader = `${LABEL}=:${b64url(sig)}:`;

  const req = new Request(TARGET_URL, {
    headers: {
      "signature-agent": `"${SIGNATURE_AGENT}"`,
      "signature-input": sigInputHeader,
      signature: sigHeader,
    },
  });

  return { req, publicJwk, thumbprint };
}

function directoryFrom(jwk: JsonWebKey) {
  return async () => [jwk];
}

describe("verifyWebBotAuth", () => {
  it("returns true for a valid Ed25519 web-bot-auth signature", async () => {
    const v = await makeVector();
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(true);
  });

  it("returns false when expires is in the past", async () => {
    const now = Math.floor(Date.now() / 1000);
    const v = await makeVector({ created: now - 7200, expires: now - 3600 });
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false when created is in the future (beyond skew)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const v = await makeVector({ created: now + 3600, expires: now + 7200 });
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false when the validity window exceeds 24h", async () => {
    const now = Math.floor(Date.now() / 1000);
    const v = await makeVector({
      created: now - 60,
      expires: now + 25 * 3600,
    });
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false when tag is wrong", async () => {
    const v = await makeVector({ tag: "not-web-bot-auth" });
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false when tag is missing", async () => {
    const v = await makeVector({ tag: null });
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false when keyid is not found in the directory", async () => {
    const v = await makeVector({ keyidOverride: "deadbeef-not-a-real-thumb" });
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false when the signature bytes are tampered", async () => {
    const v = await makeVector({ tamperSig: true });
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false when covered content was signed over a different target-uri", async () => {
    // Sign over a different URI than the request actually targets → base mismatch.
    const v = await makeVector({
      signWrongTargetUri: "https://example.com/articles/OTHER",
    });
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false when @target-uri is not among covered components", async () => {
    const v = await makeVector({ components: ["@authority"] });
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false when @authority is not among covered components", async () => {
    const v = await makeVector({ components: ["@target-uri"] });
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false on malformed Signature-Input", async () => {
    const req = new Request(TARGET_URL, {
      headers: {
        "signature-input": "this is not a valid structured field !!!",
        signature: "sig1=:AAAA:",
      },
    });
    const ok = await verifyWebBotAuth(req, {
      fetchDirectory: async () => [],
    });
    expect(ok).toBe(false);
  });

  it("returns false when Signature header is missing", async () => {
    const v = await makeVector();
    const req = new Request(TARGET_URL, {
      headers: {
        "signature-agent": `"${SIGNATURE_AGENT}"`,
        "signature-input": v.req.headers.get("signature-input")!,
      },
    });
    const ok = await verifyWebBotAuth(req, {
      fetchDirectory: directoryFrom(v.publicJwk),
    });
    expect(ok).toBe(false);
  });

  it("returns false when Signature-Input header is missing", async () => {
    const req = new Request(TARGET_URL, {
      headers: { signature: "sig1=:AAAA:" },
    });
    const ok = await verifyWebBotAuth(req, {
      fetchDirectory: async () => [],
    });
    expect(ok).toBe(false);
  });

  it("never throws on garbage input (returns false)", async () => {
    const req = new Request(TARGET_URL, {
      headers: {
        "signature-input": "sig1=();created=abc;keyid=",
        signature: "garbage",
      },
    });
    await expect(
      verifyWebBotAuth(req, { fetchDirectory: async () => [] }),
    ).resolves.toBe(false);
  });

  it("default directory fetch is bypassable via injected deps (no network in test)", async () => {
    // Sanity: omitting fetchDirectory would attempt a real network fetch;
    // here we confirm the injected path is honored and deterministic.
    const v = await makeVector();
    let fetched = false;
    const ok = await verifyWebBotAuth(v.req, {
      fetchDirectory: async () => {
        fetched = true;
        return [v.publicJwk];
      },
    });
    expect(fetched).toBe(true);
    expect(ok).toBe(true);
  });
});
