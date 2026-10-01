// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// The result schemas ADBC defines for connection metadata (adbc.h:
// AdbcConnectionGetObjects, AdbcConnectionGetTableTypes). Clients read these
// by position, so names, nesting, types and nullability follow the spec.
import { bool, type Field, field, int16, int32, list, type Schema, schema, struct, utf8 } from "@query-farm/grainlift";

const item = (type: Field["type"]) => list(field("item", type, true));

const usage = struct([
  field("fk_catalog", utf8(), true),
  field("fk_db_schema", utf8(), true),
  field("fk_table", utf8(), false),
  field("fk_column_name", utf8(), false),
]);

const constraint = struct([
  field("constraint_name", utf8(), true),
  field("constraint_type", utf8(), false),
  field("constraint_column_names", item(utf8()), false),
  field("constraint_column_usage", item(usage), true),
]);

const column = struct([
  field("column_name", utf8(), false),
  field("ordinal_position", int32(), true),
  field("remarks", utf8(), true),
  field("xdbc_data_type", int16(), true),
  field("xdbc_type_name", utf8(), true),
  field("xdbc_column_size", int32(), true),
  field("xdbc_decimal_digits", int16(), true),
  field("xdbc_num_prec_radix", int16(), true),
  field("xdbc_nullable", int16(), true),
  field("xdbc_column_def", utf8(), true),
  field("xdbc_sql_data_type", int16(), true),
  field("xdbc_datetime_sub", int16(), true),
  field("xdbc_char_octet_length", int32(), true),
  field("xdbc_is_nullable", utf8(), true),
  field("xdbc_scope_catalog", utf8(), true),
  field("xdbc_scope_schema", utf8(), true),
  field("xdbc_scope_table", utf8(), true),
  field("xdbc_is_autoincrement", bool(), true),
  field("xdbc_is_generatedcolumn", bool(), true),
]);

const table = struct([
  field("table_name", utf8(), false),
  field("table_type", utf8(), false),
  field("table_columns", item(column), true),
  field("table_constraints", item(constraint), true),
]);

const dbSchema = struct([field("db_schema_name", utf8(), true), field("db_schema_tables", item(table), true)]);

export const GET_OBJECTS_SCHEMA: Schema = schema([
  field("catalog_name", utf8(), true),
  field("catalog_db_schemas", item(dbSchema), true),
]);

export const GET_TABLE_TYPES_SCHEMA: Schema = schema([field("table_type", utf8(), false)]);

/** ADBC_OBJECT_DEPTH_*: 0 = everything (columns), 1 catalogs, 2 schemas, 3 tables. */
export const enum ObjectDepth {
  All = 0,
  Catalogs = 1,
  DbSchemas = 2,
  Tables = 3,
}

export interface ColumnRow {
  column_name: string;
  ordinal_position: number;
  remarks: null;
  xdbc_data_type: null;
  xdbc_type_name: string | null;
  xdbc_column_size: null;
  xdbc_decimal_digits: null;
  xdbc_num_prec_radix: null;
  xdbc_nullable: number;
  xdbc_column_def: string | null;
  xdbc_sql_data_type: null;
  xdbc_datetime_sub: null;
  xdbc_char_octet_length: null;
  xdbc_is_nullable: string;
  xdbc_scope_catalog: null;
  xdbc_scope_schema: null;
  xdbc_scope_table: null;
  xdbc_is_autoincrement: boolean | null;
  xdbc_is_generatedcolumn: boolean | null;
}

export interface ConstraintRow {
  constraint_name: string | null;
  constraint_type: string;
  constraint_column_names: string[];
  constraint_column_usage: {
    fk_catalog: string | null;
    fk_db_schema: string | null;
    fk_table: string;
    fk_column_name: string;
  }[];
}

export interface TableRow {
  table_name: string;
  table_type: string;
  table_columns: ColumnRow[] | null;
  table_constraints: ConstraintRow[] | null;
}
