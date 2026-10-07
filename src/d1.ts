// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// The `d1` target: one of the Worker's D1 bindings, chosen by the client in
// its database options. A Worker reaches only the D1 databases bound to it,
// so the gateway serves those that D1_DATABASES lists.
import { AdbcError, type OpenOptions } from "@query-farm/grainlift";
import type { Resource } from "./permissions";
import { D1Store } from "./stores";

/** The binding name of the D1 database, such as `DB`. */
export const D1_DATABASE_OPTION = "cloudflare.d1.database";

/**
 * The D1 databases clients may choose, by binding name: those listed (comma
 * separated) that are D1 bindings of this Worker.
 */
export function d1Databases(env: object, listed: string | undefined): Map<string, D1Database> {
  const databases = new Map<string, D1Database>();
  for (const name of (listed ?? "").split(",").map((n) => n.trim()).filter(Boolean)) {
    const binding = (env as Record<string, unknown>)[name] as Partial<D1Database> | undefined;
    if (typeof binding?.prepare !== "function" || typeof binding.batch !== "function") {
      throw new Error(`D1_DATABASES lists ${name}, which is not a D1 binding`);
    }
    databases.set(name, binding as D1Database);
  }
  return databases;
}

/** The store for the database a client's options choose; with one listed, it need not be named. */
export function d1Store(
  databases: ReadonlyMap<string, D1Database>,
  maxQueries: number,
  options: OpenOptions,
): { store: D1Store; resource: Resource } {
  const value = options.databaseOptions.get(D1_DATABASE_OPTION);
  if (value !== undefined && (typeof value !== "string" || !value)) {
    throw new AdbcError(`${D1_DATABASE_OPTION} must be a non-empty string`, "invalid_arguments");
  }
  const name = value ?? (databases.size === 1 ? [...databases.keys()][0] : undefined);
  if (!name) throw new AdbcError(`Set ${D1_DATABASE_OPTION} to one of: ${[...databases.keys()].join(", ")}`, "invalid_arguments");
  const database = databases.get(name);
  if (!database) throw new AdbcError(`D1 database ${name} is not available`, "not_found");
  return {
    store: new D1Store(database, maxQueries, databases.size === 1 ? "D1" : `D1 ${name}`),
    resource: { target: "d1", database: name },
  };
}
