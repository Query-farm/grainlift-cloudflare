// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// Google sign-in for the gateway. Google's access tokens are opaque, so
// clients send the OIDC ID token (`use_id_token_as_bearer` in the OAuth
// metadata). It is an RS256 JWT for our client ID, verified here with Web
// Crypto against Google's published signing keys.
import { AuthContext, type AuthenticateFn } from "@query-farm/grainlift";

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const LEEWAY_SECONDS = 60;
/** Refetch the keys at most this often when a token names an unknown key. */
const UNKNOWN_KEY_REFRESH_MS = 60_000;

export interface GoogleAuthOptions {
  /** The OAuth client ID tokens must be issued to (the `aud` claim). */
  clientId: string;
  /** Email addresses allowed in. */
  allowedEmails?: readonly string[];
  /** Google Workspace domains (the `hd` claim) allowed in. */
  allowedDomains?: readonly string[];
}

interface Jwk extends JsonWebKey {
  kid: string;
}

/**
 * Authenticate Google ID tokens. Fails closed: only the listed emails and
 * Workspace domains get an identity, whose principal is the verified email.
 * Requests without a bearer token are anonymous (and rejected by the service).
 */
export function googleIdTokenAuthenticate(options: GoogleAuthOptions): AuthenticateFn {
  const emails = new Set(options.allowedEmails?.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const domains = new Set(options.allowedDomains?.map((d) => d.trim().toLowerCase()).filter(Boolean));
  if (!options.clientId) throw new Error("googleIdTokenAuthenticate needs a client ID");
  if (!emails.size && !domains.size) throw new Error("Allow at least one email or Workspace domain");
  const keys = new GoogleKeys();

  return async (request) => {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return AuthContext.anonymous();
    const claims = await verify(header.slice(7), options.clientId, keys);
    const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
    if (!email || claims.email_verified !== true) throw new Error("Token has no verified email");
    const domain = typeof claims.hd === "string" ? claims.hd.toLowerCase() : null;
    if (!emails.has(email) && !(domain && domains.has(domain))) throw new Error("Account is not allowed");
    return new AuthContext("google", true, email, { sub: claims.sub, email });
  };
}

async function verify(token: string, clientId: string, keys: GoogleKeys): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = JSON.parse(decodeText(headerPart)) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported token");
  const key = await keys.get(header.kid);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlBytes(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Error("Invalid signature");
  const claims = JSON.parse(decodeText(payloadPart)) as Record<string, unknown>;
  const now = Date.now() / 1000;
  if (!GOOGLE_ISSUERS.has(claims.iss as string)) throw new Error("Wrong issuer");
  if (claims.aud !== clientId) throw new Error("Wrong audience");
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS < now) throw new Error("Token expired");
  if (typeof claims.iat === "number" && claims.iat - LEEWAY_SECONDS > now) throw new Error("Token not yet valid");
  return claims;
}

/** Google's signing keys, cached for as long as Google's Cache-Control allows. */
class GoogleKeys {
  private keys = new Map<string, CryptoKey>();
  private expires = 0;
  private lastFetch = 0;

  async get(kid: string): Promise<CryptoKey> {
    const now = Date.now();
    if (now >= this.expires || (!this.keys.has(kid) && now - this.lastFetch >= UNKNOWN_KEY_REFRESH_MS)) {
      await this.refresh();
    }
    const key = this.keys.get(kid);
    if (!key) throw new Error("Unknown signing key");
    return key;
  }

  private async refresh(): Promise<void> {
    this.lastFetch = Date.now();
    const response = await fetch(GOOGLE_JWKS);
    if (!response.ok) throw new Error("Google signing keys are unavailable");
    const { keys } = (await response.json()) as { keys: Jwk[] };
    const imported = new Map<string, CryptoKey>();
    for (const jwk of keys) {
      if (jwk.kty !== "RSA") continue;
      imported.set(
        jwk.kid,
        await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      );
    }
    this.keys = imported;
    const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
    this.expires = Date.now() + (maxAge ? Number(maxAge) * 1000 : 3_600_000);
  }
}

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function decodeText(value: string): string {
  return new TextDecoder().decode(base64UrlBytes(value));
}
