// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// Lets the gateway query a Durable Object's SQLite storage. A Durable Object's
// storage is private to the object, so the object runs the gateway's SQL
// itself, through these RPC methods. Extend GrainliftSqlObject instead of
// DurableObject, or, for a class with another base, add the three methods and
// delegate to the functions in durable-sql.ts.
//
// Any Worker with a binding to the class can call these methods with
// arbitrary SQL, so give one only to Workers you trust with the data.
import { DurableObject } from "cloudflare:workers";
import { type SqlValue, type SqlWrite, sqlObjects, sqlRows, sqlWrite } from "./durable-sql";

/** The methods the gateway calls, over Durable Object RPC. */
export interface GrainliftSqlRpc {
  grainliftRows(sql: string, params: SqlValue[]): { columns: string[]; rows: unknown[][] };
  grainliftObjects(sql: string, params: SqlValue[]): Record<string, unknown>[];
  grainliftWrite(statements: SqlWrite[]): number;
}

/** A Durable Object whose SQLite storage the gateway can query and write. */
export class GrainliftSqlObject<Env = unknown> extends DurableObject<Env> implements GrainliftSqlRpc {
  grainliftRows(sql: string, params: SqlValue[]): { columns: string[]; rows: unknown[][] } {
    return sqlRows(this.ctx.storage, sql, params);
  }

  grainliftObjects(sql: string, params: SqlValue[]): Record<string, unknown>[] {
    return sqlObjects(this.ctx.storage, sql, params);
  }

  grainliftWrite(statements: SqlWrite[]): number {
    return sqlWrite(this.ctx.storage, statements);
  }
}
