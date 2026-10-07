# Grainlift on Cloudflare Workers

An ADBC gateway for the SQLite databases inside your Cloudflare account: your
Workers' [Durable Objects](https://developers.cloudflare.com/durable-objects/)
and your [D1](https://developers.cloudflare.com/d1/) databases. It is written
with the [Grainlift TypeScript SDK](https://github.com/Query-farm/grainlift-typescript)
and runs as a Worker. Any ADBC client with the
[Grainlift driver](https://github.com/Query-farm/grainlift) can query and
write them: Python, DuckDB (through `adbc_scanner`, or the grainlift
extension), and the browser through [Cupola](https://cupola.query-farm.services).

```sql
ATTACH 'grainlift+https://grainlift-cloudflare.rusty-bb6.workers.dev' AS d1
  (TYPE grainlift, target 'd1', bearer_token '…');
SELECT k.continent, count(*) AS cities
FROM d1.cities c JOIN d1.countries k ON c.country_code = k.code
GROUP BY ALL;
```

## Targets

A client chooses a target, and within it a database, with ADBC options:

| Target | Database | Chosen with |
|---|---|---|
| `durable_object` | One object of a Durable Object namespace bound to the gateway | `cloudflare.durable_object.namespace` and `.name` or `.id` (see [Query your own Durable Objects](#query-your-own-durable-objects)) |
| `d1` | One D1 database bound to the gateway | `cloudflare.d1.database` (see [D1 databases](#d1-databases)) |
| `sqlite` | The gateway's own Durable Object storage, seeded with sample tables | |

All three run the same SQLite backend: SQL passes straight through, DuckDB
can browse, query, `CREATE TABLE … AS` and `INSERT`, and writes are atomic,
including [transactions](#transactions).

## How it works

- `src/index.ts`: the Worker forwards every request to a single Durable
  Object, which hosts the `GrainliftService`. Grainlift sessions (connections,
  statements, open result streams) live in memory between requests, and a
  Durable Object is the one place on Workers where they reliably do. When the
  object is evicted after idling, its sessions end; the driver opens a new one
  for the next query (in autocommit mode).
- `src/sqlite.ts`: the backend, for any SQLite store. Tables, columns, primary
  keys and foreign keys come from `sqlite_master` and the table pragmas, laid
  out like the ADBC SQLite driver's (catalog `main`, one unnamed schema). ADBC
  bulk ingestion creates and appends to tables.
- `src/stores.ts`: the stores: D1, the gateway's own storage, and other
  Durable Objects over RPC. `src/durable-objects.ts` and `src/d1.ts` choose
  one from the client's options.
- `src/grainlift-sql-object.ts`: the base class that makes your Durable
  Object class queryable; `src/example-room.ts` is an example.
- `src/permissions.ts`: who may use which database (`PERMISSIONS`).
- `src/oidc-auth.ts`: optional sign-in with any OpenID Connect provider.
- `migrations/`: sample `countries` and `cities` tables (rounded figures).

The SDK runs on Workers with [flechette](https://github.com/uwdata/flechette)
as its Arrow implementation and needs the `nodejs_compat` flag.

## Deploy it for your own Workers

The gateway runs in your Cloudflare account, next to the Workers whose data it
serves. Bindings are fixed when a Worker deploys, so you choose the namespaces
and databases it reaches in `wrangler.jsonc`, then say who may use them.

1. **Get the code.**

   ```sh
   git clone https://github.com/Query-farm/grainlift-cloudflare && cd grainlift-cloudflare
   npm install
   ```

2. **Make your Durable Object classes queryable.** In your application's
   Worker, copy `src/grainlift-sql-object.ts` and `src/durable-sql.ts`, and
   extend `GrainliftSqlObject` instead of `DurableObject`
   (see [Query your own Durable Objects](#query-your-own-durable-objects)).
   Deploy your application. D1 databases need nothing.

3. **Bind them to the gateway.** In `wrangler.jsonc`, set `name` and
   `PUBLIC_URL` (`https://<name>.<your-subdomain>.workers.dev`), and replace the
   example bindings with yours:

   ```jsonc
   "durable_objects": { "bindings": [
     { "name": "GATEWAY", "class_name": "GrainliftGateway" },           // keep: the gateway itself
     { "name": "CHATS", "class_name": "ChatRoom", "script_name": "chat-app" }
   ] },
   "d1_databases": [{ "binding": "ANALYTICS", "database_name": "analytics", "database_id": "…" }],
   "vars": {
     "DURABLE_OBJECT_NAMESPACES": "CHATS",
     "D1_DATABASES": "ANALYTICS",
     …
   }
   ```

   The R2 bucket for large requests is optional: without `UPLOADS` and the
   `UPLOAD_SIGNING_KEY` secret, requests are limited to `REQUEST_BYTES`.

4. **Issue tokens**, one per person or program, as a secret mapping each
   token to a principal name:

   ```sh
   echo "{\"$(openssl rand -hex 24)\": \"etl\", \"$(openssl rand -hex 24)\": \"analyst\"}" \
     | tee .grainlift-tokens | npx wrangler secret put GRAINLIFT_TOKENS
   ```

   Or let people [sign in](#sign-in-with-openid-connect) with your identity
   provider instead, or as well.

5. **Say who may use what**, as the `PERMISSIONS` secret
   (see [Permissions](#permissions)). The gateway refuses to start without it.

   ```sh
   echo '{"etl": [{"target": "*", "access": "read_write"}],
          "analyst": [{"target": "d1", "database": "ANALYTICS"}]}' \
     | npx wrangler secret put PERMISSIONS
   ```

6. **Deploy** with `npm run deploy`, and connect:

   ```python
   from adbc_driver_grainlift import dbapi
   with dbapi.connect(db_kwargs={
       "grainlift.uri": "https://<name>.<your-subdomain>.workers.dev",
       "grainlift.target": "durable_object",
       "grainlift.auth.bearer_token": "<the etl token>",
       "cloudflare.durable_object.name": "general",
   }) as conn:
       ...
   ```

For local development, put `GRAINLIFT_TOKENS=…` (or `GRAINLIFT_TOKEN=…`) and
`PERMISSIONS=…` in `.dev.vars` and run `npm run db:migrate:local && npm run
dev`. The local URI is `grainlift+http://127.0.0.1:8787`. If every request
fails with HTTP 500, the gateway could not start: `npx wrangler tail` (or the
`npm run dev` output) says which setting is missing or invalid.

## Authentication

A client proves who it is with a bearer token (`grainlift.auth.bearer_token`,
or `bearer_token` in DuckDB's `ATTACH`). Who it is decides nothing by itself:
[Permissions](#permissions) do.

- **Static tokens.** `GRAINLIFT_TOKENS` maps tokens (at least 24 characters)
  to principals: `{"<token>": "etl"}`. Give each person or program its own,
  so one can be revoked without the others. `GRAINLIFT_TOKEN` is a single
  token for principal `token-user`, convenient for local development.
- **[Sign-in with OpenID Connect](#sign-in-with-openid-connect)**: people use
  their own accounts with Google, Okta, Auth0, Microsoft Entra ID or any
  other OIDC provider. Their principal is their verified email.
- **Anonymous.** With `ALLOW_ANONYMOUS = "true"`, requests without credentials
  get principal `anonymous` (see [A public gateway](#a-public-gateway)).

## Permissions

`PERMISSIONS` is JSON mapping principals to the grants they hold. It is
required, and a principal it does not name can use nothing.

```json
{
  "etl":               [{ "target": "*", "access": "read_write" }],
  "alice@example.com": [{ "target": "durable_object", "namespace": "CHATS", "object": "team-a-*", "access": "read_write" }],
  "@example.com":      [{ "target": "d1", "database": "ANALYTICS" }],
  "*":                 [{ "target": "sqlite" }]
}
```

| Key | Matches |
|---|---|
| `etl`, `alice@example.com` | That principal (emails ignore case) |
| `@example.com` | Every signed-in user with an email at that domain |
| `*` | Every authenticated principal (not `anonymous`) |
| `anonymous` | Clients without credentials, with `ALLOW_ANONYMOUS` |

| Grant field | |
|---|---|
| `target` | `durable_object`, `d1`, `sqlite`, or `*` for all of them |
| `namespace` | `durable_object` only: the binding name, or a prefix such as `TEAM_*`. Default: every listed namespace |
| `object` | `durable_object` only: the object's name, or a prefix such as `team-a-*`. Objects chosen by id have no name, so only a grant without `object` (or `"*"`) covers them |
| `database` | `d1` only: the binding name, or a prefix. Default: every listed database |
| `access` | `read` (the default) or `read_write` |

A principal holds the strongest access any of its grants gives. Read access
runs only statements that read (`SELECT`, `WITH`, `VALUES`, `EXPLAIN` with no
write keyword) and refuses ingestion, updates and writes in transactions.
`READ_ONLY = "true"` makes every grant read-only. A connection to a database
the principal has no grant for is refused, as is a target it has no grant on.

Keep `PERMISSIONS` a secret (`wrangler secret put`) when it names people.

## Sign-in with OpenID Connect

People can sign in with your identity provider: Cupola in the browser, and
the Grainlift driver on the command line (through a browser, or the device
flow on headless machines). The gateway publishes OAuth discovery (RFC 9728),
so clients find the provider themselves. Clients send the provider's ID token,
which the gateway verifies against the provider's published keys.

1. Register an OAuth client with your provider, with redirect URIs
   `https://<your-worker>/_oauth/callback` and, for Cupola,
   `https://cupola.query-farm.services/oauth-callback.html` (and origin
   `https://cupola.query-farm.services`).
2. Set the vars `OIDC_ISSUER` and `OIDC_CLIENT_ID`, and if the provider
   requires one, `npx wrangler secret put OIDC_CLIENT_SECRET`.
3. Grant the users access in `PERMISSIONS`, by email or by domain, and deploy.

| Provider | `OIDC_ISSUER` | Notes |
|---|---|---|
| Google | `https://accounts.google.com` | A **Web application** client; Google requires its secret. For the device flow, add a **TVs and Limited Input devices** client as `OIDC_DEVICE_CLIENT_ID` (secret: `OIDC_DEVICE_CLIENT_SECRET`). |
| Okta | `https://<org>.okta.com` (or a custom authorization server's issuer) | A native or SPA app with PKCE needs no secret. |
| Auth0 | `https://<tenant>.auth0.com/` | |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Entra's ID tokens carry no `email_verified`; set `OIDC_PRINCIPAL_CLAIM` to `preferred_username` (or `oid`) and key `PERMISSIONS` by it. |

The principal is the token's `email` claim, which must be verified
(`email_verified`); `OIDC_PRINCIPAL_CLAIM` names another claim. For Google,
an address at a domain other than `gmail.com` is accepted only from a
Workspace account of that domain, so an `@example.com` key cannot be matched
by a personal Google account that registered an `example.com` address.

The client secret travels through the gateway's `/_oauth/token` proxy, and
VGI-RPC also lists it in the OAuth metadata, so use a client whose secret is
not confidential: Google's are not, and most other providers offer public
clients with PKCE, which need none.

## A public gateway

`wrangler.jsonc` also defines a `public` environment: the same gateway on its
own copy of the data (a second D1 database), open to anyone without sign-in.
`ALLOW_ANONYMOUS` admits requests without credentials, and its `PERMISSIONS`
var grants `anonymous` read and write on every target. It is deployed at
`https://grainlift-cloudflare-public.rusty-bb6.workers.dev`:

```sql
ATTACH 'grainlift+https://grainlift-cloudflare-public.rusty-bb6.workers.dev' AS d1 (TYPE grainlift, target 'd1');
```

or in Cupola:
<https://cupola.query-farm.services/?service=grainlift%2Bhttps://grainlift-cloudflare-public.rusty-bb6.workers.dev&target=d1>

```sh
npx wrangler d1 create grainlift-example-public   # its database_id goes in env.public
npx wrangler d1 migrations apply grainlift-example-public --remote --env public
npx wrangler deploy --env public
```

Set `READ_ONLY` to `"true"`, or grant `"access": "read"`, to refuse writes.

## Query your own Durable Objects

The `durable_object` target queries the SQLite storage of an application's
Durable Objects: one object per connection, chosen by the client with ADBC
database options.

| Option | |
|---|---|
| `cloudflare.durable_object.namespace` | The namespace's binding name, such as `ROOMS`. Optional when the gateway lists only one. |
| `cloudflare.durable_object.name` | The object's name, as `idFromName` takes it. |
| `cloudflare.durable_object.id` | Or its id (64 hex digits), for objects made with `newUniqueId`. |

```python
from adbc_driver_grainlift import dbapi

with dbapi.connect(db_kwargs={
    "grainlift.uri": "https://grainlift-cloudflare.rusty-bb6.workers.dev",
    "grainlift.target": "durable_object",
    "grainlift.auth.bearer_token": "…",
    "cloudflare.durable_object.namespace": "ROOMS",
    "cloudflare.durable_object.name": "lobby",
}) as conn, conn.cursor() as cur:
    cur.execute("SELECT author, body FROM messages")
```

From DuckDB, pass them as `EXTRA_OPTIONS` of an `adbc_scanner` secret:

```sql
CREATE SECRET lobby (TYPE adbc, DRIVER '/path/to/libadbc_driver_grainlift.dylib',
  URI 'https://grainlift-cloudflare.rusty-bb6.workers.dev',
  SCOPE 'https://grainlift-cloudflare.rusty-bb6.workers.dev',
  EXTRA_OPTIONS MAP {'grainlift.target': 'durable_object', 'grainlift.auth.bearer_token': '…',
    'cloudflare.durable_object.namespace': 'ROOMS', 'cloudflare.durable_object.name': 'lobby'});
ATTACH 'https://grainlift-cloudflare.rusty-bb6.workers.dev' AS lobby (TYPE adbc, SECRET 'lobby', READ_WRITE);
SELECT * FROM lobby.messages;
CREATE TABLE lobby.cities AS SELECT * FROM 'cities.parquet';   -- writes work too (see Transactions)
```

A Durable Object's storage is private to the object, so the object runs the
gateway's SQL itself, over Durable Object RPC. To make a class queryable:

1. Extend `GrainliftSqlObject` (`src/grainlift-sql-object.ts`) instead of
   `DurableObject`. It adds three RPC methods, `grainliftRows`,
   `grainliftObjects` and `grainliftWrite`, and needs nothing from Grainlift.
   A class with another base can add the three methods itself and delegate to
   `src/durable-sql.ts`.
2. Bind the namespace to the gateway in `wrangler.jsonc`. For a class in
   another Worker of the same account, add its `script_name`:
   `{ "name": "ROOMS", "class_name": "ChatRoom", "script_name": "chat-app" }`.
3. List the binding in `DURABLE_OBJECT_NAMESPACES` (comma-separated). The
   gateway refuses any namespace not listed there.

`src/example-room.ts` is an example: a chat room keeping its messages in its
own storage, bound as `ROOMS`. Every room is a separate object with a separate
database, created on first use.

Writes go through the object too, each one a single `transactionSync`, so
they are atomic. Workers RPC limits one call to 32 MiB, so a write is refused
above about 30 MiB, and a query's whole result must fit as well (results are
read in one call).

A principal with access to an object can run any SQL in it, bypassing the
application's own logic. Grant access by namespace and object-name prefix
(see [Permissions](#permissions)), and list in `DURABLE_OBJECT_NAMESPACES`
only namespaces whose data someone should reach this way.

## D1 databases

The `d1` target serves the D1 databases bound to the gateway that
`D1_DATABASES` lists (comma-separated binding names; by default `DB`, the
example's database). A client chooses one with `cloudflare.d1.database`, which
may be left out when only one is listed:

```python
dbapi.connect(db_kwargs={
    "grainlift.uri": "https://grainlift-cloudflare.rusty-bb6.workers.dev",
    "grainlift.target": "d1",
    "grainlift.auth.bearer_token": "…",
    "cloudflare.d1.database": "ANALYTICS",
})
```

To add a database, bind it in `wrangler.jsonc` (`d1_databases`) and add its
binding name to `D1_DATABASES`. A Worker reaches only the D1 databases bound
to it, so each one needs a binding and a deploy.

## Writes are atomic per statement

Each DuckDB `INSERT` or `CREATE TABLE … AS` lands whole or not at all. The
backend sends its `CREATE`/`DROP` and every row in one transaction (multi-row
`INSERT`s, up to the 100 bound parameters per statement both stores allow).

- **`sqlite`:** one `transactionSync`, with no per-request query limit. The
  gateway holds the whole upload in memory first (64 MB / 1,024 Arrow batches
  by default); 60 MB inserts are tested.
- **`d1`:** one `db.batch()`, which D1 runs as a transaction. Every statement
  counts toward D1's limit of 1,000 queries per request (50 on the Free plan;
  set `D1_MAX_QUERIES`). That is about 1,000 × (100 ÷ columns) rows: 50,000
  for a 2-column table, 14,000 for `cities`. D1 also caps one batch at 32 MiB
  of data. A larger insert is refused before anything is written.

Both stores reject a row larger than about 8 MiB (SQLite's `SQLITE_TOOBIG`;
measured, while Cloudflare documents 2 MB), whether in one value or spread
across several. The backend refuses such a row before writing, naming it.
The gateway accepts requests up to 16 MiB (`REQUEST_BYTES`) so such a row fits.

## Large requests and results go through R2

A request bigger than `REQUEST_BYTES` is not split or refused: the client asks
the gateway for an upload URL, PUTs the request there, and sends only a
pointer (up to `MAX_UPLOAD_BYTES`, 64 MiB by default). Results over 1 MB come
back the same way, as a URL the client fetches. The URLs point at the Worker
itself (`/_uploads/<key>`), signed with HMAC-SHA256 and valid for 15 minutes;
the Worker streams bodies to and from an R2 bucket through its binding, so no
R2 credentials are involved ([`src/uploads.ts`](src/uploads.ts)).

```sh
npx wrangler r2 bucket create grainlift-example-uploads
openssl rand -hex 32 | npx wrangler secret put UPLOAD_SIGNING_KEY
```

Add a lifecycle rule to the bucket to delete objects after a day; nothing else
removes them. `CORS_ORIGIN` also applies to `/_uploads/`, so a browser client
can PUT and GET there.

## Transactions

With autocommit off, the default in Python's DB-API and what DuckDB's
`adbc_scanner` uses around every write (`CREATE TABLE … AS`, `INSERT`, and
`BEGIN … COMMIT`), a connection holds a transaction. No store can keep one
open across requests: Durable Object SQLite only has `transactionSync`, which
finishes within one call, and D1 only has `batch()`. So the gateway collects
the transaction's writes and `commit` sends them as one atomic write;
`rollback` discards them. All of it lands, or none of it.

Two differences from a database transaction:

- **Errors arrive at `commit`.** A constraint violation, a SQL mistake in a
  write, or a store limit (D1's queries per request) is reported by `commit`,
  and nothing in the transaction is written.
- **Reads see only committed data,** not the transaction's pending writes.
  A write with `RETURNING` is refused in a transaction, since it has no result
  until commit; turn autocommit on to use it.

A transaction holds at most 64 MiB of pending writes. They live in the
gateway Durable Object's memory with the rest of the session, and every
request reaches that one object, so a connection's writes are never split
across instances. If the session ends first (idle for `idleMs`, two minutes
here, or the object restarted by eviction or a deploy), its pending writes are
gone, as in a rollback, and `commit` fails with "Session is unavailable": the
Grainlift driver replaces a lost session only in autocommit mode, so a
transaction is never silently reported as committed.

## Limitations

- Neither store reports result column types. A query's column types are
  inferred from its values (integers, floats, text, blobs). Table scans through `ATTACH` use the
  declared column types; the grainlift extension casts the results to them.
- `GetInfo` is not implemented. The extension then uses standard SQL for filter
  pushdown.
