// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// Sign-in with any OpenID Connect provider: Google, Okta, Auth0, Microsoft
// Entra ID and others. Clients send the OIDC ID token as their bearer token
// (`use_id_token_as_bearer` in the OAuth metadata), because providers differ
// in what their access tokens are (Google's are opaque), while every ID token
// is a JWT for our client ID. It is verified here with Web Crypto against the
// keys the provider publishes (found through its discovery document).
//
// Authentication only says who the user is. Whether they may use anything is
// decided by PERMISSIONS (src/permissions.ts).
import { AuthContext, type AuthenticateFn } from "@query-farm/grainlift";

const LEEWAY_SECONDS = 60;
/** Refetch the keys at most this often when a token names an unknown key. */
const UNKNOWN_KEY_REFRESH_MS = 60_000;
const GOOGLE = "https://accounts.google.com";

export interface OidcOptions {
  /** The provider's issuer URL, such as https://accounts.google.com. */
  issuer: string;
  /** OAuth client IDs tokens may be issued to (the `aud` claim): the browser
   *  client and, for command-line sign-in, the device-flow client. */
  clientIds: readonly string[];
  /** The claim naming the user, which PERMISSIONS keys match. Default `email`. */
  principalClaim?: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

/**
 * Authenticate the provider's ID tokens. The principal is the `email` claim
 * (lowercase), which must be verified (`email_verified`), or another claim
 * named by `principalClaim`. Requests without a bearer token are anonymous.
 */
export function oidcAuthenticate(options: OidcOptions): AuthenticateFn {
  const issuer = options.issuer.replace(/\/+$/, "");
  const audiences = new Set(options.clientIds.filter(Boolean));
  if (!audiences.size) throw new Error("OIDC sign-in needs a client ID (OIDC_CLIENT_ID)");
  const claim = options.principalClaim || "email";
  // Google also issues tokens with the scheme-less issuer.
  const issuers = new Set(issuer === GOOGLE ? [GOOGLE, "accounts.google.com"] : [issuer]);
  const keys = new SigningKeys(issuer);

  return async (request) => {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return AuthContext.anonymous();
    const claims = await verify(header.slice(7), issuers, audiences, keys);
    const value = claims[claim];
    if (typeof value !== "string" || !value) throw new Error(`Token has no ${claim} claim`);
    let principal = value;
    if (claim === "email") {
      if (claims.email_verified !== true) throw new Error("Token has no verified email");
      principal = value.toLowerCase();
      // A Google account can carry any email address it verified, including
      // one at a domain its owner does not control as an organization. Only
      // a Workspace account (`hd`) speaks for its domain, so PERMISSIONS
      // domain keys ("@example.com") stay trustworthy.
      if (issuer === GOOGLE) {
        const domain = principal.slice(principal.lastIndexOf("@") + 1);
        const workspace = typeof claims.hd === "string" ? claims.hd.toLowerCase() : null;
        if (domain !== workspace && domain !== "gmail.com" && domain !== "googlemail.com") {
          throw new Error("Sign in with a Google Workspace account or a Gmail address");
        }
      }
    }
    return new AuthContext("oidc", true, principal, { sub: claims.sub, iss: claims.iss });
  };
}

async function verify(
  token: string,
  issuers: ReadonlySet<string>,
  audiences: ReadonlySet<string>,
  keys: SigningKeys,
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = JSON.parse(decodeText(headerPart)) as { alg?: string; kid?: string };
  const algorithm = ALGORITHMS[header.alg ?? ""];
  if (!algorithm || !header.kid) throw new Error("Unsupported token");
  const key = await keys.get(header.kid, header.alg!);
  const valid = await crypto.subtle.verify(
    algorithm.verify,
    key,
    base64UrlBytes(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Error("Invalid signature");
  const claims = JSON.parse(decodeText(payloadPart)) as Record<string, unknown>;
  const now = Date.now() / 1000;
  if (!issuers.has(claims.iss as string)) throw new Error("Wrong issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === "string" && audiences.has(a))) throw new Error("Wrong audience");
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS < now) throw new Error("Token expired");
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_SECONDS > now) throw new Error("Token not yet valid");
  if (typeof claims.iat === "number" && claims.iat - LEEWAY_SECONDS > now) throw new Error("Token not yet valid");
  return claims;
}

/** The signature algorithms accepted, as Web Crypto parameters. */
type ImportAlgorithm = Parameters<typeof crypto.subtle.importKey>[2];
type VerifyAlgorithm = Parameters<typeof crypto.subtle.verify>[0];
const ALGORITHMS: Record<string, { import: ImportAlgorithm; verify: VerifyAlgorithm }> = {
  RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: "RSASSA-PKCS1-v1_5" },
  ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
};

/** The provider's signing keys, from its discovery document's `jwks_uri`, cached per Cache-Control. */
class SigningKeys {
  private jwksUri: string | null = null;
  private keys = new Map<string, Jwk>();
  private imported = new Map<string, CryptoKey>();
  private expires = 0;
  private lastFetch = 0;

  constructor(private readonly issuer: string) {}

  async get(kid: string, alg: string): Promise<CryptoKey> {
    const now = Date.now();
    if (now >= this.expires || (!this.keys.has(kid) && now - this.lastFetch >= UNKNOWN_KEY_REFRESH_MS)) {
      await this.refresh();
    }
    const jwk = this.keys.get(kid);
    if (!jwk) throw new Error("Unknown signing key");
    const cacheKey = `${kid}/${alg}`;
    let key = this.imported.get(cacheKey);
    if (!key) {
      key = await crypto.subtle.importKey("jwk", jwk, ALGORITHMS[alg]!.import, false, ["verify"]);
      this.imported.set(cacheKey, key);
    }
    return key;
  }

  private async refresh(): Promise<void> {
    this.lastFetch = Date.now();
    if (!this.jwksUri) {
      const response = await fetch(`${this.issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error("The sign-in provider's discovery document is unavailable");
      const { jwks_uri: uri } = (await response.json()) as { jwks_uri?: string };
      if (!uri?.startsWith("https://")) throw new Error("The sign-in provider publishes no HTTPS jwks_uri");
      this.jwksUri = uri;
    }
    const response = await fetch(this.jwksUri);
    if (!response.ok) throw new Error("The sign-in provider's signing keys are unavailable");
    const { keys } = (await response.json()) as { keys: Jwk[] };
    this.keys = new Map(keys.filter((k) => k.kid && (k.kty === "RSA" || k.kty === "EC")).map((k) => [k.kid!, k]));
    this.imported = new Map();
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
