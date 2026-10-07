// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// SQL over a Durable Object's own SQLite storage. Only code running inside an
// object can reach its storage, so the gateway uses these functions for its
// own object (DurableSqlStore) and other objects run them on its behalf
// (GrainliftSqlObject). No Grainlift dependency: any Worker can include it,
// with grainlift-sql-object.ts; the two files need nothing else.

/** A SQLite value as Workers bind and return it. */
export type SqlValue = string | number | null | ArrayBuffer;

/** One statement of an atomic write. */
export interface SqlWrite {
  sql: string;
  params: SqlValue[];
}

/** Run a query: its column names and rows of values. */
export function sqlRows(
  storage: DurableObjectStorage,
  sql: string,
  params: SqlValue[],
): { columns: string[]; rows: unknown[][] } {
  const cursor = storage.sql.exec(sql, ...params);
  const rows = [...cursor.raw()];
  return { columns: cursor.columnNames, rows };
}

/** Run a query: rows as objects keyed by column name. */
export function sqlObjects(storage: DurableObjectStorage, sql: string, params: SqlValue[]): Record<string, unknown>[] {
  return storage.sql.exec(sql, ...params).toArray();
}

/** Run the statements as one transaction (all or nothing); rows changed. */
export function sqlWrite(storage: DurableObjectStorage, statements: SqlWrite[]): number {
  const sql = storage.sql;
  // total_changes() counts rows changed by INSERT/UPDATE/DELETE only, so DDL
  // in the batch does not distort the count (changes() would be stale).
  const total = () => Number(sql.exec("SELECT total_changes() AS n").one().n);
  return storage.transactionSync(() => {
    const before = total();
    for (const statement of statements) sql.exec(statement.sql, ...statement.params);
    return total() - before;
  });
}
