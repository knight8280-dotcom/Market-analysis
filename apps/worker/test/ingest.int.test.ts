import { sql } from "@market/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harness, type Harness } from "./helpers/context";

let h: Harness;
const RANGE = { start: "2016-01-04", end: "2025-12-31", source: "synthetic" };

async function backfill() {
  await h.run("ingest-securities", { source: "synthetic" });
  const symbols = await h.t.db
    .selectFrom("market.provider_symbols")
    .select("source_symbol")
    .distinct()
    .where("source", "=", "synthetic")
    .execute();
  const totals = { inserted: 0, updated: 0, unchanged: 0, rejected: 0, flagged: 0 };
  for (const { source_symbol } of symbols) {
    const r = (await h.run("ingest-eod", { symbol: source_symbol, ...RANGE })) as Record<
      string,
      number
    >;
    totals.inserted += r.rows_inserted!;
    totals.updated += r.rows_updated!;
    totals.unchanged += r.rows_unchanged!;
    totals.rejected += r.rows_rejected!;
    totals.flagged += r.rows_flagged!;
  }
  await h.drain();
  return totals;
}

async function count(query: ReturnType<typeof sql<{ n: string }>>): Promise<number> {
  return Number((await query.execute(h.t.db)).rows[0]?.n ?? 0);
}

beforeAll(async () => {
  h = await harness({ universeSize: 20 });
});
afterAll(async () => {
  await h.t.drop();
});

describe("EOD ingestion (20 synthetic securities, 10 years)", () => {
  let first: Awaited<ReturnType<typeof backfill>>;

  it("loads every valid bar and rejects or flags the planted bad ones", async () => {
    first = await backfill();
    expect(first.inserted).toBeGreaterThan(20 * 2000);
    expect(first.rejected).toBe(4); // bad OHLC, negative volume, two conflicting copies
    expect(first.flagged).toBe(1); // the +60% jump
    const rules = await h.t.db
      .selectFrom("ops.data_quality_issues")
      .select(["rule", "action"])
      .orderBy("rule")
      .execute();
    expect(rules).toEqual([
      { rule: "action_not_adjusted", action: "skipped" },
      { rule: "conflicting_duplicate_bar", action: "rejected" },
      { rule: "large_move_without_action", action: "flagged" },
      { rule: "negative_volume", action: "rejected" },
      { rule: "ohlc_inconsistent", action: "rejected" },
    ]);
  });

  it("is idempotent: a second run inserts and changes nothing", async () => {
    const before = await count(sql`select count(*) as n from market.prices_daily`);
    const second = await backfill();
    expect(second).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: first.inserted,
      rejected: 4,
      flagged: 1,
    });
    expect(await count(sql`select count(*) as n from market.prices_daily`)).toBe(before);
    expect(
      await count(
        sql`select count(*) as n from (select 1 from market.prices_daily group by security_id, date, source having count(*) > 1) d`,
      ),
    ).toBe(0);
    expect(await count(sql`select count(*) as n from market.prices_daily_default`)).toBe(0);
    expect(await count(sql`select count(*) as n from ops.data_quality_issues`)).toBe(5);
    expect(await count(sql`select count(*) as n from ops.data_corrections`)).toBe(0);
  });

  it("attributes a reused ticker's bars to the right security by date", async () => {
    const rows = await sql<{ name: string; first: string; last: string }>`
      select s.name, min(p.date)::text as first, max(p.date)::text as last
      from market.prices_daily p join market.securities s using (security_id)
      where s.ticker = 'TEST_REUSE' group by s.name order by first
    `.execute(h.t.db);
    expect(rows.rows).toEqual([
      { name: "TEST_REUSE First Holder Corp", first: "2016-01-04", last: "2019-06-28" },
      { name: "TEST_REUSE Second Holder Corp", first: "2020-01-02", last: "2025-12-31" },
    ]);
  });

  it("produces split-adjusted series without touching raw prints", async () => {
    const rows = await sql<{ date: string; raw: string; adjusted: number; split_factor: number }>`
      select p.date::text, p.close::text as raw, a.close as adjusted, a.split_factor
      from market.prices_daily p
      join market.prices_daily_adjusted a using (security_id, date, source)
      join market.securities s using (security_id)
      where s.ticker = 'TEST_SPLIT4' and p.date in ('2020-08-28', '2020-08-31')
      order by p.date
    `.execute(h.t.db);
    const [before, on] = rows.rows;
    expect(before!.split_factor).toBe(0.25);
    expect(on!.split_factor).toBe(1);
    expect(before!.adjusted).toBeCloseTo(Number(before!.raw) * 0.25, 6);
    expect(Math.abs(on!.adjusted / before!.adjusted - 1)).toBeLessThan(0.2);
  });

  it("applies dividend factors from the raw prior close", async () => {
    const factors = await sql<{ n: string; min: number }>`
      select count(*) as n, min(dividend_factor) as min from market.adjustment_factors af
      join market.securities s using (security_id) where s.ticker = 'TEST_DIV'
    `.execute(h.t.db);
    expect(Number(factors.rows[0]!.n)).toBeGreaterThanOrEqual(39);
    expect(factors.rows[0]!.min).toBeGreaterThan(0.7);
    expect(factors.rows[0]!.min).toBeLessThan(1);
  });

  it("logs a vendor correction and restores the vendor's value", async () => {
    const target = await sql<{ security_id: string; close: string }>`
      select p.security_id, p.close::text from market.prices_daily p join market.securities s using (security_id)
      where s.ticker = 'TEST_S001' and p.date = '2024-03-01'
    `.execute(h.t.db);
    const { security_id, close } = target.rows[0]!;
    // Pretend we had stored a different print earlier.
    await sql`update market.prices_daily set close = close + 0.01, high = greatest(high, close + 0.01)
              where security_id = ${security_id} and date = '2024-03-01'`.execute(h.t.db);
    const r = (await h.run("ingest-eod", {
      symbol: "TEST_S001",
      start: "2024-02-26",
      end: "2024-03-01",
      source: "synthetic",
    })) as Record<string, number>;
    expect(r.rows_updated).toBe(1);
    const corr = await h.t.db.selectFrom("ops.data_corrections").selectAll().execute();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.date).toBe("2024-03-01");
    const restored = await sql<{
      close: string;
    }>`select close::text from market.prices_daily where security_id = ${security_id} and date = '2024-03-01'`.execute(
      h.t.db,
    );
    expect(restored.rows[0]!.close).toBe(close);
  });

  it("fans out EOD jobs only for securities listed that day", async () => {
    const r = (await h.run("schedule-eod", { date: "2019-08-01", source: "synthetic" })) as {
      jobs: number;
    };
    // 20 securities minus: the reused ticker's gap (neither holder listed), the IPO (2021).
    const symbols = h.dispatcher.size;
    expect(r.jobs).toBe(symbols);
    expect(r.jobs).toBe(19 - 2);
    const holiday = (await h.run("schedule-eod", { date: "2019-07-04", source: "synthetic" })) as {
      jobs: number;
    };
    expect(holiday.jobs).toBe(0);
    await h.drain();
  });

  it("records unmapped vendor symbols instead of guessing a security", async () => {
    await sql`delete from market.provider_symbols where source = 'synthetic' and source_symbol = 'TEST_S002'`.execute(
      h.t.db,
    );
    const r = (await h.run("ingest-eod", {
      symbol: "TEST_S002",
      start: "2024-01-02",
      end: "2024-01-05",
      source: "synthetic",
    })) as Record<string, number>;
    expect(r.rows_fetched).toBe(4);
    expect(r.rows_rejected).toBe(4);
    expect(r.rows_inserted).toBe(0);
    const issues = await h.t.db
      .selectFrom("ops.data_quality_issues")
      .select(["rule", "date"])
      .where("rule", "=", "unmapped_symbol")
      .orderBy("date")
      .execute();
    expect(issues.map((i) => i.date)).toEqual([
      "2024-01-02",
      "2024-01-03",
      "2024-01-04",
      "2024-01-05",
    ]);
  });

  it("writes one run record per ingest with its counts", async () => {
    const runs = await h.t.db
      .selectFrom("ops.data_ingestion_runs")
      .select(["status"])
      .where("job_name", "=", "ingest-eod")
      .execute();
    expect(runs.length).toBeGreaterThan(38);
    expect(runs.every((r) => r.status === "succeeded")).toBe(true);
  });
});
