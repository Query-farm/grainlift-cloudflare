# Grainlift on Cloudflare Workers (D1)

An ADBC gateway that serves a [Cloudflare D1](https://developers.cloudflare.com/d1/)
database, written with the [Grainlift TypeScript SDK](https://github.com/Query-farm/grainlift-typescript)
and running on Cloudflare Workers. Any ADBC client with the
[Grainlift driver](https://github.com/Query-farm/grainlift) can query it. That
includes DuckDB with the grainlift extension, in the browser through
[Cupola](https://cupola.query-farm.services) too.

```sql
ATTACH 'grainlift+https://grainlift-d1-example.rusty-bb6.workers.dev' AS d1
  (TYPE grainlift, target 'd1', bearer_token '…');
SELECT k.continent, count(*) AS cities
FROM d1.cities c JOIN d1.countries k ON c.country_code = k.code
GROUP BY ALL;
```

## How it works

- `src/index.ts`: the Worker forwards every request to a single Durable
  Object, which hosts the `GrainliftService`. Grainlift sessions (connections,
  statements, open result streams) live in memory between requests, and a
  Durable Object is the one place on Workers where they reliably do. When the
  object is evicted after idling, its sessions end; the driver opens a new one
  for the next query.
- `src/d1.ts`: the backend. SQL passes straight through to D1. Tables,
  columns, primary keys and foreign keys come from `sqlite_master` and the
  table pragmas, laid out like the ADBC SQLite driver's (catalog `main`, one
  unnamed schema). ADBC bulk ingestion creates and appends to tables, so DuckDB
  can `CREATE TABLE … AS` and `INSERT` through `ATTACH`.
- `src/google-auth.ts`: optional Google sign-in (see below).
- `migrations/`: sample `countries` and `cities` tables (rounded figures).

The SDK runs on Workers with [flechette](https://github.com/uwdata/flechette)
as its Arrow implementation and needs the `nodejs_compat` flag.

## Deploy your own

```sh
npm install
npx wrangler d1 create grainlift-example     # put the database_id in wrangler.jsonc
npm run db:migrate                           # sample tables
openssl rand -hex 24 | tee .grainlift-token | npx wrangler secret put GRAINLIFT_TOKEN
npm run deploy
```

Set `PUBLIC_URL` (and `CORS_ORIGIN`, for a browser client) in
`wrangler.jsonc`. For local development, put `GRAINLIFT_TOKEN=…` in `.dev.vars`
and run `npm run db:migrate:local && npm run dev`. The local URI is then
`grainlift+http://127.0.0.1:8787`.

## A public gateway

`wrangler.jsonc` also defines a `public` environment: the same gateway on its
own copy of the data (a second D1 database), open to anyone without sign-in
(`ALLOW_ANONYMOUS`), reads and writes alike. It is deployed at
`https://grainlift-d1-public.rusty-bb6.workers.dev`:

```sql
ATTACH 'grainlift+https://grainlift-d1-public.rusty-bb6.workers.dev' AS d1 (TYPE grainlift, target 'd1');
```

or in Cupola:
<https://cupola.query-farm.services/?service=grainlift%2Bhttps://grainlift-d1-public.rusty-bb6.workers.dev&target=d1>

```sh
npx wrangler d1 create grainlift-example-public   # its database_id goes in env.public
npx wrangler d1 migrations apply grainlift-example-public --remote --env public
npx wrangler deploy --env public
```

Set `READ_ONLY` to `"true"` to refuse writes. D1 has no read-only
connections, so that mode only runs statements that begin as reads (`SELECT`,
`WITH`, `VALUES`, `EXPLAIN`) and contain no write keyword. It refuses
ingestion and `execute_update` outright.

## Google sign-in

With Google configured, the gateway accepts Google ID tokens from allowed
accounts. It publishes OAuth discovery (RFC 9728) so Cupola can sign users in,
and the Grainlift driver can refresh their tokens. The static token keeps
working alongside it.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an OAuth client ID of type **Web application** with:
   - Authorized JavaScript origins: `https://cupola.query-farm.services`
   - Authorized redirect URIs: `https://cupola.query-farm.services/oauth-callback.html`
     and `https://<your-worker>/_oauth/callback`
2. In `wrangler.jsonc` `vars`, set `GOOGLE_CLIENT_ID`. Set `ALLOWED_EMAILS`
   and/or `ALLOWED_DOMAINS` (comma-separated) as vars, or as secrets to keep the
   list out of the repository (`npx wrangler secret put ALLOWED_EMAILS`).
   Nobody else gets in.
3. `npx wrangler secret put GOOGLE_CLIENT_SECRET`, then `npm run deploy`.
4. For command-line sign-in (the Grainlift driver's device flow), create a
   second client of type **TVs and Limited Input devices** in the same
   project. Set `GOOGLE_DEVICE_CLIENT_ID` and
   `npx wrangler secret put GOOGLE_DEVICE_CLIENT_SECRET`. The gateway accepts
   ID tokens issued to either client.

Google's access tokens are opaque, so clients send the ID token
(`use_id_token_as_bearer`). Google requires the client secret even for PKCE.
Token requests therefore go through the gateway's `/_oauth/token` proxy,
which adds it. As with VGI services, VGI-RPC also lists the secret in the
OAuth metadata.

## Limitations

- D1 results are untyped JSON. A query's column types are inferred from its
  values (integers, floats, text, blobs). Table scans through `ATTACH` use the
  declared column types; the grainlift extension casts the results to them.
- D1 has no interactive transactions. Each statement commits on its own, and
  `BEGIN … COMMIT` around writes through `ATTACH` fails.
- `GetInfo` is not implemented. The extension then uses standard SQL for filter
  pushdown.
