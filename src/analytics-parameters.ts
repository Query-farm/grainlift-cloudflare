// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// Bound parameters for Analytics Engine, whose SQL API has none: each `?` is
// replaced by a literal of its value. DuckDB pushes filter values down this
// way (`WHERE "timestamp" > ?`).
//
// The literals are safe by construction, following what the API accepts
// (measured): a string literal may not contain a single quote or a backslash
// at all, escaped or not, so a text value without them cannot leave its
// quotes, and one with them is refused (the API would refuse it too). Numbers
// are plain decimals (the parser has no exponent notation), timestamps
// `toDateTime('YYYY-MM-DD HH:MM:SS')`, whole seconds only.
import { AdbcError, type RecordBatch } from "@query-farm/grainlift";

// Arrow type ids (Arrow FlatBuffer `Type`).
const TypeId = { Null: 1, Int: 2, Float: 3, Binary: 4, Utf8: 5, Bool: 6, Decimal: 7, Date: 8, Timestamp: 10, LargeUtf8: 20, LargeBinary: 19, Utf8View: 24 } as const;

/** `sql` with each `?` placeholder replaced by the literal of the bound row's value. */
export function inlineParameters(sql: string, parameters: RecordBatch): string {
  if (parameters.numRows !== 1) {
    throw new AdbcError(
      `Analytics Engine runs a query with one row of parameters; ${parameters.numRows} are bound`,
      "invalid_arguments",
    );
  }
  const places = placeholders(sql);
  const fields = parameters.schema.fields;
  if (places.length !== fields.length) {
    throw new AdbcError(`The query has ${places.length} ? placeholders but ${fields.length} parameters are bound`, "invalid_arguments");
  }
  let out = "";
  let from = 0;
  places.forEach((at, i) => {
    const field = fields[i]!;
    const value = parameters.getChildAt(i)?.get(0);
    out += sql.slice(from, at) + literal(value, field.type as unknown as ArrowType, field.name, operatorAround(sql, at));
    from = at + 1;
  });
  return out + sql.slice(from);
}

interface ArrowType {
  typeId: number;
  unit?: number;
}

/** Offsets of `?` placeholders outside strings, quoted identifiers and comments. */
export function placeholders(sql: string): number[] {
  const found: number[] = [];
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = sql.indexOf(c, i + 1);
      i = end === -1 ? sql.length : end;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === "?") {
      found.push(i);
    }
  }
  return found;
}

/**
 * The comparison a placeholder takes part in, as `column OP ?`: the operator
 * before it, or the mirror of the one after it (`? OP column`).
 */
function operatorAround(sql: string, at: number): string | null {
  const before = /(>=|<=|<>|!=|=|>|<)\s*$/.exec(sql.slice(0, at))?.[1];
  if (before) return before;
  const after = /^\s*(>=|<=|<>|!=|=|>|<)/.exec(sql.slice(at + 1))?.[1];
  const mirror: Record<string, string> = { ">": "<", "<": ">", ">=": "<=", "<=": ">=" };
  return after ? (mirror[after] ?? after) : null;
}

function literal(value: unknown, type: ArrowType, name: string, operator: string | null): string {
  if (value === null || value === undefined) return "NULL";
  switch (type.typeId) {
    case TypeId.Bool:
      return value ? "true" : "false";
    case TypeId.Int:
      return BigInt(value as number | bigint).toString();
    case TypeId.Float:
    case TypeId.Decimal:
      return decimal(Number(value), name);
    case TypeId.Utf8:
    case TypeId.LargeUtf8:
    case TypeId.Utf8View:
      return text(String(value), name);
    case TypeId.Timestamp:
      return timestamp(epochMicros(value, type), name, operator);
    case TypeId.Date:
      // The API has no date literal (toDate takes no text), so a date is midnight UTC.
      return timestamp(BigInt(epochMillis(value)) * 1000n, name, operator);
    default:
      throw new AdbcError(`Parameter ${name} has a type Analytics Engine queries cannot take`, "not_implemented");
  }
}

function text(value: string, name: string): string {
  if (/['\\]/.test(value)) {
    throw new AdbcError(`Parameter ${name} contains ' or \\, which Analytics Engine does not accept in text`, "invalid_arguments");
  }
  return `'${value}'`;
}

function decimal(value: number, name: string): string {
  if (!Number.isFinite(value)) throw new AdbcError(`Parameter ${name} is not a finite number`, "invalid_arguments");
  // No exponent notation: the API's parser does not read it.
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 100 });
}

/**
 * A timestamp as `toDateTime('…')`. Analytics Engine keeps whole seconds, so
 * a fractional value is rounded in the direction that keeps the comparison
 * exact for whole-second columns: `t > 10.5` is `t > 10`, `t >= 10.5` is
 * `t >= 11`. Where no rounding is exact (`=`, or no comparison), it is refused.
 */
function timestamp(micros: bigint, name: string, operator: string | null): string {
  let seconds = micros / 1_000_000n;
  if (micros % 1_000_000n < 0n) seconds -= 1n; // floor for times before 1970
  if (micros % 1_000_000n !== 0n) {
    if (operator === ">=" || operator === "<") seconds += 1n;
    else if (operator !== ">" && operator !== "<=") {
      throw new AdbcError(
        `Parameter ${name} has fractions of a second, which Analytics Engine timestamps do not; ` +
          "compare it with <, <=, > or >=, or round it to whole seconds",
        "invalid_arguments",
      );
    }
  }
  const iso = new Date(Number(seconds) * 1000).toISOString();
  return `toDateTime('${iso.slice(0, 10)} ${iso.slice(11, 19)}')`;
}

/** Microseconds since the epoch for an Arrow timestamp value, whichever form the backend gives. */
function epochMicros(value: unknown, type: ArrowType): bigint {
  if (value instanceof Date) return BigInt(value.getTime()) * 1000n;
  const raw = BigInt(typeof value === "number" ? Math.trunc(value) : (value as bigint));
  // Arrow TimeUnit: 0 seconds, 1 milliseconds, 2 microseconds, 3 nanoseconds.
  switch (type.unit) {
    case 0:
      return raw * 1_000_000n;
    case 1:
      return raw * 1000n;
    case 3:
      return raw / 1000n;
    default:
      return raw;
  }
}

/** Milliseconds since the epoch for an Arrow date value (a Date, days, or milliseconds). */
function epochMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Math.abs(n) < 1e8 ? n * 86_400_000 : n;
}
