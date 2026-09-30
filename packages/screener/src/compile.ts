import { sql, type Database } from "@market/db";
import type { RawBuilder } from "kysely";
import { fieldDef, type FieldId } from "./fields";
import type { Condition, Screen } from "./schema";

/**
 * Compiles a validated screen into SQL over market.screener_snapshot. Field names come only
 * from the FIELDS whitelist (as identifiers or fixed computed expressions); every value is a
 * bound parameter. NULL never satisfies a comparison, so rows missing a field drop out.
 */

function expr(id: FieldId): RawBuilder<unknown> {
  const def = fieldDef(id);
  if (def.computed) return sql.raw(`(${def.computed.sql})`);
  return sql.ref(id);
}

const OPS = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=", neq: "<>" } as const;

function condition(c: Condition): RawBuilder<boolean> {
  const left = expr(c.field);
  switch (c.op) {
    case "is_null":
      return sql<boolean>`${left} is null`;
    case "not_null":
      return sql<boolean>`${left} is not null`;
    case "between": {
      const [lo, hi] = c.value as [number, number];
      return sql<boolean>`${left} between ${lo}::float8 and ${hi}::float8`;
    }
    case "in":
      return sql<boolean>`${left} = any(${c.value}::text[])`;
    default: {
      const op = sql.raw(OPS[c.op]);
      if (c.ref) return sql<boolean>`${left} ${op} ${expr(c.ref)}`;
      if (typeof c.value === "number") return sql<boolean>`${left} ${op} ${c.value}::float8`;
      // Text comparisons ignore case (tickers and names are shown upper-case or as filed).
      return sql<boolean>`lower(${left}::text) ${op} lower(${c.value})`;
    }
  }
}

function where(screen: Screen): RawBuilder<boolean> {
  if (screen.conditions.length === 0) return sql<boolean>`true`;
  return sql<boolean>`${sql.join(screen.conditions.map(condition), sql` and `)}`;
}

export const RESULT_COLUMNS = [
  "security_id",
  "ticker",
  "name",
  "asset_class",
  "sector",
  "industry",
  "source",
  "as_of",
  "close",
  "change_1d",
  "return_1w",
  "return_1m",
  "return_3m",
  "return_6m",
  "return_ytd",
  "return_1y",
  "sma50",
  "sma200",
  "rsi14",
  "high_52w",
  "low_52w",
  "avg_volume_30d",
  "market_cap",
  "pe",
  "ps",
  "pb",
  "dividend_yield",
  "fundamentals_as_of",
] as const;

export type ResultRow = Record<(typeof RESULT_COLUMNS)[number], string | number | null>;

export async function runScreen(
  db: Database,
  screen: Screen,
  page: { limit: number; offset: number } = { limit: 50, offset: 0 },
): Promise<{ rows: ResultRow[]; total: number }> {
  const limit = Math.min(Math.max(1, Math.floor(page.limit)), 500);
  const offset = Math.max(0, Math.floor(page.offset));
  const dir = sql.raw(screen.sort.dir === "asc" ? "asc" : "desc");
  const [rows, total] = await Promise.all([
    sql<ResultRow>`
      select ${sql.join(RESULT_COLUMNS.map((c) => sql.ref(c)))}
      from market.screener_snapshot
      where ${where(screen)}
      order by ${expr(screen.sort.field)} ${dir} nulls last, ticker asc
      limit ${limit} offset ${offset}
    `.execute(db),
    sql<{ n: string }>`
      select count(*) as n from market.screener_snapshot where ${where(screen)}
    `.execute(db),
  ]);
  return { rows: rows.rows, total: Number(total.rows[0]?.n ?? 0) };
}
