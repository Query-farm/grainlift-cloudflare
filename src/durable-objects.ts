// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// The `durable_object` target: a client chooses one Durable Object, by its
// namespace's binding name and the object's name or id, in its database
// options. The gateway reaches only namespaces it is bound to and that
// DURABLE_OBJECT_NAMESPACES lists, and only objects whose class extends
// GrainliftSqlObject.
import { AdbcError, type OpenOptions, type OptionValue } from "@query-farm/grainlift";
import type { GrainliftSqlObject } from "./grainlift-sql-object";
import type { Resource } from "./permissions";
import { DurableObjectStore } from "./stores";

/** The binding name of the object's namespace, such as `ROOMS`. */
export const NAMESPACE_OPTION = "cloudflare.durable_object.namespace";
/** The object's name, as the namespace's `idFromName` takes it. */
export const NAME_OPTION = "cloudflare.durable_object.name";
/** The object's id, as 64 hex digits (for objects made with `newUniqueId`). */
export const ID_OPTION = "cloudflare.durable_object.id";
export const DURABLE_OBJECT_OPTIONS: ReadonlySet<string> = new Set([NAMESPACE_OPTION, NAME_OPTION, ID_OPTION]);

type Namespace = DurableObjectNamespace<GrainliftSqlObject>;

/**
 * The namespaces clients may choose, by binding name: those listed (comma
 * separated) that are Durable Object bindings of this Worker.
 */
export function durableObjectNamespaces(env: object, listed: string | undefined): Map<string, Namespace> {
  const namespaces = new Map<string, Namespace>();
  for (const name of (listed ?? "").split(",").map((n) => n.trim()).filter(Boolean)) {
    const binding = (env as Record<string, unknown>)[name] as Partial<Namespace> | undefined;
    if (typeof binding?.idFromName !== "function" || typeof binding.get !== "function") {
      throw new Error(`DURABLE_OBJECT_NAMESPACES lists ${name}, which is not a Durable Object binding`);
    }
    namespaces.set(name, binding as Namespace);
  }
  return namespaces;
}

/** Open the store for the object a client's database options choose, and name it for permissions. */
export function durableObjectStore(
  namespaces: ReadonlyMap<string, Namespace>,
  options: OpenOptions,
): { store: DurableObjectStore; resource: Resource } {
  const given = options.databaseOptions;
  const text = (key: string) => {
    const value: OptionValue | undefined = given.get(key);
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value) throw new AdbcError(`${key} must be a non-empty string`, "invalid_arguments");
    return value;
  };
  // With one namespace, it need not be named.
  const namespaceName = text(NAMESPACE_OPTION) ?? (namespaces.size === 1 ? [...namespaces.keys()][0] : undefined);
  if (!namespaceName) {
    throw new AdbcError(`Set ${NAMESPACE_OPTION} to one of: ${[...namespaces.keys()].join(", ")}`, "invalid_arguments");
  }
  const namespace = namespaces.get(namespaceName);
  if (!namespace) throw new AdbcError(`Durable Object namespace ${namespaceName} is not available`, "not_found");
  const name = text(NAME_OPTION);
  const id = text(ID_OPTION);
  if ((name === undefined) === (id === undefined)) {
    throw new AdbcError(`Set ${NAME_OPTION} or ${ID_OPTION} (one of them) to choose the Durable Object`, "invalid_arguments");
  }
  let objectId: DurableObjectId;
  if (name !== undefined) {
    objectId = namespace.idFromName(name);
  } else {
    try {
      objectId = namespace.idFromString(id!);
    } catch {
      throw new AdbcError(`${ID_OPTION} is not an id of an object in ${namespaceName}`, "invalid_arguments");
    }
  }
  const label = name !== undefined ? `${namespaceName} ${JSON.stringify(name)}` : `${namespaceName} ${id}`;
  return {
    store: new DurableObjectStore(label, namespace.get(objectId)),
    resource: { target: "durable_object", namespace: namespaceName, name, id },
  };
}
