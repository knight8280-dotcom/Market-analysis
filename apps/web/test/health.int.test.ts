import { sql } from "@market/db";
import { createTestDatabase, type TestDatabase } from "@market/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDataHealth } from "../src/server/health";
import { TEMPLATE } from "./global-setup";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase(TEMPLATE);
  await sql`
    with s as (
      insert into market.securities (ticker, name, asset_class, listed_at)
      values ('TEST_WEB', 'Web test', 'equity', '2020-01-02') returning security_id
    ), ps as (
      insert into market.provider_symbols (security_id, source, source_symbol, valid_from)
      select security_id, 'synthetic', 'TEST_WEB', '2020-01-02' from s
    )
    insert into market.prices_daily (security_id, date, source, open, high, low, close, volume)
    select security_id, '2026-09-29', 'synthetic', 123.45, 124.56, 122.34, 123.99, 987654 from s
  `.execute(t.db);
  await sql`insert into ops.alerts (kind, dataset, severity, message) values ('staleness', 'daily_bars', 'critical', 'stale!')`.execute(
    t.db,
  );
  await sql`insert into ops.data_ingestion_runs (job_name, dataset, source, status, finished_at) values ('ingest-eod', 'daily_bars', 'synthetic', 'succeeded', now())`.execute(
    t.db,
  );
});
afterAll(async () => {
  await t.drop();
});

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k.toLowerCase());
      keysDeep(v, out);
    }
  }
  return out;
}

describe("getDataHealth", () => {
  it("reports counts, dates, alerts and runs", async () => {
    const h = await getDataHealth(t.db, new Date("2026-09-30T12:00:00Z"));
    expect(h.hasSyntheticData).toBe(true);
    expect(h.totals).toMatchObject({
      securities: 1,
      latestBarDate: "2026-09-29",
      securitiesWithLatestBar: 1,
      defaultPartitionRows: 0,
    });
    expect(h.openAlerts).toMatchObject([
      { kind: "staleness", severity: "critical", message: "stale!" },
    ]);
    expect(h.lastRuns).toMatchObject([{ dataset: "daily_bars", lastStatus: "succeeded" }]);
  });

  it("never returns prices, volumes or other market values", async () => {
    const h = await getDataHealth(t.db);
    const keys = keysDeep(h);
    for (const forbidden of ["open", "high", "low", "close", "volume", "vwap", "value", "price"]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    const text = JSON.stringify(h);
    for (const stored of ["123.45", "124.56", "122.34", "123.99", "987654"])
      expect(text).not.toContain(stored);
  });
});
