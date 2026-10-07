// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// A Grainlift ADBC gateway on Cloudflare Workers, serving Durable Objects and
// D1 databases.
//
// Grainlift sessions (connections, statements, open result streams) live in
// memory between requests, which a Worker isolate does not guarantee. So the
// Worker forwards every request to one Durable Object that hosts the service:
// it is a single, stateful instance with the bindings. When it is evicted
// after idling, sessions end; the Grainlift driver opens a new one for the
// next query (autocommit work only).
import { DurableObject } from "cloudflare:workers";
import {
  AdbcError,
  AuthContext,
  type AuthenticateFn,
  authenticateAnonymous,
  bearerAuthenticateStatic,
  GrainliftService,
  type HttpOptions,
  type OpenOptions,
  type Worker,
} from "@query-farm/grainlift";
import SAMPLE_DATA from "../migrations/0001_sample_data.sql";
import { ANALYTICS_ENGINE_OPTIONS, analyticsEngineFor } from "./analytics-engine";
import { D1_DATABASE_OPTION, d1Databases, d1Store } from "./d1";
import { DURABLE_OBJECT_OPTIONS, durableObjectNamespaces, durableObjectStore } from "./durable-objects";
import { oidcAuthenticate } from "./oidc-auth";
import { Permissions, type Resource } from "./permissions";
import { type SqlStore, SqliteWorker, type StoreSource } from "./sqlite";
import { DurableSqlStore } from "./stores";
import { R2Uploads } from "./uploads";

export { ExampleRoom } from "./example-room";
export { GrainliftSqlObject } from "./grainlift-sql-object";

export interface Env {
  /** The example's D1 database. */
  DB?: D1Database;
  /**
   * Comma-separated D1 bindings the `d1` target may query, such as "DB,ANALYTICS".
   * Default: DB, when it is bound.
   */
  D1_DATABASES?: string;
  GATEWAY: DurableObjectNamespace<GrainliftGateway>;
  /**
   * Comma-separated Durable Object bindings the `durable_object` target may
   * query, such as "ROOMS". Their classes must extend GrainliftSqlObject.
   */
  DURABLE_OBJECT_NAMESPACES?: string;
  /**
   * Who may use which databases: JSON of principals to grants (see
   * src/permissions.ts). Required; a principal it does not name gets nothing.
   */
  PERMISSIONS?: string;
  /**
   * Static bearer tokens: JSON of token to principal, such as
   * {"<long random token>": "etl"} (`wrangler secret put GRAINLIFT_TOKENS`).
   */
  GRAINLIFT_TOKENS?: string;
  /** One static bearer token, for principal "token-user" (`wrangler secret put GRAINLIFT_TOKEN`). */
  GRAINLIFT_TOKEN?: string;
  /** Browser origin allowed to call the gateway (e.g. Cupola), or unset. */
  CORS_ORIGIN?: string;
  /** This gateway's public URL: the OAuth resource identifier. */
  PUBLIC_URL?: string;
  /** OpenID Connect issuer for sign-in, such as https://accounts.google.com; set to enable it. */
  OIDC_ISSUER?: string;
  /** The OAuth client ID registered with the provider. */
  OIDC_CLIENT_ID?: string;
  /** Its secret, when the provider requires one (`wrangler secret put OIDC_CLIENT_SECRET`). */
  OIDC_CLIENT_SECRET?: string;
  /** A second client for command-line (device flow) sign-in, when the provider needs one (Google). */
  OIDC_DEVICE_CLIENT_ID?: string;
  /** Its secret (`wrangler secret put OIDC_DEVICE_CLIENT_SECRET`). */
  OIDC_DEVICE_CLIENT_SECRET?: string;
  /** The ID-token claim naming the user, which PERMISSIONS keys match. Default `email`. */
  OIDC_PRINCIPAL_CLAIM?: string;
  /** "true": requests without credentials are allowed, as principal "anonymous". */
  ALLOW_ANONYMOUS?: string;
  /** "true": refuse every write, whatever PERMISSIONS grants. */
  READ_ONLY?: string;
  /**
   * The account whose Workers Analytics Engine datasets the `analytics_engine`
   * target queries, for clients that do not send `cloudflare.account_id`.
   */
  ANALYTICS_ENGINE_ACCOUNT_ID?: string;
  /**
   * An API token with Account Analytics Read, for clients that do not send
   * `cloudflare.api_token` (`wrangler secret put ANALYTICS_ENGINE_API_TOKEN`).
   */
  ANALYTICS_ENGINE_API_TOKEN?: string;
  /** D1's queries per request: 1000 on Workers Paid, 50 on Free. */
  D1_MAX_QUERIES?: string;
  /** Largest HTTP request the gateway accepts, in bytes (SDK default 8 MiB). */
  REQUEST_BYTES?: string;
  /** Largest bound Arrow batch the gateway decodes, in bytes (SDK default 16 MiB). */
  BATCH_BYTES?: string;
  /** R2 bucket for externalized requests and responses (see src/uploads.ts). */
  UPLOADS?: R2Bucket;
  /** HMAC key signing upload URLs (`wrangler secret put UPLOAD_SIGNING_KEY`). */
  UPLOAD_SIGNING_KEY?: string;
  /** Largest externalized request a client may upload, in bytes. */
  MAX_UPLOAD_BYTES?: string;
}

export class GrainliftGateway extends DurableObject<Env> {
  private readonly handler: (request: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The same SQLite backend over each target's store: `durable_object` (an
    // object of a listed namespace) and `d1` (a listed D1 database), each
    // chosen by the client's options, and `sqlite` (this Durable Object's own
    // storage, seeded with the sample tables on first start).
    // Every connection is checked against PERMISSIONS for the database it
    // chose, and opened read-only unless a grant allows writing.
    const permissions = Permissions.parse(env.PERMISSIONS);
    const permitted = (choose: (o: OpenOptions) => { store: SqlStore; resource: Resource }, keys: ReadonlySet<string>) =>
      gated(permissions, env.READ_ONLY === "true", keys, choose);
    const own = new DurableSqlStore(ctx.storage);
    const stores = new Map<string, StoreSource>([
      ["sqlite", permitted(() => ({ store: own, resource: { target: "sqlite" } }), new Set())],
    ]);
    const options = new Set<string>();
    const namespaces = durableObjectNamespaces(env, env.DURABLE_OBJECT_NAMESPACES);
    if (namespaces.size) {
      stores.set("durable_object", permitted((o) => durableObjectStore(namespaces, o), DURABLE_OBJECT_OPTIONS));
      for (const key of DURABLE_OBJECT_OPTIONS) options.add(key);
    }
    const databases = d1Databases(env, env.D1_DATABASES ?? (env.DB ? "DB" : ""));
    if (databases.size) {
      const maxQueries = Number(env.D1_MAX_QUERIES ?? 1000);
      stores.set("d1", permitted((o) => d1Store(databases, maxQueries, o), new Set([D1_DATABASE_OPTION])));
      options.add(D1_DATABASE_OPTION);
    }
    // `analytics_engine`: Workers Analytics Engine datasets, through the SQL
    // API, with the client's account and token or the gateway's.
    const engineDefaults = { accountId: env.ANALYTICS_ENGINE_ACCOUNT_ID, apiToken: env.ANALYTICS_ENGINE_API_TOKEN };
    for (const key of ANALYTICS_ENGINE_OPTIONS) options.add(key);
    void ctx.blockConcurrencyWhile(() => seed(ctx.storage));
    const sqlite = new SqliteWorker(stores);
    const worker: Worker = {
      open: async (options) => {
        if (options.target !== "analytics_engine") return sqlite.open(options);
        for (const key of options.databaseOptions.keys()) {
          if (!ANALYTICS_ENGINE_OPTIONS.has(key)) {
            throw new AdbcError(`Target analytics_engine does not take the database option ${key}`, "invalid_arguments");
          }
        }
        if (!permissions.access(options.principal, { target: "analytics_engine" })) {
          throw new AdbcError("You do not have access to Analytics Engine", "unauthorized");
        }
        return analyticsEngineFor(options, engineDefaults).connect();
      },
    };
    const targets = new Set([...stores.keys(), "analytics_engine"]);
    const service = new GrainliftService(worker, {
      authorize: (principal, target) => targets.has(target) && permissions.allowsTarget(principal, target),
      allowedDatabaseOptions: options,
      // Autocommit off opens a transaction that commits as one atomic write.
      allowedConnectionOptions: new Set(["adbc.connection.autocommit"]),
      // Clients that go away without closing (a reloaded browser tab, a killed
      // process) hold sessions until they idle out; keep that window short.
      limits: {
        sessions: 1024,
        // Every anonymous client shares the one "anonymous" principal, so a
        // per-principal cap would be a cap on the whole public gateway.
        sessionsPerPrincipal: env.ALLOW_ANONYMOUS === "true" ? 1024 : 64,
        idleMs: 120_000,
        ...(env.REQUEST_BYTES ? { requestBytes: Number(env.REQUEST_BYTES) } : {}),
        ...(env.BATCH_BYTES ? { batchBytes: Number(env.BATCH_BYTES) } : {}),
      },
    });
    this.handler = service.httpHandler(authenticator(env), httpOptions(env));
  }

  override async fetch(request: Request): Promise<Response> {
    return this.handler(request);
  }
}

/**
 * A target's store chooser, gated by permissions: it refuses database options
 * meant for another target, and opens the chosen database only if the
 * principal has a grant for it, read-only unless the grant allows writing.
 */
function gated(
  permissions: Permissions,
  readOnly: boolean,
  keys: ReadonlySet<string>,
  choose: (options: OpenOptions) => { store: SqlStore; resource: Resource },
): StoreSource {
  return (options) => {
    for (const key of options.databaseOptions.keys()) {
      if (!keys.has(key)) throw new AdbcError(`Target ${options.target} does not take the database option ${key}`, "invalid_arguments");
    }
    const { store, resource } = choose(options);
    const access = permissions.access(options.principal, resource);
    // The same refusal whether or not the database exists, so a client cannot probe.
    if (!access) throw new AdbcError(`You do not have access to ${store.name}`, "unauthorized");
    return { store, readOnly: readOnly || access === "read" };
  };
}

/** Load the sample tables into the Durable Object's SQLite, once. */
async function seed(storage: DurableObjectStorage): Promise<void> {
  if (await storage.get("seeded")) return;
  storage.transactionSync(() => storage.sql.exec(SAMPLE_DATA));
  await storage.put("seeded", true);
}

/** The static tokens (if set) and OpenID Connect sign-in (if configured). */
function authenticator(env: Env): AuthenticateFn {
  const tokens = staticTokens(env);
  const token = tokens.size ? bearerAuthenticateStatic(tokens) : null;
  const oidc = env.OIDC_ISSUER
    ? oidcAuthenticate({
        issuer: env.OIDC_ISSUER,
        clientIds: [env.OIDC_CLIENT_ID ?? "", env.OIDC_DEVICE_CLIENT_ID ?? ""],
        principalClaim: env.OIDC_PRINCIPAL_CLAIM,
      })
    : null;
  const identify: AuthenticateFn = async (request) => {
    const identity = token ? await token(request) : AuthContext.anonymous();
    return identity.authenticated || !oidc ? identity : oidc(request);
  };
  // Credentials are then optional; a presented token must still be valid.
  if (env.ALLOW_ANONYMOUS === "true") return authenticateAnonymous("anonymous", identify);
  if (!token && !oidc) throw new Error("Set GRAINLIFT_TOKENS (or GRAINLIFT_TOKEN), or configure OIDC sign-in");
  return identify;
}

/** GRAINLIFT_TOKENS (token to principal) and GRAINLIFT_TOKEN (principal "token-user"). */
function staticTokens(env: Env): Map<string, AuthContext> {
  const tokens = new Map<string, AuthContext>();
  if (env.GRAINLIFT_TOKENS?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.GRAINLIFT_TOKENS);
    } catch {
      // Never echo the value: it holds credentials.
      throw new Error("GRAINLIFT_TOKENS is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("GRAINLIFT_TOKENS must be a JSON object of token to principal");
    for (const [token, principal] of Object.entries(parsed)) {
      if (typeof principal !== "string" || !principal || principal === "anonymous")
        throw new Error("Each GRAINLIFT_TOKENS principal must be a non-empty string other than anonymous");
      if (token.length < 24) throw new Error(`The GRAINLIFT_TOKENS token for ${principal} is shorter than 24 characters`);
      tokens.set(token, new AuthContext("bearer", true, principal));
    }
  }
  if (env.GRAINLIFT_TOKEN) tokens.set(env.GRAINLIFT_TOKEN, new AuthContext("bearer", true, "token-user"));
  return tokens;
}

/**
 * CORS for the browser client, and with sign-in configured, the OAuth
 * metadata Cupola and the Grainlift driver discover: the provider as issuer
 * and ID tokens as bearers. With a client secret, token requests go through
 * this gateway's /_oauth/token proxy, which adds it. (VGI-RPC also lists the
 * secret in the metadata, so use a client whose secret is not confidential:
 * Google's are not, and many providers offer public clients with PKCE.)
 */
/** Externalization, when the bucket, signing key and public URL are configured. */
function uploads(env: Env): R2Uploads | null {
  if (!env.UPLOADS || !env.UPLOAD_SIGNING_KEY || !env.PUBLIC_URL) return null;
  return new R2Uploads(env.UPLOADS, env.UPLOAD_SIGNING_KEY, env.PUBLIC_URL, env.CORS_ORIGIN);
}

function httpOptions(env: Env): HttpOptions {
  const options: HttpOptions = {};
  const externalized = uploads(env);
  if (externalized && env.PUBLIC_URL) {
    const origin = new URL(env.PUBLIC_URL).origin;
    options.uploadUrlProvider = externalized.provider;
    if (env.MAX_UPLOAD_BYTES) options.maxUploadBytes = Number(env.MAX_UPLOAD_BYTES);
    options.externalLocation = {
      storage: externalized.storage,
      fetch: externalized.fetch,
      // Pointers may only name this gateway's own upload URLs.
      urlValidator: (url) => {
        if (new URL(url).origin !== origin) throw new Error("External location is not this gateway");
      },
    };
  }
  if (env.CORS_ORIGIN) {
    options.corsOrigins = env.CORS_ORIGIN;
    options.allowedReturnOrigins = new Set([env.CORS_ORIGIN]);
  }
  if (env.OIDC_ISSUER) {
    if (!env.PUBLIC_URL || !env.OIDC_CLIENT_ID) throw new Error("OIDC sign-in needs PUBLIC_URL and OIDC_CLIENT_ID");
    options.oauthResourceMetadata = {
      resource: env.PUBLIC_URL,
      resourceName: "Grainlift on Cloudflare",
      authorizationServers: [env.OIDC_ISSUER],
      clientId: env.OIDC_CLIENT_ID,
      ...(env.OIDC_CLIENT_SECRET ? { clientSecret: env.OIDC_CLIENT_SECRET } : {}),
      useIdTokenAsBearer: true,
      scopesSupported: ["openid", "email", "profile"],
      // Some providers (Google) need a separate client type for the device
      // flow, which the driver uses on headless machines.
      ...(env.OIDC_DEVICE_CLIENT_ID
        ? {
            deviceCodeClientId: env.OIDC_DEVICE_CLIENT_ID,
            ...(env.OIDC_DEVICE_CLIENT_SECRET ? { deviceCodeClientSecret: env.OIDC_DEVICE_CLIENT_SECRET } : {}),
          }
        : {}),
    };
  }
  return options;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return landingPage(url);
    // Upload URLs are served here, streaming to and from R2.
    const upload = await uploads(env)?.handle(request);
    if (upload) return upload;
    // One instance: every session must reach the same in-memory service.
    return env.GATEWAY.get(env.GATEWAY.idFromName("gateway")).fetch(request);
  },
} satisfies ExportedHandler<Env>;

function landingPage(url: URL): Response {
  const uri = `grainlift+https://${url.host}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grainlift on Cloudflare</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem}code,pre{background:#f4f4f4;border-radius:4px}pre{padding:1rem;overflow-x:auto}</style>
</head><body>
<h1>Grainlift on Cloudflare</h1>
<p>An ADBC gateway serving SQLite databases, written with the
<a href="https://github.com/Query-farm/grainlift-typescript">Grainlift TypeScript SDK</a>.
Targets: <code>durable_object</code> (an object of a listed Durable Object
namespace, chosen with the <code>cloudflare.durable_object.namespace</code> and
<code>cloudflare.durable_object.name</code> options), <code>d1</code> (a listed
D1 database, chosen with <code>cloudflare.d1.database</code>),
<code>sqlite</code> (this gateway's own Durable Object storage) and
<code>analytics_engine</code> (Workers Analytics Engine datasets, with
<code>cloudflare.account_id</code> and <code>cloudflare.api_token</code>). Attach one from DuckDB
with the grainlift extension:</p>
<pre>ATTACH '${uri}' AS d1 (TYPE grainlift, target 'd1');
ATTACH '${uri}' AS local (TYPE grainlift, target 'sqlite');
SELECT * FROM d1.countries;</pre>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
