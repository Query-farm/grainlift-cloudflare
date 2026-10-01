// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// A Grainlift backend over Cloudflare D1 (SQLite). SQL passes straight through
// to D1; metadata comes from sqlite_master and the table_info/foreign_key_list
// pragmas, laid out like the ADBC SQLite driver's (catalog "main", one unnamed
// schema), so DuckDB's ATTACH browses and writes it the same way.
import {
  AdbcError,
  batch,
  binary,
  bool,
  Connection,
  type DataType,
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
  utf8,
  type Worker,
} from "@query-farm/grainlift";
import {
  type ColumnRow,
  type ConstraintRow,
  GET_OBJECTS_SCHEMA,
  GET_TABLE_TYPES_SCHEMA,
  ObjectDepth,
  type TableRow,
} from "./adbc-schemas";

const CATALOG = "main";
/** SQLite has no schemas; ADBC's SQLite driver reports one unnamed schema. */
const DB_SCHEMA = "";
const ROWS_PER_BATCH = 4096;
/** Rows per D1 batch() call when binding parameters or ingesting. */
const ROWS_PER_WRITE = 500;

type SqlValue = string | number | null | ArrayBuffer;

// Arrow type ids (Arrow FlatBuffer `Type`), shared by both Arrow backends.
const TypeId = { Int: 2, Float: 3, Binary: 4, Utf8: 5, Bool: 6, Decimal: 7, Date: 8, Timestamp: 10 } as const;

export interface D1Options {
  /** Refuse writes: for a gateway anyone may query. */
  readOnly?: boolean;
}

export class D1Worker implements Worker {
  constructor(
    private readonly db: D1Database,
    private readonly options: D1Options = {},
  ) {}
  async open(_options: OpenOptions): Promise<Connection> {
    return new D1Connection(this.db, this.options);
  }
}

class D1Connection extends Connection {
  constructor(
    private readonly db: D1Database,
    private readonly options: D1Options,
  ) {
    super();
  }

  override async newStatement(): Promise<Statement> {
    return new D1Statement(this.db, this.options);
  }

  // D1 has no interactive transactions: every statement autocommits.
  override async setOption(key: string, value: OptionValue): Promise<void> {
    if (key === "adbc.connection.autocommit" && value === "true") return;
    throw new AdbcError(`${key} is not supported by D1`, "not_implemented");
  }

  override async getTableTypes(): Promise<QueryResult> {
    return result(GET_TABLE_TYPES_SCHEMA, [batch(GET_TABLE_TYPES_SCHEMA, { table_type: ["table", "view"] })]);
  }

  override async getTableSchema(table: TableIdentifier): Promise<Schema> {
    checkLocation(table.catalog, table.db_schema);
    const columns = await tableInfo(this.db, table.table_name);
    if (!columns.length) throw new AdbcError(`Table ${table.table_name} does not exist`, "not_found");
    return schema(columns.map((c) => field(c.name, declaredType(c.type), c.notnull === 0)));
  }

  override async getObjects(filters: ObjectFilters): Promise<QueryResult> {
    const depth = Number(filters.depth) as ObjectDepth;
    const empty = { catalog_name: [] as string[], catalog_db_schemas: [] as unknown[] };
    if (!likeMatches(filters.catalog, CATALOG)) return result(GET_OBJECTS_SCHEMA, [batch(GET_OBJECTS_SCHEMA, empty)]);
    let dbSchemas: unknown[] | null = null;
    if (depth !== ObjectDepth.Catalogs) {
      dbSchemas = [];
      if (likeMatches(filters.db_schema, DB_SCHEMA)) {
        const tables = depth === ObjectDepth.DbSchemas ? null : await this.tables(filters, depth === ObjectDepth.All);
        dbSchemas.push({ db_schema_name: DB_SCHEMA, db_schema_tables: tables });
      }
    }
    return result(GET_OBJECTS_SCHEMA, [
      batch(GET_OBJECTS_SCHEMA, { catalog_name: [CATALOG], catalog_db_schemas: [dbSchemas] }),
    ]);
  }

  private async tables(filters: ObjectFilters, withColumns: boolean): Promise<TableRow[]> {
    const types = filters.table_types?.map((t) => t.toLowerCase());
    const { results } = await this.db
      .prepare(
        `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view')
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
           AND name NOT LIKE 'd1\\_%' ESCAPE '\\' ORDER BY name`,
      )
      .all<{ name: string; type: string }>();
    const rows: TableRow[] = [];
    for (const { name, type } of results) {
      if (!likeMatches(filters.table_name, name) || (types && !types.includes(type))) continue;
      rows.push({
        table_name: name,
        table_type: type,
        table_columns: withColumns ? await this.columns(name, filters.column_name) : null,
        table_constraints: withColumns && type === "table" ? await this.constraints(name) : null,
      });
    }
    return rows;
  }

  private async columns(table: string, pattern: string | null): Promise<ColumnRow[]> {
    return (await tableInfo(this.db, table))
      .filter((c) => likeMatches(pattern, c.name))
      .map((c) => ({
        column_name: c.name,
        ordinal_position: c.cid + 1,
        remarks: null,
        xdbc_data_type: null,
        xdbc_type_name: c.type || null,
        xdbc_column_size: null,
        xdbc_decimal_digits: null,
        xdbc_num_prec_radix: null,
        xdbc_nullable: c.notnull ? 0 : 1,
        xdbc_column_def: c.dflt_value,
        xdbc_sql_data_type: null,
        xdbc_datetime_sub: null,
        xdbc_char_octet_length: null,
        xdbc_is_nullable: c.notnull ? "NO" : "YES",
        xdbc_scope_catalog: null,
        xdbc_scope_schema: null,
        xdbc_scope_table: null,
        xdbc_is_autoincrement: null,
        xdbc_is_generatedcolumn: null,
      }));
  }

  private async constraints(table: string): Promise<ConstraintRow[]> {
    const constraints: ConstraintRow[] = [];
    const key = (await tableInfo(this.db, table)).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    if (key.length) {
      constraints.push({
        constraint_name: null,
        constraint_type: "PRIMARY KEY",
        constraint_column_names: key.map((c) => c.name),
        constraint_column_usage: [],
      });
    }
    const { results } = await this.db
      .prepare(`SELECT id, seq, "table" AS target, "from" AS source, "to" AS referenced FROM pragma_foreign_key_list(?)`)
      .bind(table)
      .all<{ id: number; seq: number; target: string; source: string; referenced: string | null }>();
    const byId = new Map<number, typeof results>();
    for (const row of results) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
    for (const rows of byId.values()) {
      rows.sort((a, b) => a.seq - b.seq);
      constraints.push({
        constraint_name: null,
        constraint_type: "FOREIGN KEY",
        constraint_column_names: rows.map((r) => r.source),
        constraint_column_usage: rows.map((r) => ({
          fk_catalog: CATALOG,
          fk_db_schema: DB_SCHEMA,
          fk_table: r.target,
          fk_column_name: r.referenced ?? r.source,
        })),
      });
    }
    return constraints;
  }
}

class D1Statement extends Statement {
  private sql: string | null = null;
  private bound: { schema: Schema; rows: SqlValue[][] } | null = null;
  private readonly ingest = new Map<string, string>();

  constructor(
    private readonly db: D1Database,
    private readonly options: D1Options,
  ) {
    super();
  }

  override async setSqlQuery(sql: string): Promise<void> {
    this.sql = sql;
    this.ingest.clear();
  }

  override async prepare(): Promise<void> {
    this.query();
  }

  override async setOption(key: string, value: OptionValue): Promise<void> {
    if (!key.startsWith("adbc.ingest.") || typeof value !== "string")
      throw new AdbcError(`${key} is not supported by D1`, "not_implemented");
    this.ingest.set(key, value);
  }

  override async bind(schema: Schema, value: RecordBatch): Promise<void> {
    this.bound = { schema, rows: rowsOf(value) };
  }

  override async bindStream(schema: Schema, batches: readonly RecordBatch[]): Promise<void> {
    this.bound = { schema, rows: batches.flatMap(rowsOf) };
  }

  override async execute(): Promise<QueryResult> {
    if (this.options.readOnly) refuseWrites(this.query());
    const rows = this.bound?.rows ?? [[]];
    if (rows.length !== 1) throw new AdbcError("Queries take at most one row of parameters", "invalid_arguments");
    const [names, ...values] = await this.db
      .prepare(this.query())
      .bind(...rows[0]!)
      .raw<unknown[]>({ columnNames: true });
    return queryResult((names ?? []) as unknown as string[], values);
  }

  override async executeSchema(): Promise<Schema> {
    return (await this.execute()).schema;
  }

  override async executeUpdate(): Promise<bigint | null> {
    if (this.options.readOnly) throw new AdbcError("This gateway is read-only", "unauthorized");
    if (this.ingest.has("adbc.ingest.target_table")) return this.ingestBound();
    const sql = this.query();
    const rows = this.bound?.rows ?? [[]];
    let changes = 0;
    for (let i = 0; i < rows.length; i += ROWS_PER_WRITE) {
      const statements = rows.slice(i, i + ROWS_PER_WRITE).map((row) => this.db.prepare(sql).bind(...row));
      for (const done of await this.db.batch(statements)) changes += done.meta.changes ?? 0;
    }
    return BigInt(changes);
  }

  /** ADBC bulk ingestion: create (per mode) and append the bound rows. */
  private async ingestBound(): Promise<bigint> {
    const table = this.ingest.get("adbc.ingest.target_table")!;
    const target = this.ingest.get("adbc.ingest.target_db_schema");
    if (target && target !== "main") throw new AdbcError("D1 has no schemas", "not_found");
    if (!this.bound) throw new AdbcError("Ingestion requires bound data", "invalid_state");
    const mode = this.ingest.get("adbc.ingest.mode") ?? "adbc.ingest.mode.create";
    const { schema: bound, rows } = this.bound;
    const name = quote(table);
    const columns = bound.fields.map((f) => `${quote(f.name)} ${sqliteType(f.type)}`).join(", ");
    const setup: string[] = [];
    if (mode === "adbc.ingest.mode.replace") setup.push(`DROP TABLE IF EXISTS ${name}`);
    if (mode === "adbc.ingest.mode.create" || mode === "adbc.ingest.mode.replace")
      setup.push(`CREATE TABLE ${name} (${columns})`);
    else if (mode === "adbc.ingest.mode.create_append") setup.push(`CREATE TABLE IF NOT EXISTS ${name} (${columns})`);
    else if (mode !== "adbc.ingest.mode.append") throw new AdbcError(`Unknown ingestion mode ${mode}`, "invalid_arguments");
    for (const sql of setup) await this.db.prepare(sql).run();
    if (!rows.length) return 0n;
    const insert = `INSERT INTO ${name} (${bound.fields.map((f) => quote(f.name)).join(", ")}) VALUES (${bound.fields
      .map(() => "?")
      .join(", ")})`;
    let changes = 0;
    for (let i = 0; i < rows.length; i += ROWS_PER_WRITE) {
      const statements = rows.slice(i, i + ROWS_PER_WRITE).map((row) => this.db.prepare(insert).bind(...row));
      for (const done of await this.db.batch(statements)) changes += done.meta.changes ?? 0;
    }
    return BigInt(changes);
  }

  private query(): string {
    if (this.sql === null) throw new AdbcError("No SQL query was set", "invalid_state");
    return this.sql;
  }
}

// ----- helpers ---------------------------------------------------------------

/**
 * D1 has no read-only connections, so a read-only gateway only runs queries
 * that start as reads and name no statement that writes. Conservative: a
 * write keyword anywhere (even inside a string) is refused.
 */
function refuseWrites(sql: string): void {
  const reads = /^\s*(select|with|values|explain)\b/i.test(sql);
  const writes = /\b(insert|update|delete|replace|create|drop|alter|attach|detach|pragma|vacuum|reindex|analyze)\b/i.test(sql);
  if (!reads || writes) throw new AdbcError("This gateway is read-only", "unauthorized");
}

function result(value: Schema, batches: RecordBatch[]): QueryResult {
  return { schema: value, batches };
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

async function tableInfo(db: D1Database, table: string): Promise<ColumnInfo[]> {
  const { results } = await db
    .prepare("SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid")
    .bind(table)
    .all<ColumnInfo>();
  return results;
}

function checkLocation(catalog: string | null, dbSchema: string | null): void {
  if ((catalog && catalog !== CATALOG) || (dbSchema && dbSchema !== DB_SCHEMA && dbSchema !== "main"))
    throw new AdbcError("D1 has one catalog (main) and no schemas", "not_found");
}

/** ADBC filters are SQL LIKE patterns (% and _); null matches everything. */
function likeMatches(pattern: string | null, value: string): boolean {
  if (pattern === null) return true;
  const regex = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${regex}$`, "is").test(value);
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** SQLite column affinity rules (sqlite.org/datatype3.html), as Arrow types. */
function declaredType(declared: string): DataType {
  const t = declared.toUpperCase();
  if (t.includes("INT")) return int64();
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return utf8();
  if (t.includes("BLOB")) return binary();
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return float64();
  if (t.includes("BOOL")) return bool();
  if (t.includes("DEC") || t.includes("NUMERIC")) return float64();
  // DATE/TIME/untyped columns hold text in practice.
  return utf8();
}

function sqliteType(type: DataType): string {
  switch (type.typeId) {
    case TypeId.Int:
      return "INTEGER";
    case TypeId.Float:
      return "REAL";
    case TypeId.Binary:
      return "BLOB";
    case TypeId.Bool:
      return "BOOLEAN";
    case TypeId.Decimal:
      return "NUMERIC";
    case TypeId.Date:
      return "DATE";
    case TypeId.Timestamp:
      return "TIMESTAMP";
    default:
      return "TEXT";
  }
}

/** Arrow values as D1 parameters. */
function rowsOf(value: RecordBatch): SqlValue[][] {
  const columns = value.schema.fields.map((f, i) => ({ type: f.type, column: value.getChildAt(i) }));
  const rows: SqlValue[][] = [];
  for (let r = 0; r < value.numRows; r++) rows.push(columns.map(({ type, column }) => toSql(column?.get(r), type)));
  return rows;
}

function toSql(value: unknown, type: DataType): SqlValue {
  if (value === null || value === undefined) return null;
  if (type.typeId === TypeId.Decimal) {
    // flechette (and arrow-js) hand decimals over unscaled: 4.5 is 45n at scale 1.
    const scale = (type as unknown as { scale: number }).scale;
    if (typeof value === "bigint" || typeof value === "number") return Number(value) / 10 ** scale;
    return Number(String(value));
  }
  if (typeof value === "bigint") {
    if (type.typeId === TypeId.Timestamp) return new Date(Number(value / 1000n)).toISOString();
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (type.typeId === TypeId.Date) return new Date(value).toISOString().slice(0, 10);
    if (type.typeId === TypeId.Timestamp) return new Date(value).toISOString();
    return value;
  }
  if (value instanceof Date)
    return type.typeId === TypeId.Date ? value.toISOString().slice(0, 10) : value.toISOString();
  if (value instanceof Uint8Array) return value.slice().buffer;
  return String(value);
}

/**
 * Arrow columns for D1's untyped rows: integers become int64, other numbers
 * float64, blobs binary, anything else text. A column with only NULLs is text.
 */
function queryResult(columnNames: string[], rows: unknown[][]): QueryResult {
  // Arrow allows duplicate names, but batches are built by name: number repeats.
  const seen = new Map<string, number>();
  const names = columnNames.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count ? `${name}_${count}` : name;
  });
  const kinds = names.map((_, i) => {
    let kind: "int" | "float" | "text" | "blob" | null = null;
    for (const row of rows) {
      const v = row[i];
      if (v === null || v === undefined) continue;
      const k =
        typeof v === "number"
          ? Number.isInteger(v)
            ? "int"
            : "float"
          : v instanceof ArrayBuffer || Array.isArray(v)
            ? "blob"
            : "text";
      kind = kind === null || kind === k ? k : (kind === "int" && k === "float") || (kind === "float" && k === "int") ? "float" : "text";
    }
    return kind ?? "text";
  });
  const types = { int: int64, float: float64, text: utf8, blob: binary } as const;
  const value = schema(names.map((name, i) => field(name, types[kinds[i]!](), true)));
  const convert = (v: unknown, kind: string): unknown => {
    if (v === null || v === undefined) return null;
    if (kind === "int") return BigInt(v as number);
    if (kind === "float") return Number(v);
    if (kind === "blob") return v instanceof ArrayBuffer ? new Uint8Array(v) : Uint8Array.from(v as number[]);
    return typeof v === "string" ? v : String(v);
  };
  const batches: RecordBatch[] = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_BATCH) {
    const chunk = rows.slice(start, start + ROWS_PER_BATCH);
    const columns = Object.fromEntries(names.map((name, i) => [name, chunk.map((row) => convert(row[i], kinds[i]!))]));
    batches.push(batch(value, columns));
  }
  return result(value, batches);
}
