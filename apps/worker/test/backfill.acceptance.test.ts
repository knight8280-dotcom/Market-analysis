import { sql } from "@market/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harness, type Harness } from "./helpers/context";

/**
 * Phase 0 acceptance: "10 years of daily bars for a 500-ticker test universe ingest
 * idempotently (re-running creates zero duplicates)" and "split fixtures produce correct
 * adjusted series". Runs the real job handlers against Postgres (~2-3 minutes).
 */
let h: Harness;

async function backfill() {
  await h.run("ingest-securities", { source: "synthetic" });
  const symbols = await h.t.db
    .selectFrom("market.provider_symbols")
    .select("source_symbol")
    .distinct()
    .execute();
  const totals = { symbols: symbols.length, fetched: 0, inserted: 0, updated: 0, unchanged: 0 };
  for (const { source_symbol } of symbols) {
    const r = (await h.run("ingest-eod", {
      symbol: source_symbol,
      start: "2016-01-04",
      end: "2025-12-31",
      source: "synthetic",
    })) as Record<string, number>;
    totals.fetched += r.rows_fetched!;
    totals.inserted += r.rows_inserted!;
    totals.updated += r.rows_updated!;
    totals.unchanged += r.rows_unchanged!;
  }
  await h.drain();
  return totals;
}

const scalar = async (q: ReturnType<typeof sql<{ n: string }>>) =>
  Number((await q.execute(h.t.db)).rows[0]?.n ?? 0);

beforeAll(async () => {
  h = await harness({ universeSize: 500 });
});
afterAll(async () => {
  await h.t.drop();
});

describe("Phase 0 acceptance: 500 tickers x 10 years", () => {
  it("ingests, then re-ingests with zero inserts, updates or duplicates", async () => {
    const first = await backfill();
    const rows = await scalar(sql`select count(*) as n from market.prices_daily`);
    expect(first.symbols).toBe(499); // 500 securities; two share the reused ticker
    expect(first.inserted).toBe(rows);
    expect(rows).toBeGreaterThan(1_250_000);

    const second = await backfill();
    expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: rows });
    expect(await scalar(sql`select count(*) as n from market.prices_daily`)).toBe(rows);
    expect(
      await scalar(
        sql`select count(*) as n from (select 1 from market.prices_daily group by security_id, date, source having count(*) > 1) d`,
      ),
    ).toBe(0);
    expect(await scalar(sql`select count(*) as n from market.prices_daily_default`)).toBe(0);
    expect(await scalar(sql`select count(*) as n from market.securities`)).toBe(500);
    expect(await scalar(sql`select count(*) as n from ops.data_corrections`)).toBe(0);
  });

  it("adjusts 4:1, 20:1 and 1:10 splits correctly", async () => {
    for (const [ticker, before, exDate, factor] of [
      ["TEST_SPLIT4", "2020-08-28", "2020-08-31", 0.25],
      ["TEST_SPLIT20", "2022-07-15", "2022-07-18", 0.05],
      ["TEST_RSPLIT", "2023-05-12", "2023-05-15", 10],
    ] as const) {
      const r = await sql<{
        date: string;
        raw: string;
        adj: number;
        split_factor: number;
        volume: number;
        raw_volume: string;
      }>`
        select p.date::text, p.close::text as raw, a.close as adj, a.split_factor, a.volume, p.volume::text as raw_volume
        from market.prices_daily p
        join market.prices_daily_adjusted a using (security_id, date, source)
        join market.securities s using (security_id)
        where s.ticker = ${ticker} and p.date in (${before}::date, ${exDate}::date)
        order by p.date
      `.execute(h.t.db);
      const [b, e] = r.rows;
      expect(b!.split_factor).toBeCloseTo(factor, 12);
      expect(b!.adj).toBeCloseTo(Number(b!.raw) * factor, 6);
      expect(b!.volume).toBeCloseTo(Number(b!.raw_volume) / factor, 3);
      expect(e!.split_factor).toBe(1);
      expect(e!.adj).toBeCloseTo(Number(e!.raw), 6);
      // Across the ex-date the adjusted series moves like a normal day; raw jumps by the ratio.
      expect(Math.abs(e!.adj / b!.adj - 1)).toBeLessThan(0.2);
    }
  });
});
