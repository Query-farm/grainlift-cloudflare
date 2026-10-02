// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// A Grainlift ADBC gateway on Cloudflare Workers, serving a D1 database.
//
// Grainlift sessions (connections, statements, open result streams) live in
// memory between requests, which a Worker isolate does not guarantee. So the
// Worker forwards every request to one Durable Object that hosts the service:
// it is a single, stateful instance with the D1 binding. When it is evicted
// after idling, sessions end; the Grainlift driver opens a new one for the
// next query (autocommit work only).
import { DurableObject } from "cloudflare:workers";
import {
  AuthContext,
  type AuthenticateFn,
  authenticateAnonymous,
  bearerAuthenticateStatic,
  GrainliftService,
  type HttpOptions,
} from "@query-farm/grainlift";
import { googleIdTokenAuthenticate } from "./google-auth";
import SAMPLE_DATA from "../migrations/0001_sample_data.sql";
import { type SqlStore, SqliteWorker } from "./sqlite";
import { D1Store, DurableSqlStore } from "./stores";

export interface Env {
  DB: D1Database;
  GATEWAY: DurableObjectNamespace<GrainliftGateway>;
  /** A static bearer token for scripts and tests (`wrangler secret put GRAINLIFT_TOKEN`). */
  GRAINLIFT_TOKEN?: string;
  /** Browser origin allowed to call the gateway (e.g. Cupola), or unset. */
  CORS_ORIGIN?: string;
  /** This gateway's public URL: the OAuth resource identifier. */
  PUBLIC_URL?: string;
  /** Google OAuth client ID; set to enable Google sign-in. */
  GOOGLE_CLIENT_ID?: string;
  /** Google OAuth client secret (`wrangler secret put GOOGLE_CLIENT_SECRET`). */
  GOOGLE_CLIENT_SECRET?: string;
  /** Google "TVs and Limited Input devices" client for command-line (device flow) sign-in. */
  GOOGLE_DEVICE_CLIENT_ID?: string;
  /** Its secret (`wrangler secret put GOOGLE_DEVICE_CLIENT_SECRET`). */
  GOOGLE_DEVICE_CLIENT_SECRET?: string;
  /** Comma-separated emails allowed to sign in with Google. */
  ALLOWED_EMAILS?: string;
  /** Comma-separated Google Workspace domains allowed to sign in. */
  ALLOWED_DOMAINS?: string;
  /** "true": requests without credentials are allowed, as principal "anonymous". */
  ALLOW_ANONYMOUS?: string;
  /** "true": refuse writes (for a gateway anyone may query). */
  READ_ONLY?: string;
  /** D1's queries per request: 1000 on Workers Paid, 50 on Free. */
  D1_MAX_QUERIES?: string;
}

export class GrainliftGateway extends DurableObject<Env> {
  private readonly handler: (request: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Two targets, the same SQLite backend over two stores: `d1` (Cloudflare
    // D1) and `sqlite` (this Durable Object's own storage, seeded with the
    // sample tables on first start).
    const stores = new Map<string, SqlStore>([
      ["d1", new D1Store(env.DB, Number(env.D1_MAX_QUERIES ?? 1000))],
      ["sqlite", new DurableSqlStore(ctx.storage)],
    ]);
    void ctx.blockConcurrencyWhile(() => seed(ctx.storage));
    const worker = new SqliteWorker(stores, { readOnly: env.READ_ONLY === "true" });
    const service = new GrainliftService(worker, {
      authorize: (_principal, target) => stores.has(target),
      // Clients that go away without closing (a reloaded browser tab, a killed
      // process) hold sessions until they idle out; keep that window short.
      limits: { sessions: 256, sessionsPerPrincipal: 64, idleMs: 120_000 },
    });
    this.handler = service.httpHandler(authenticator(env), httpOptions(env));
  }

  override async fetch(request: Request): Promise<Response> {
    return this.handler(request);
  }
}

/** Load the sample tables into the Durable Object's SQLite, once. */
async function seed(storage: DurableObjectStorage): Promise<void> {
  if (await storage.get("seeded")) return;
  storage.transactionSync(() => storage.sql.exec(SAMPLE_DATA));
  await storage.put("seeded", true);
}

/** The static token (if set) and Google ID tokens (if configured). */
function authenticator(env: Env): AuthenticateFn {
  const token = env.GRAINLIFT_TOKEN
    ? bearerAuthenticateStatic(new Map([[env.GRAINLIFT_TOKEN, new AuthContext("bearer", true, "token-user")]]))
    : null;
  const google = env.GOOGLE_CLIENT_ID
    ? googleIdTokenAuthenticate({
        clientIds: [env.GOOGLE_CLIENT_ID, env.GOOGLE_DEVICE_CLIENT_ID ?? ""],
        allowedEmails: list(env.ALLOWED_EMAILS),
        allowedDomains: list(env.ALLOWED_DOMAINS),
      })
    : null;
  if (env.ALLOW_ANONYMOUS === "true") {
    // Credentials are optional; a presented token must still be valid.
    return authenticateAnonymous("anonymous", async (request) => {
      const identity = token ? await token(request) : AuthContext.anonymous();
      return identity.authenticated || !google ? identity : google(request);
    });
  }
  if (!token && !google) throw new Error("Set GRAINLIFT_TOKEN or configure Google sign-in");
  return async (request) => {
    const identity = token ? await token(request) : AuthContext.anonymous();
    if (identity.authenticated || !google) return identity;
    return google(request);
  };
}

/**
 * CORS for the browser client, and with Google configured, the OAuth metadata
 * Cupola and the Grainlift driver discover: Google as the issuer, ID tokens as
 * bearers, and this gateway's /_oauth/token proxy, which adds the client
 * secret Google requires to token requests. (VGI-RPC also lists the secret in
 * the metadata, as for VGI services; Google treats it as low-sensitivity.)
 */
function httpOptions(env: Env): HttpOptions {
  const options: HttpOptions = {};
  if (env.CORS_ORIGIN) {
    options.corsOrigins = env.CORS_ORIGIN;
    options.allowedReturnOrigins = new Set([env.CORS_ORIGIN]);
  }
  if (env.GOOGLE_CLIENT_ID) {
    if (!env.PUBLIC_URL || !env.GOOGLE_CLIENT_SECRET)
      throw new Error("Google sign-in needs PUBLIC_URL and the GOOGLE_CLIENT_SECRET secret");
    options.oauthResourceMetadata = {
      resource: env.PUBLIC_URL,
      resourceName: "Grainlift D1 example",
      authorizationServers: ["https://accounts.google.com"],
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      useIdTokenAsBearer: true,
      scopesSupported: ["openid", "email", "profile"],
      // Google's device flow needs its own client type; the driver uses it on
      // headless machines (and its secret, as Google requires one).
      ...(env.GOOGLE_DEVICE_CLIENT_ID
        ? {
            deviceCodeClientId: env.GOOGLE_DEVICE_CLIENT_ID,
            deviceCodeClientSecret: env.GOOGLE_DEVICE_CLIENT_SECRET,
          }
        : {}),
    };
  }
  return options;
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return landingPage(url);
    // One instance: every session must reach the same in-memory service.
    return env.GATEWAY.get(env.GATEWAY.idFromName("gateway")).fetch(request);
  },
} satisfies ExportedHandler<Env>;

function landingPage(url: URL): Response {
  const uri = `grainlift+https://${url.host}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grainlift D1 gateway</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem}code,pre{background:#f4f4f4;border-radius:4px}pre{padding:1rem;overflow-x:auto}</style>
</head><body>
<h1>Grainlift D1 gateway</h1>
<p>An ADBC gateway serving SQLite databases, written with the
<a href="https://github.com/Query-farm/grainlift-typescript">Grainlift TypeScript SDK</a>.
Two targets: <code>d1</code> (a Cloudflare D1 database) and <code>sqlite</code>
(this gateway's own Durable Object storage). Attach one from DuckDB with the
grainlift extension:</p>
<pre>ATTACH '${uri}' AS d1 (TYPE grainlift, target 'd1');
ATTACH '${uri}' AS local (TYPE grainlift, target 'sqlite');
SELECT * FROM d1.countries;</pre>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
