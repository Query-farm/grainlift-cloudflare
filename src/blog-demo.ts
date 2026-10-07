// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

import { GrainliftSqlObject } from "./grainlift-sql-object";

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const DEADLINE_KEY = "blog-demo-next-reset";

/** One shared, disposable database for the query.farm Grainlift article. */
export class BlogDemo extends GrainliftSqlObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // Finish initialization/recovery before accepting SQL, including when an
    // alarm wakes a hibernating object. The deadline lives outside public SQL.
    void ctx.blockConcurrencyWhile(() => this.ensureCycle());
  }

  override async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => this.ensureCycle());
  }

  private async ensureCycle(): Promise<void> {
    const storage = this.ctx.storage;
    let deadline = await storage.get<number>(DEADLINE_KEY);
    if (deadline === undefined || deadline <= Date.now()) {
      deadline = (Math.floor(Date.now() / FOUR_HOURS) + 1) * FOUR_HOURS;
      const resetAt = new Date(deadline).toISOString();
      // Remove visitor-created tables, indexes, views and data too. Replacing
      // just the seed tables would leave arbitrary demo data behind forever.
      await storage.deleteAll();
      storage.transactionSync(() => {
        storage.sql.exec(`
          CREATE TABLE products (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL,
            category TEXT NOT NULL, price_cents INTEGER NOT NULL
          );
          INSERT INTO products VALUES
            (1, 'House blend', 'Coffee', 1400),
            (2, 'Ethiopian single origin', 'Coffee', 1900),
            (3, 'Decaf blend', 'Coffee', 1500),
            (4, 'Breakfast tea', 'Tea', 900),
            (5, 'Ceramic mug', 'Equipment', 1800),
            (6, 'Paper filters', 'Equipment', 600);
          CREATE TABLE orders (
            id INTEGER PRIMARY KEY,
            product_id INTEGER NOT NULL REFERENCES products(id),
            quantity INTEGER NOT NULL, city TEXT NOT NULL
          );
          INSERT INTO orders VALUES
            (1, 1, 3, 'Richmond'), (2, 2, 2, 'Boston'),
            (3, 5, 1, 'Richmond'), (4, 4, 4, 'Portland'),
            (5, 1, 2, 'Boston'), (6, 3, 2, 'Richmond'),
            (7, 6, 5, 'Portland'), (8, 2, 1, 'Richmond'),
            (9, 5, 2, 'Boston'), (10, 4, 3, 'Boston'),
            (11, 3, 1, 'Portland'), (12, 1, 4, 'Portland');
          CREATE TABLE visitor_notes (
            id TEXT PRIMARY KEY, note TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          );
          CREATE TABLE demo_info (description TEXT, next_reset_at TEXT);
        `);
        storage.sql.exec(
          "INSERT INTO demo_info VALUES (?, ?)",
          "Shared public demo. All data is erased and reseeded every four hours.",
          resetAt,
        );
      });
      await storage.put(DEADLINE_KEY, deadline);
    }
    // Re-arm on recovery and after an alarm. Repeated delivery in the same
    // cycle must not erase writes made since the successful reset.
    if (await storage.getAlarm() !== deadline) await storage.setAlarm(deadline);
  }
}
