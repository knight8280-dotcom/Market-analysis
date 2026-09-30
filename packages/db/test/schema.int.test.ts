import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing";
import { TEMPLATE } from "./global-setup";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase(TEMPLATE);
});
afterAll(async () => {
  await t.drop();
});

async function security(ticker: string): Promise<string> {
  const { rows } = await t.pool.query<{ security_id: string }>(
    "insert into market.securities (ticker, name, asset_class) values ($1, $1, 'equity') returning security_id",
    [ticker],
  );
  return rows[0]!.security_id;
}

async function bar(
  securityId: string,
  date: string,
  ohlcv: [number, number, number, number, number],
) {
  const [open, high, low, close, volume] = ohlcv;
  await t.pool.query(
    `insert into market.prices_daily (security_id, date, source, open, high, low, close, volume)
     values ($1, $2, 'synthetic', $3, $4, $5, $6, $7)`,
    [securityId, date, open, high, low, close, volume],
  );
}

async function partitionOf(securityId: string, date: string): Promise<string> {
  const { rows } = await t.pool.query<{ part: string }>(
    "select tableoid::regclass::text as part from market.prices_daily where security_id = $1 and date = $2",
    [securityId, date],
  );
  return rows[0]!.part;
}

describe("security_symbol_history", () => {
  it("rejects one ticker pointing at two securities at the same time", async () => {
    const a = await security("TEST_OVL_A");
    const b = await security("TEST_OVL_B");
    await t.pool.query(
      "insert into market.security_symbol_history values ($1, 'TEST_SAME', '2020-01-01', '2021-01-01')",
      [a],
    );
    await expect(
      t.pool.query(
        "insert into market.security_symbol_history values ($1, 'TEST_SAME', '2020-06-01', null)",
        [b],
      ),
    ).rejects.toThrow(/security_symbol_history_no_overlap/);
  });

  it("allows a ticker to be reused after the earlier security gave it up", async () => {
    const a = await security("TEST_REUSE_A");
    const b = await security("TEST_REUSE_B");
    await t.pool.query(
      "insert into market.security_symbol_history values ($1, 'TEST_REUSED', '2016-01-01', '2019-07-01')",
      [a],
    );
    // valid_to is exclusive, so the new holder may start on the same day.
    await t.pool.query(
      "insert into market.security_symbol_history values ($1, 'TEST_REUSED', '2019-07-01', null)",
      [b],
    );
  });

  it("rejects an empty or inverted validity range", async () => {
    const a = await security("TEST_RANGE");
    await expect(
      t.pool.query(
        "insert into market.security_symbol_history values ($1, 'TEST_RANGE', '2020-01-01', '2020-01-01')",
        [a],
      ),
    ).rejects.toThrow(/security_symbol_history_range/);
  });
});

describe("provider_symbols", () => {
  it("rejects overlapping mappings of one vendor symbol", async () => {
    const a = await security("TEST_PS_A");
    const b = await security("TEST_PS_B");
    await t.pool.query(
      "insert into market.provider_symbols (security_id, source, source_symbol, valid_from) values ($1, 'synthetic', 'TEST_PS', '2020-01-01')",
      [a],
    );
    await expect(
      t.pool.query(
        "insert into market.provider_symbols (security_id, source, source_symbol, valid_from) values ($1, 'synthetic', 'TEST_PS', '2021-01-01')",
        [b],
      ),
    ).rejects.toThrow(/provider_symbols_no_overlap/);
  });

  it("rejects unknown data sources", async () => {
    const a = await security("TEST_PS_SRC");
    await expect(
      t.pool.query(
        "insert into market.provider_symbols (security_id, source, source_symbol, valid_from) values ($1, 'made_up', 'X', '2020-01-01')",
        [a],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("prices_daily partitioning", () => {
  it("routes bars to yearly, pre-2000 and default partitions", async () => {
    const s = await security("TEST_PART");
    await bar(s, "2024-03-01", [10, 11, 9, 10.5, 1000]);
    await bar(s, "1998-06-01", [10, 11, 9, 10.5, 1000]);
    await bar(s, "2035-01-02", [10, 11, 9, 10.5, 1000]);
    expect(await partitionOf(s, "2024-03-01")).toBe("market.prices_daily_y2024");
    expect(await partitionOf(s, "1998-06-01")).toBe("market.prices_daily_pre2000");
    expect(await partitionOf(s, "2035-01-02")).toBe("market.prices_daily_default");

    // A year whose rows sit in DEFAULT cannot get its partition until they are moved (RUNBOOK).
    await expect(t.pool.query("select market.ensure_prices_daily_partition(2035)")).rejects.toThrow(
      /would be violated by some row|updated partition constraint/,
    );
    await t.pool.query("delete from market.prices_daily where date = '2035-01-02'");
    const { rows } = await t.pool.query<{ part: string }>(
      "select market.ensure_prices_daily_partition(2035) as part",
    );
    expect(rows[0]!.part).toBe("prices_daily_y2035");
    const rls = await t.pool.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'market.prices_daily_y2035'::regclass",
    );
    expect(rls.rows[0]!.relrowsecurity).toBe(true);
    // Idempotent.
    await t.pool.query("select market.ensure_prices_daily_partition(2035)");
  });

  it("prunes partitions for a date-bounded query", async () => {
    const { rows } = await t.pool.query<{ "QUERY PLAN": unknown }>(
      "explain (format json) select * from market.prices_daily where date >= '2024-01-01' and date < '2025-01-01'",
    );
    const plan = JSON.stringify(rows[0]!["QUERY PLAN"]);
    expect(plan).toContain("prices_daily_y2024");
    expect(plan).not.toContain("prices_daily_y2023");
    expect(plan).not.toContain("prices_daily_default");
  });

  it("enforces OHLC consistency, positive prices and non-negative volume", async () => {
    const s = await security("TEST_CHECKS");
    await expect(bar(s, "2024-01-02", [10, 9.5, 9, 10, 100])).rejects.toThrow(/prices_daily_ohlc/);
    await expect(bar(s, "2024-01-03", [10, 11, 9, 10, -1])).rejects.toThrow(/prices_daily_volume/);
    await expect(bar(s, "2024-01-04", [0, 11, 0, 10, 1])).rejects.toThrow(/prices_daily_positive/);
  });

  it("rejects a duplicate bar for the same security, date and source", async () => {
    const s = await security("TEST_DUP");
    await bar(s, "2024-01-02", [10, 11, 9, 10, 100]);
    await expect(bar(s, "2024-01-02", [10, 11, 9, 10, 100])).rejects.toThrow(
      /prices_daily_y2024_pkey/,
    );
  });
});

describe("prices_daily_adjusted", () => {
  it("applies cumulative factors only to bars before each ex-date", async () => {
    const s = await security("TEST_ADJ");
    await bar(s, "2020-08-27", [400, 404, 396, 400, 1000]);
    await bar(s, "2020-08-28", [400, 404, 396, 400, 1000]);
    await bar(s, "2020-08-31", [100, 101, 99, 100, 4000]);
    // One 4:1 split with ex-date 2020-08-31, plus a dividend worth 1% earlier.
    await t.pool.query(
      "insert into market.adjustment_factors (security_id, ex_date, split_factor, dividend_factor) values ($1, '2020-08-31', 0.25, 1), ($1, '2020-08-28', 0.25, 0.99)",
      [s],
    );
    const { rows } = await t.pool.query<{ date: string; close: number; volume: number }>(
      "select date, close, volume from market.prices_daily_adjusted where security_id = $1 order by date",
      [s],
    );
    expect(rows).toEqual([
      { date: "2020-08-27", close: 400 * 0.25 * 0.99, volume: 4000 },
      { date: "2020-08-28", close: 100, volume: 4000 },
      { date: "2020-08-31", close: 100, volume: 4000 },
    ]);
    const raw = await t.pool.query<{ close: string }>(
      "select close from market.prices_daily where security_id = $1 and date = '2020-08-27'",
      [s],
    );
    expect(raw.rows[0]!.close).toBe("400.000000");
  });
});

describe("fundamentals_facts", () => {
  it("treats instant facts (no period_start) from one filing as duplicates", async () => {
    const insert = () =>
      t.pool.query(
        `insert into market.fundamentals_facts
          (cik, taxonomy, concept, unit, value, period_start, period_end, form, filed_at, accession_no, source)
         values ('0000000001', 'us-gaap', 'Assets', 'USD', 100, null, '2024-12-31', '10-K', '2025-02-01', '0000000001-25-000001', 'sec_edgar')`,
      );
    await insert();
    await expect(insert()).rejects.toThrow(/fundamentals_facts_key/);
  });
});

describe("ops.alerts", () => {
  it("allows one open alert per kind, dataset and source", async () => {
    const open = () =>
      t.pool.query(
        "insert into ops.alerts (kind, dataset, source, severity, message) values ('staleness', 'daily_bars', null, 'critical', 'stale')",
      );
    await open();
    await expect(open()).rejects.toThrow(/alerts_one_open/);
    await t.pool.query("update ops.alerts set resolved_at = now() where dataset = 'daily_bars'");
    await open();
  });
});

describe("ops.data_quality_issues", () => {
  it("keeps one open issue per bar and rule", async () => {
    const s = await security("TEST_DQ");
    const flag = () =>
      t.pool.query(
        `insert into ops.data_quality_issues (dataset, source, security_id, date, rule, severity, action, message)
         values ('daily_bars', 'synthetic', $1, '2024-01-02', 'large_move_without_action', 'warning', 'flagged', 'm')
         on conflict (dataset, source, security_id, date, rule) where status = 'open' do nothing`,
        [s],
      );
    await flag();
    await flag();
    const { rows } = await t.pool.query<{ n: string }>(
      "select count(*) as n from ops.data_quality_issues where security_id = $1",
      [s],
    );
    expect(rows[0]!.n).toBe("1");
  });
});
