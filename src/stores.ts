// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// The two places the gateway keeps a SQLite database.
import { AdbcError, type Status } from "@query-farm/grainlift";
import { paramBytes, type SqlStore, type SqlValue, type SqlWrite } from "./sqlite";

/**
 * Both stores reject a row (the sum of its values) larger than about 8 MiB
 * with SQLITE_TOOBIG: measured, 8,388,609 bytes pass and 8,500,000 fail, in
 * one value or split across two (Cloudflare documents 2 MB).
 */
const MAX_ROW_BYTES = 8 * 2 ** 20;

/**
 * The service hides every error that is not an AdbcError ("Worker operation
 * failed"), so pass the database's own message on: SQL mistakes, constraint
 * violations and the store's size limits are the user's to see.
 */
async function surfaced<T>(store: string, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AdbcError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const status: Status = /constraint/i.test(message)
      ? "integrity"
      : /syntax|no such|SQLITE_ERROR|SQLITE_RANGE|datatype mismatch/i.test(message)
        ? "invalid_arguments"
        : "io";
    throw new AdbcError(`${store}: ${message}`, status);
  }
}

/** Below D1's 32 MiB limit on one call's serialized arguments, for overhead. */
const MAX_D1_BATCH_BYTES = 30 * 2 ** 20;

/**
 * Cloudflare D1. A write is one `db.batch()`, which D1 runs as a transaction,
 * so it lands whole or not at all; every statement in it counts toward D1's
 * queries-per-request limit (1,000 on Workers Paid, 50 on Free), and the batch
 * as a whole must serialize to at most 32 MiB.
 */
export class D1Store implements SqlStore {
  readonly name = "D1";
  readonly maxRowBytes = MAX_ROW_BYTES;

  constructor(
    private readonly db: D1Database,
    private readonly maxQueries = 1000,
  ) {}

  async rows(sql: string, params: SqlValue[]): Promise<{ columns: string[]; rows: unknown[][] }> {
    return surfaced(this.name, async () => {
      const [columns, ...rows] = await this.db
        .prepare(sql)
        .bind(...params)
        .raw<unknown[]>({ columnNames: true });
      return { columns: (columns ?? []) as unknown as string[], rows };
    });
  }

  async objects<T>(sql: string, params: SqlValue[]): Promise<T[]> {
    return surfaced(this.name, async () => (await this.db.prepare(sql).bind(...params).all<T>()).results);
  }

  async write(statements: SqlWrite[]): Promise<number> {
    if (!statements.length) return 0;
    if (statements.length > this.maxQueries) {
      throw new AdbcError(
        `This write needs ${statements.length} statements; D1 runs at most ${this.maxQueries} in one ` +
          "request, so insert it in smaller parts (or use the sqlite target)",
        "invalid_arguments",
      );
    }
    // D1 limits one call's serialized arguments to 32 MiB; refuse before sending.
    const bytes = statements.reduce((n, s) => n + s.sql.length + s.params.reduce<number>((m, p) => m + paramBytes(p), 0), 0);
    if (bytes > MAX_D1_BATCH_BYTES) {
      throw new AdbcError(
        `This write is about ${Math.round(bytes / 2 ** 20)} MiB; D1 accepts at most 32 MiB in one request, ` +
          "so insert it in smaller parts (or use the sqlite target)",
        "invalid_arguments",
      );
    }
    const done = await surfaced(this.name, () =>
      this.db.batch(statements.map((s) => this.db.prepare(s.sql).bind(...s.params))),
    );
    return done.reduce((changes, result) => changes + (result.meta.changes ?? 0), 0);
  }
}

/**
 * The Durable Object's own SQLite storage. Queries run in-process, with no
 * per-request query limit, and a write is one `transactionSync`.
 */
export class DurableSqlStore implements SqlStore {
  readonly name = "Durable Object SQLite";
  readonly maxRowBytes = MAX_ROW_BYTES;

  constructor(private readonly storage: DurableObjectStorage) {}

  async rows(sql: string, params: SqlValue[]): Promise<{ columns: string[]; rows: unknown[][] }> {
    return surfaced(this.name, () => {
      const cursor = this.storage.sql.exec(sql, ...params);
      const rows = [...cursor.raw()];
      return { columns: cursor.columnNames, rows };
    });
  }

  async objects<T>(sql: string, params: SqlValue[]): Promise<T[]> {
    return surfaced(this.name, () => this.storage.sql.exec(sql, ...params).toArray() as T[]);
  }

  async write(statements: SqlWrite[]): Promise<number> {
    const sql = this.storage.sql;
    // total_changes() counts rows changed by INSERT/UPDATE/DELETE only, so DDL
    // in the batch does not distort the count (changes() would be stale).
    const total = () => Number(sql.exec("SELECT total_changes() AS n").one().n);
    return surfaced(this.name, () =>
      this.storage.transactionSync(() => {
        const before = total();
        for (const statement of statements) sql.exec(statement.sql, ...statement.params);
        return total() - before;
      }),
    );
  }
}
