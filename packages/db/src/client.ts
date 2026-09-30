import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./types.generated";

export type Database = Kysely<DB>;

const DATE_OID = 1082;

/**
 * Returns `date` columns as "YYYY-MM-DD" strings. pg's default parser builds a Date at local
 * midnight, which can shift a trading date by a day depending on the process time zone.
 * `numeric` and `bigint` stay strings (pg's default), matching the generated types.
 */
function getTypeParser(
  oid: number,
  format: "text" | "binary" = "text",
): (value: string) => unknown {
  if (oid === DATE_OID) return (value: string) => value;
  return pg.types.getTypeParser(oid, format) as (value: string) => unknown;
}

const typeParsers: pg.CustomTypesConfig = { getTypeParser };

export interface PoolOptions {
  max?: number;
  applicationName?: string;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "market-analysis",
    types: typeParsers,
  });
}

export function createDb(pool: pg.Pool): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
