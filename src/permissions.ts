// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// Who may use which database, from the PERMISSIONS setting: JSON mapping
// principals to grants. Fails closed: a principal no grant names gets nothing.
//
//   {
//     "alice@example.com": [{ "target": "durable_object", "namespace": "ROOMS", "access": "read_write" }],
//     "@example.com":      [{ "target": "d1", "database": "ANALYTICS" }],
//     "etl":               [{ "target": "*", "access": "read_write" }]
//   }
//
// A key is a principal (a token's name, or a signed-in user's email), an
// email domain ("@example.com"), "*" (every signed-in principal) or
// "anonymous" (clients without credentials, when ALLOW_ANONYMOUS is on).

/** What a grant allows. */
export type Access = "read" | "read_write";

/** One database a connection opens. */
export type Resource =
  | { target: "sqlite" }
  | { target: "d1"; database: string }
  | { target: "durable_object"; namespace: string; name?: string; id?: string }
  | { target: "analytics_engine" };

interface Grant {
  target: string;
  namespace?: string;
  object?: string;
  database?: string;
  access: Access;
}

const FIELDS: Record<string, readonly string[]> = {
  "*": [],
  sqlite: [],
  d1: ["database"],
  durable_object: ["namespace", "object"],
  analytics_engine: [],
};

export class Permissions {
  private constructor(private readonly grants: ReadonlyMap<string, readonly Grant[]>) {}

  /** Parse and check the setting; errors name the problem, never echo values beyond keys. */
  static parse(json: string | undefined): Permissions {
    if (!json?.trim()) {
      throw new Error("Set PERMISSIONS to say who may use which databases (see README, Permissions)");
    }
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      throw new Error("PERMISSIONS is not valid JSON");
    }
    if (!isObject(value)) throw new Error("PERMISSIONS must be a JSON object of principals to grants");
    const grants = new Map<string, Grant[]>();
    for (const [key, list] of Object.entries(value)) {
      const where = `PERMISSIONS[${JSON.stringify(key)}]`;
      if (!key) throw new Error("PERMISSIONS has an empty principal");
      if (!Array.isArray(list)) throw new Error(`${where} must be a list of grants`);
      grants.set(principalKey(key), list.map((grant, i) => parseGrant(grant, `${where}[${i}]`)));
    }
    return new Permissions(grants);
  }

  /** Whether `principal` may use `target` at all (checked before a connection opens). */
  allowsTarget(principal: string, target: string): boolean {
    return this.matching(principal).some((grant) => grant.target === "*" || grant.target === target);
  }

  /** The access `principal` has to `resource`, or null for none. */
  access(principal: string, resource: Resource): Access | null {
    let access: Access | null = null;
    for (const grant of this.matching(principal)) {
      if (!covers(grant, resource)) continue;
      if (grant.access === "read_write") return "read_write";
      access = "read";
    }
    return access;
  }

  private matching(principal: string): Grant[] {
    const key = principalKey(principal);
    const keys = [key];
    if (key !== "anonymous") {
      keys.push("*");
      const at = key.lastIndexOf("@");
      if (at > 0) keys.push(key.slice(at));
    }
    return keys.flatMap((k) => this.grants.get(k) ?? []);
  }
}

function parseGrant(value: unknown, where: string): Grant {
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  const target = value.target;
  if (typeof target !== "string" || !(target in FIELDS)) {
    throw new Error(`${where}.target must be one of: ${Object.keys(FIELDS).join(", ")}`);
  }
  const allowed = new Set(["target", "access", ...FIELDS[target]!]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${where}: ${field} does not apply to target ${target}`);
  }
  const text = (field: string): string | undefined => {
    const v = value[field];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v) throw new Error(`${where}.${field} must be a non-empty string`);
    if (v.indexOf("*") !== -1 && v.indexOf("*") !== v.length - 1) {
      throw new Error(`${where}.${field} may use * only at the end (a prefix)`);
    }
    return v;
  };
  const access = value.access ?? "read";
  if (access !== "read" && access !== "read_write") throw new Error(`${where}.access must be "read" or "read_write"`);
  return { target, namespace: text("namespace"), object: text("object"), database: text("database"), access };
}

function covers(grant: Grant, resource: Resource): boolean {
  if (grant.target === "*") return true;
  if (grant.target !== resource.target) return false;
  switch (resource.target) {
    case "sqlite":
    case "analytics_engine":
      return true;
    case "d1":
      return matches(grant.database, resource.database);
    case "durable_object":
      // An object chosen by id has no name to match, so only `object: "*"` (or none) covers it.
      return matches(grant.namespace, resource.namespace) && matches(grant.object, resource.name ?? null);
  }
}

/** A missing pattern or "*" matches anything; "prefix*" a prefix; otherwise exactly. */
function matches(pattern: string | undefined, value: string | null): boolean {
  if (pattern === undefined || pattern === "*") return true;
  if (value === null) return false;
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

/** Emails compare case-insensitively; other principals exactly. */
function principalKey(principal: string): string {
  return principal.includes("@") ? principal.toLowerCase() : principal;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
