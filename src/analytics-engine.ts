// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// The `analytics_engine` target: Workers Analytics Engine, the events and
// metrics Workers write with `writeDataPoint`, queried through its SQL API.
// Read-only: the API runs SELECT and SHOW statements, one dataset per query.
// It has no bound parameters, so bound values are inlined as literals
// (src/analytics-parameters.ts). Each dataset is a table with a fixed schema; a
// query on a name that is no dataset returns no rows rather than an error.
//
// A query runs twice: wrapped as `SELECT * FROM (query) LIMIT 0` to learn its
// column types, then as `query FORMAT JSONEachRow`, whose rows stream into
// Arrow batches as the client reads them, so a large result is never held
// whole.
import {
  AdbcError,
  batch,
  bool,
  Connection,
  type DataType,
  dateDay,
  field,
  float64,
  int64,
  type ObjectFilters,
  type OpenOptions,
  type OptionValue,
  type QueryResult,
  type RecordBatch,
  type Schema,
  schema,
  Statement,
  type TableIdentifier,
  timestampMicro,
  utf8,
} from "@query-farm/grainlift";
import { type ColumnRow, GET_OBJECTS_SCHEMA, GET_TABLE_TYPES_SCHEMA, ObjectDepth, type TableRow } from "./adbc-schemas";
import { inlineParameters } from "./analytics-parameters";
import { likeMatches } from "./sqlite";

const CATALOG = "main";
const DB_SCHEMA = "";
const ROWS_PER_BATCH = 4096;
/** Flush a batch at about this many bytes of JSON, below Grainlift's batch limit. */
const BYTES_PER_BATCH = 768 * 1024;
/** How long a describe or SHOW request may take. Streams have no deadline: clients read at their own pace. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Every dataset's columns, in the order the catalog lists them. */
const DATASET_COLUMNS: readonly [string, string][] = [
  ["timestamp", "DateTime"],
  ["dataset", "String"],
  ["index1", "String"],
  ["_sample_interval", "UInt32"],
  ...Array.from({ length: 20 }, (_, i): [string, string] => [`blob${i + 1}`, "String"]),
  ...Array.from({ length: 20 }, (_, i): [string, string] => [`double${i + 1}`, "Float64"]),
];

/** The account ID a client may send, instead of the gateway's ANALYTICS_ENGINE_ACCOUNT_ID. */
export const ACCOUNT_ID_OPTION = "cloudflare.account_id";
/** The API token a client may send, instead of the gateway's ANALYTICS_ENGINE_API_TOKEN. */
export const API_TOKEN_OPTION = "cloudflare.api_token";
export const ANALYTICS_ENGINE_OPTIONS: ReadonlySet<string> = new Set([ACCOUNT_ID_OPTION, API_TOKEN_OPTION]);

/**
 * The SQL API a client connects to: the account and token it sent as
 * database options, each falling back to the gateway's own. With a client's
 * own token, Cloudflare applies that token's permissions. The token is never
 * echoed: errors name the option, not its value.
 */
export function analyticsEngineFor(
  options: OpenOptions,
  defaults: { accountId?: string; apiToken?: string },
): AnalyticsEngine {
  const given = (key: string): string | undefined => {
    const value = options.databaseOptions.get(key);
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new AdbcError(`${key} must be a non-empty string`, "invalid_arguments");
    return value.trim();
  };
  const accountId = given(ACCOUNT_ID_OPTION) ?? defaults.accountId?.trim();
  const apiToken = given(API_TOKEN_OPTION) ?? defaults.apiToken?.trim();
  if (!accountId || !apiToken) {
    throw new AdbcError(
      `Send your Cloudflare account ID and an API token with Account Analytics Read as the ${ACCOUNT_ID_OPTION} ` +
        `and ${API_TOKEN_OPTION} database options`,
      "unauthenticated",
    );
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new AdbcError(`${ACCOUNT_ID_OPTION} must be a 32-digit hex account ID`, "invalid_arguments");
  return new AnalyticsEngine(accountId, apiToken);
}

/** The SQL API of one account, with an API token that can read its analytics. */
export class AnalyticsEngine {
  readonly name = "Analytics Engine";
  private readonly url: string;

  constructor(
    accountId: string,
    private readonly token: string,
  ) {
    // Fixed host and a validated account ID: a client cannot point the gateway elsewhere.
    if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new AdbcError("The account ID must be 32 hex digits", "invalid_arguments");
    this.url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  }

  connect(): Connection {
    return new AnalyticsConnection(this);
  }

  /** Send `sql`; the response, or an ADBC error saying what went wrong. */
  async send(sql: string, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "text/plain" },
        body: sql,
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        const timedOut = signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
        throw new AdbcError(timedOut ? "Analytics Engine did not answer in time" : "The query was cancelled", timedOut ? "timeout" : "cancelled");
      }
      throw new AdbcError(`Could not reach Analytics Engine: ${(error as Error).message}`, "io");
    }
    if (response.ok) return response;
    // The API's message is about the query (a syntax error, an unknown
    // function), never the token, which travels in a header.
    const text = (await response.text()).trim().slice(0, 500);
    // Errors from Cloudflare's API itself (rather than the SQL engine) come in
    // its JSON envelope; codes 9106, 9109 and 10000 are refused credentials.
    const envelope = cloudflareErrors(text);
    if (envelope) {
      if (envelope.codes.some((code) => code === 9106 || code === 9109 || code === 10000) || response.status === 401) {
        throw new AdbcError(
          `Cloudflare refused the API token for this account (${envelope.message}); it needs Account Analytics Read`,
          "unauthenticated",
        );
      }
      throw new AdbcError(`Cloudflare API: ${envelope.message} (HTTP ${response.status})`, response.status === 403 ? "unauthorized" : "io");
    }
    if (response.status === 400 || response.status === 422) {
      throw new AdbcError(`Analytics Engine: ${text.replace(/^Input was invalid: /, "")}`, "invalid_arguments");
    }
    if (response.status === 401 || response.status === 403) {
      throw new AdbcError(
        `Cloudflare refused the API token for this account (HTTP ${response.status}); it needs Account Analytics Read`,
        "unauthenticated",
      );
    }
    if (response.status === 429) throw new AdbcError("Analytics Engine is rate limiting the gateway; retry shortly", "io");
    throw new AdbcError(`Analytics Engine failed (HTTP ${response.status}): ${text}`, "io");
  }

  /** Run `sql` and read its whole JSON response (for small results: SHOW, describe). */
  async json(sql: string, signal: AbortSignal): Promise<{ meta: Meta[]; data: Record<string, unknown>[] }> {
    const response = await this.send(`${sql}\nFORMAT JSON`, signal);
    try {
      return (await response.json()) as { meta: Meta[]; data: Record<string, unknown>[] };
    } catch {
      throw new AdbcError("Analytics Engine returned a response that is not JSON", "io");
    }
  }
}

/** The codes and messages of a Cloudflare API error envelope, or null for any other body. */
function cloudflareErrors(text: string): { codes: number[]; message: string } | null {
  try {
    const body = JSON.parse(text) as { success?: boolean; errors?: { code?: number; message?: string }[] };
    if (body.success !== false || !Array.isArray(body.errors)) return null;
    return {
      codes: body.errors.map((e) => Number(e.code)),
      message: body.errors.map((e) => String(e.message ?? e.code)).join("; ") || "unknown error",
    };
  } catch {
    return null;
  }
}

interface Meta {
  name: string;
  type: string;
}

/** One column of a result: its Arrow type and how to convert a JSON value to it. */
interface Column {
  name: string;
  type: DataType;
  convert: (value: unknown) => unknown;
}

/**
 * The Arrow type for an Analytics Engine type, with its value conversion.
 * 64-bit integers arrive as strings (JSON numbers cannot hold them), and
 * DateTime values as UTC text such as `2026-10-07 01:36:46`. A DateTime in
 * another time zone (`DateTime('Asia/Tokyo')`) stays text: its text is in that
 * zone, and converting it would need the zone's rules.
 */
export function columnFor(meta: Meta): Column {
  let type = meta.type;
  for (const wrapper of ["Nullable", "LowCardinality"]) {
    if (type.startsWith(`${wrapper}(`) && type.endsWith(")")) type = type.slice(wrapper.length + 1, -1);
  }
  const name = meta.name;
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const utc = (v: unknown) => new Date(`${String(v).replace(" ", "T")}Z`);
  if (/^U?Int(8|16|32)$/.test(type)) return { name, type: int64(), convert: (v) => BigInt(v as number) };
  if (type === "Int64") return { name, type: int64(), convert: (v) => BigInt(v as string | number) };
  if (type === "UInt64") {
    return {
      name,
      type: int64(),
      convert: (v) => {
        const value = BigInt(v as string | number);
        if (value > 0x7fffffffffffffffn) {
          throw new AdbcError(`Column ${name} holds ${value}, beyond a 64-bit signed integer`, "invalid_data");
        }
        return value;
      },
    };
  }
  if (type === "Float32" || type === "Float64") return { name, type: float64(), convert: (v) => Number(v) };
  if (type === "Bool") return { name, type: bool(), convert: (v) => v === true || v === 1 || v === "true" };
  if (type === "Date" || type === "Date32") return { name, type: dateDay(), convert: (v) => new Date(`${v}T00:00:00Z`) };
  if (/^DateTime(64\(\d+)?(\)|, ?'(UTC|Etc\/UTC)'\)|\('(UTC|Etc\/UTC)'\))?$/.test(type)) {
    return { name, type: timestampMicro("UTC"), convert: utc };
  }
  return { name, type: utf8(), convert: text };
}

function resultSchema(meta: Meta[]): Column[] {
  const seen = new Set<string>();
  for (const { name } of meta) {
    if (seen.has(name)) {
      throw new AdbcError(`The query returns two columns named ${name}; give each a distinct name with AS`, "invalid_arguments");
    }
    seen.add(name);
  }
  return meta.map(columnFor);
}

function toBatch(arrowSchema: Schema, columns: Column[], rows: Record<string, unknown>[]): RecordBatch {
  const values: Record<string, unknown[]> = {};
  for (const column of columns) {
    values[column.name] = rows.map((row) => {
      const value = row[column.name];
      return value === null || value === undefined ? null : column.convert(value);
    });
  }
  return batch(arrowSchema, values);
}

/**
 * `sql` ready to send: trailing semicolons removed. The gateway chooses the
 * output format, so the query may not.
 */
function prepared(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "").trim();
  if (!trimmed) throw new AdbcError("The query is empty", "invalid_arguments");
  if (/\bFORMAT\s+[A-Za-z]+\s*$/i.test(trimmed)) {
    throw new AdbcError("Leave out the FORMAT clause; the gateway chooses the format", "invalid_arguments");
  }
  return trimmed;
}

class AnalyticsConnection extends Connection {
  constructor(private readonly engine: AnalyticsEngine) {
    super();
  }

  override async newStatement(): Promise<Statement> {
    return new AnalyticsStatement(this.engine);
  }

  /** Every query stands alone; autocommit can be turned off (and transactions are empty). */
  override async setOption(key: string, value: OptionValue): Promise<void> {
    if (key === "adbc.connection.autocommit" && (value === "true" || value === "false")) return;
    throw new AdbcError(`${key} is not supported by Analytics Engine`, "not_implemented");
  }

  override async commit(): Promise<void> {}

  override async rollback(): Promise<void> {}

  override async getTableTypes(): Promise<QueryResult> {
    return { schema: GET_TABLE_TYPES_SCHEMA, batches: [batch(GET_TABLE_TYPES_SCHEMA, { table_type: ["table"] })] };
  }

  /**
   * A dataset's columns, from the API. The API answers a query on any name,
   * returning no rows for a dataset that does not exist, so check the name
   * against `SHOW TABLES` first.
   */
  override async getTableSchema(table: TableIdentifier): Promise<Schema> {
    checkLocation(table.catalog, table.db_schema);
    if (!(await this.datasets()).includes(table.table_name)) {
      throw new AdbcError(`Dataset ${table.table_name} does not exist`, "not_found");
    }
    const { meta } = await this.engine.json(`SELECT * FROM ${quote(table.table_name)} LIMIT 0`, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    const order = new Map(DATASET_COLUMNS.map(([name], i) => [name, i]));
    const columns = resultSchema(meta).sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
    return schema(columns.map((c) => field(c.name, c.type, true)));
  }

  override async getObjects(filters: ObjectFilters): Promise<QueryResult> {
    const depth = Number(filters.depth) as ObjectDepth;
    if (!likeMatches(filters.catalog, CATALOG)) {
      return { schema: GET_OBJECTS_SCHEMA, batches: [batch(GET_OBJECTS_SCHEMA, { catalog_name: [], catalog_db_schemas: [] })] };
    }
    let dbSchemas: unknown[] | null = null;
    if (depth !== ObjectDepth.Catalogs) {
      dbSchemas = [];
      if (likeMatches(filters.db_schema, DB_SCHEMA)) {
        const tables = depth === ObjectDepth.DbSchemas ? null : await this.tables(filters, depth === ObjectDepth.All);
        dbSchemas.push({ db_schema_name: DB_SCHEMA, db_schema_tables: tables });
      }
    }
    return {
      schema: GET_OBJECTS_SCHEMA,
      batches: [batch(GET_OBJECTS_SCHEMA, { catalog_name: [CATALOG], catalog_db_schemas: [dbSchemas] })],
    };
  }

  /** The datasets (`SHOW TABLES`), each with the fixed dataset columns. */
  private async tables(filters: ObjectFilters, withColumns: boolean): Promise<TableRow[]> {
    if (filters.table_types && !filters.table_types.some((t) => t.toLowerCase() === "table")) return [];
    return (await this.datasets())
      .filter((name) => likeMatches(filters.table_name, name))
      .sort()
      .map((name) => ({
        table_name: name,
        table_type: "table",
        table_columns: withColumns ? datasetColumns(filters.column_name) : null,
        table_constraints: withColumns ? [] : null,
      }));
  }

  private async datasets(): Promise<string[]> {
    const { data } = await this.engine.json("SHOW TABLES", AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    return data.map((row) => String(Object.values(row)[0]));
  }
}

function datasetColumns(pattern: string | null): ColumnRow[] {
  return DATASET_COLUMNS.map(([name, type], i) => ({ name, type, position: i + 1 }))
    .filter((c) => likeMatches(pattern, c.name))
    .map((c) => ({
      column_name: c.name,
      ordinal_position: c.position,
      remarks: null,
      xdbc_data_type: null,
      xdbc_type_name: c.type,
      xdbc_column_size: null,
      xdbc_decimal_digits: null,
      xdbc_num_prec_radix: null,
      xdbc_nullable: 1,
      xdbc_column_def: null,
      xdbc_sql_data_type: null,
      xdbc_datetime_sub: null,
      xdbc_char_octet_length: null,
      xdbc_is_nullable: "YES",
      xdbc_scope_catalog: null,
      xdbc_scope_schema: null,
      xdbc_scope_table: null,
      xdbc_is_autoincrement: null,
      xdbc_is_generatedcolumn: null,
    }));
}

class AnalyticsStatement extends Statement {
  private sql: string | null = null;
  private bound: RecordBatch | null = null;
  /** Aborts the request or stream in progress. */
  private running: AbortController | null = null;

  constructor(private readonly engine: AnalyticsEngine) {
    super();
  }

  override async setSqlQuery(sql: string): Promise<void> {
    this.sql = sql;
    this.bound = null;
  }

  override async prepare(): Promise<void> {
    this.query();
  }

  /** One row of parameters, inlined as literals when the query runs. */
  override async bind(_schema: Schema, value: RecordBatch): Promise<void> {
    this.bound = value;
  }

  override async bindStream(_schema: Schema, batches: readonly RecordBatch[]): Promise<void> {
    const rows = batches.filter((b) => b.numRows > 0);
    if (rows.length !== 1) {
      throw new AdbcError("Analytics Engine runs a query with one row of parameters", "invalid_arguments");
    }
    this.bound = rows[0]!;
  }

  override async setOption(key: string): Promise<void> {
    throw new AdbcError(`${key} is not supported by Analytics Engine, which is read-only`, "not_implemented");
  }

  override async executeSchema(): Promise<Schema> {
    const sql = this.query();
    if (isShow(sql)) return (await this.execute()).schema;
    const columns = await this.describe(sql, this.start().signal);
    return schema(columns.map((c) => field(c.name, c.type, true)));
  }

  override async execute(): Promise<QueryResult> {
    const sql = this.query();
    const controller = this.start();
    if (isShow(sql)) {
      const { meta, data } = await this.engine.json(sql, AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
      const columns = resultSchema(meta);
      const arrowSchema = schema(columns.map((c) => field(c.name, c.type, true)));
      return { schema: arrowSchema, batches: data.length ? [toBatch(arrowSchema, columns, data)] : [] };
    }
    const columns = await this.describe(sql, controller.signal);
    const arrowSchema = schema(columns.map((c) => field(c.name, c.type, true)));
    const response = await this.engine.send(`${sql}\nFORMAT JSONEachRow`, controller.signal);
    return {
      schema: arrowSchema,
      batches: rowBatches(response, arrowSchema, columns),
      close: () => controller.abort(),
    };
  }

  override async executeUpdate(): Promise<bigint | null> {
    throw new AdbcError("Analytics Engine is read-only; Workers write to it with writeDataPoint", "unauthorized");
  }

  override async cancel(): Promise<void> {
    this.running?.abort();
  }

  /**
   * The query's columns, from `SELECT * FROM (query) LIMIT 0`. The query sits
   * on its own lines, so a trailing `--` comment cannot swallow the `)`. If
   * the wrapped query is refused, the query itself is described with
   * `LIMIT 0` instead (when it has no LIMIT), so a mistake is reported as the
   * API sees the client's own SQL rather than the wrapper.
   */
  private async describe(sql: string, cancelled: AbortSignal): Promise<Column[]> {
    const signal = AbortSignal.any([cancelled, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    try {
      return resultSchema((await this.engine.json(`SELECT * FROM (\n${sql}\n) LIMIT 0`, signal)).meta);
    } catch (error) {
      if (!(error instanceof AdbcError) || error.status !== "invalid_arguments" || /\bLIMIT\b/i.test(sql)) throw error;
      return resultSchema((await this.engine.json(`${sql}\nLIMIT 0`, signal)).meta);
    }
  }

  /** A controller for one execution, which `cancel` aborts; closing its result aborts only it. */
  private start(): AbortController {
    this.running = new AbortController();
    return this.running;
  }

  private query(): string {
    if (this.sql === null) throw new AdbcError("No SQL query was set", "invalid_state");
    const sql = prepared(this.sql);
    return this.bound ? inlineParameters(sql, this.bound) : sql;
  }
}

/** Rows from a JSONEachRow response, one JSON object per line, as Arrow batches. */
async function* rowBatches(response: Response, arrowSchema: Schema, columns: Column[]): AsyncGenerator<RecordBatch> {
  if (!response.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  let rows: Record<string, unknown>[] = [];
  let bytes = 0;
  const parse = (line: string) => {
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      throw new AdbcError(`Analytics Engine sent an unexpected line: ${line.slice(0, 200)}`, "io");
    }
    bytes += line.length;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) parse(line);
        if (rows.length >= ROWS_PER_BATCH || bytes >= BYTES_PER_BATCH) {
          yield toBatch(arrowSchema, columns, rows);
          rows = [];
          bytes = 0;
        }
      }
    }
    if (pending.trim()) parse(pending.trim());
    if (rows.length) yield toBatch(arrowSchema, columns, rows);
  } finally {
    // Stops the download when the client closes the result early.
    await reader.cancel().catch(() => {});
  }
}

function isShow(sql: string): boolean {
  return /^\s*SHOW\b/i.test(sql);
}

function checkLocation(catalog: string | null, dbSchema: string | null): void {
  if ((catalog && catalog !== CATALOG) || (dbSchema && dbSchema !== DB_SCHEMA && dbSchema !== "main")) {
    throw new AdbcError("Analytics Engine has one catalog (main) and no schemas", "not_found");
  }
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
