import { sql } from "@market/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harness, type Harness } from "./helpers/context";

/** The screener snapshot job (Phase 1 step F1) on 20 synthetic securities. */
let h: Harness;
const RANGE = { start: "2024-06-03", end: "2025-12-31", source: "synthetic" };

beforeAll(async () => {
  h = await harness({ universeSize: 20, now: "2026-01-02T12:00:00Z" });
  await h.run("ingest-securities", { source: "synthetic" });
  const symbols = await h.t.db
    .selectFrom("market.provider_symbols")
    .select("source_symbol")
    .distinct()
    .where("source", "=", "synthetic")
    .execute();
  for (const { source_symbol } of symbols) {
    await h.run("ingest-eod", { symbol: source_symbol, ...RANGE });
  }
  await h.drain(); // adjustment factors
});
afterAll(async () => {
  await h.t.drop();
});

describe("refresh-screener", () => {
  it("has one row per security that traded in the last 30 days", async () => {
    const result = (await h.run("refresh-screener")) as { asOf: string; securities: number };
    expect(result.asOf).toBe("2025-12-31");
    const expected = await sql<{ n: string }>`
      select count(distinct p.security_id) as n
      from market.prices_daily p join market.securities s using (security_id)
      where s.is_active and p.source = 'synthetic' and p.date >= '2025-12-01'
    `.execute(h.t.db);
    expect(result.securities).toBe(Number(expected.rows[0]!.n));
    const delisted = await h.t.db
      .selectFrom("market.screener_snapshot")
      .select("ticker")
      .where("ticker", "=", "TEST_DELIST")
      .execute();
    expect(delisted).toEqual([]);
  });

  it("measures returns on adjusted closes, so splits are not crashes", async () => {
    const row = await h.t.db
      .selectFrom("market.screener_snapshot")
      .selectAll()
      .where("ticker", "=", "TEST_SPLIT4")
      .executeTakeFirstOrThrow();
    const ref = await sql<{ first: number; last: number }>`
      select
        (select a.close from market.prices_daily_adjusted a
          where a.security_id = ${row.security_id} and a.source = 'synthetic' and a.date <= '2024-12-31'
          order by a.date desc limit 1) as first,
        (select a.close from market.prices_daily_adjusted a
          where a.security_id = ${row.security_id} and a.source = 'synthetic'
          order by a.date desc limit 1) as last
    `.execute(h.t.db);
    const { first, last } = ref.rows[0]!;
    expect(row.return_1y).toBeCloseTo(last / first - 1, 10);
    expect(row.return_1y!).toBeGreaterThan(-0.6); // a 4:1 split unadjusted would be about -75%
    expect(row.sma200).not.toBeNull();
    expect(row.rsi14).not.toBeNull();
    expect(row.market_cap).toBeNull(); // synthetic securities have no SEC filings
  });

  it("computes a trailing dividend yield from split-adjusted dividends", async () => {
    const row = await h.t.db
      .selectFrom("market.screener_snapshot")
      .select(["dividend_yield", "close"])
      .where("ticker", "=", "TEST_DIV")
      .executeTakeFirstOrThrow();
    expect(row.dividend_yield).toBeGreaterThan(0);
    expect(row.dividend_yield).toBeLessThan(0.1);
  });

  it("rebuilds idempotently", async () => {
    const before = await h.t.db
      .selectFrom("market.screener_snapshot")
      .selectAll()
      .orderBy("security_id")
      .execute();
    await h.run("refresh-screener");
    const after = await h.t.db
      .selectFrom("market.screener_snapshot")
      .selectAll()
      .orderBy("security_id")
      .execute();
    const strip = (rows: typeof before) => rows.map(({ refreshed_at: _, ...r }) => r);
    expect(strip(after)).toEqual(strip(before));
  });
});
