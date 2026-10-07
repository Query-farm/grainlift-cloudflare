// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// An ordinary application Durable Object, a chat room keeping its messages in
// its own SQLite storage, that the gateway can also query: it extends
// GrainliftSqlObject instead of DurableObject. Each room is a separate
// object, chosen with the cloudflare.durable_object.name option.
import { GrainliftSqlObject } from "./grainlift-sql-object";

export class ExampleRoom extends GrainliftSqlObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
  }

  /** The application's own method, called by its Worker as usual. */
  post(author: string, body: string): void {
    this.ctx.storage.sql.exec("INSERT INTO messages (author, body) VALUES (?, ?)", author, body);
  }
}
