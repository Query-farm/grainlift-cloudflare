// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// The two places the gateway keeps a SQLite database.
import { AdbcError } from "@query-farm/grainlift";
import type { SqlStore, SqlValue, SqlWrite } from "./sqlite";

/**
 * Cloudflare D1. A write is one `db.batch()`, which D1 runs as a transaction,
 * so it lands whole or not at all; every statement in it counts toward D1's
 * queries-per-request limit (1,000 on Workers Paid, 50 on Free).
 */
export class D1Store implements SqlStore {
  readonly name = "D1";

  constructor(
    private readonly db: D1Database,
    private readonly maxQueries = 1000,
  ) {}

  async rows(sql: string, params: SqlValue[]): Promise<{ columns: string[]; rows: unknown[][] }> {
    const [columns, ...rows] = await this.db
      .prepare(sql)
      .bind(...params)
      .raw<unknown[]>({ columnNames: true });
    return { columns: (columns ?? []) as unknown as string[], rows };
  }

  async objects<T>(sql: string, params: SqlValue[]): Promise<T[]> {
    return (
      await this.db
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results;
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
    const done = await this.db.batch(statements.map((s) => this.db.prepare(s.sql).bind(...s.params)));
    return done.reduce((changes, result) => changes + (result.meta.changes ?? 0), 0);
  }
}

/**
 * The Durable Object's own SQLite storage. Queries run in-process, with no
 * per-request query limit, and a write is one `transactionSync`.
 */
export class DurableSqlStore implements SqlStore {
  readonly name = "Durable Object SQLite";

  constructor(private readonly storage: DurableObjectStorage) {}

  async rows(sql: string, params: SqlValue[]): Promise<{ columns: string[]; rows: unknown[][] }> {
    const cursor = this.storage.sql.exec(sql, ...params);
    const rows = [...cursor.raw()];
    return { columns: cursor.columnNames, rows };
  }

  async objects<T>(sql: string, params: SqlValue[]): Promise<T[]> {
    return this.storage.sql.exec(sql, ...params).toArray() as T[];
  }

  async write(statements: SqlWrite[]): Promise<number> {
    const sql = this.storage.sql;
    // total_changes() counts rows changed by INSERT/UPDATE/DELETE only, so DDL
    // in the batch does not distort the count (changes() would be stale).
    const total = () => Number(sql.exec("SELECT total_changes() AS n").one().n);
    return this.storage.transactionSync(() => {
      const before = total();
      for (const statement of statements) sql.exec(statement.sql, ...statement.params);
      return total() - before;
    });
  }
}
