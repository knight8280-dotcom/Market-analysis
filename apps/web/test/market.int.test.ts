import { sql } from "@market/db";
import { createTestDatabase, type TestDatabase } from "@market/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertDisplayable,
  findSecurity,
  lastUpdated,
  latestQuotes,
  movers,
  priceSource,
  searchSecurities,
  staleDatasets,
} from "../src/server/market";
import { TEMPLATE } from "./global-setup";

let t: TestDatabase;

async function security(
  ticker: string,
  opts: {
    name?: string;
    source?: string;
    active?: boolean;
    delisted?: string;
    validFrom?: string;
  } = {},
): Promise<string> {
  const row = await sql<{ security_id: string }>`
    insert into market.securities (ticker, name, asset_class, is_active, delisted_at)
    values (${ticker}, ${opts.name ?? `${ticker} Test Co`}, 'equity', ${opts.active ?? true},
      ${opts.delisted ?? null})
    returning security_id
  `.execute(t.db);
  const id = row.rows[0]!.security_id;
  await sql`
    insert into market.provider_symbols (security_id, source, source_symbol, valid_from, valid_to)
    values (${id}, ${opts.source ?? "synthetic"}, ${ticker}, ${opts.validFrom ?? "2020-01-02"},
      ${opts.delisted ?? null})
  `.execute(t.db);
  return id;
}

async function bar(id: string, date: string, close: number, source = "synthetic") {
  await sql`
    insert into market.prices_daily (security_id, date, source, open, high, low, close, volume)
    values (${id}, ${date}, ${source}, ${close}, ${close}, ${close}, ${close}, 1000)
  `.execute(t.db);
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDatabase(TEMPLATE);
  ids.UP = await security("TEST_UP", { name: "Rising Test Co" });
  ids.DOWN = await security("TEST_DOWN");
  ids.SPLIT = await security("TEST_SPLIT");
  ids.OLD = await security("TEST_OLD");
  ids.UNDERSCORE = await security("TESTXUP"); // must not match "TEST_UP" via LIKE's "_"
  ids.OTHER = await security("OTHER_SRC", { source: "tiingo" });
  ids.REUSED_OLD = await security("TEST_REUSE", {
    name: "Old Reuse Co",
    active: false,
    delisted: "2021-03-31",
  });
  ids.REUSED_NEW = await security("TEST_REUSE", { name: "New Reuse Co", validFrom: "2021-06-01" });

  await bar(ids.UP, "2026-09-28", 100);
  await bar(ids.UP, "2026-09-29", 105);
  await bar(ids.DOWN, "2026-09-28", 50);
  await bar(ids.DOWN, "2026-09-29", 45);
  // 4:1 split effective 2026-09-29: 200 → 51 is a 2% gain, not a 74.5% fall.
  await bar(ids.SPLIT, "2026-09-28", 200);
  await bar(ids.SPLIT, "2026-09-29", 51);
  await sql`
    insert into market.adjustment_factors (security_id, ex_date, split_factor, dividend_factor)
    values (${ids.SPLIT}, '2026-09-29', 0.25, 1)
  `.execute(t.db);
  // Stopped trading before the latest session.
  await bar(ids.OLD, "2026-09-25", 10);
  await bar(ids.OLD, "2026-09-28", 11);
  await bar(ids.OTHER, "2026-09-29", 1, "tiingo");
  await sql`
    insert into ops.data_ingestion_runs (job_name, dataset, source, status, finished_at)
    values ('ingest-eod', 'daily_bars', 'synthetic', 'succeeded', '2026-09-29T20:31:00Z')
  `.execute(t.db);
});
afterAll(async () => {
  await t.drop();
});

describe("price source and freshness", () => {
  it("uses the active daily_bars route, else the source of the newest bar", async () => {
    // Both sources have bars on 2026-09-29: real data wins the tie.
    expect(await priceSource(t.db)).toBe("tiingo");
    await sql`
      insert into ops.dataset_routing (dataset, primary_source, active_source)
      values ('daily_bars', 'synthetic', 'synthetic')
    `.execute(t.db);
    expect(await priceSource(t.db)).toBe("synthetic");
  });

  it("reports the latest session and the last successful load", async () => {
    const u = await lastUpdated(t.db, "synthetic");
    expect(u.session).toBe("2026-09-29");
    expect(u.loadedAt?.toISOString()).toBe("2026-09-29T20:31:00.000Z");
  });

  it("lists open staleness alerts only", async () => {
    await sql`
      insert into ops.alerts (kind, dataset, severity, message, resolved_at) values
        ('staleness', 'daily_bars', 'critical', 'late', null),
        ('staleness', 'macro', 'warning', 'was late', now()),
        ('failover', 'daily_bars', 'critical', 'moved', null)
    `.execute(t.db);
    expect((await staleDatasets(t.db)).map((s) => s.dataset)).toEqual(["daily_bars"]);
  });
});

describe("searchSecurities", () => {
  it("ranks the exact ticker first and treats LIKE wildcards literally", async () => {
    const r = await searchSecurities(t.db, "synthetic", "test_up");
    expect(r.map((x) => x.ticker)).toEqual(["TEST_UP"]);
  });

  it("matches company names and only offers the price source's securities", async () => {
    expect((await searchSecurities(t.db, "synthetic", "rising")).map((x) => x.ticker)).toEqual([
      "TEST_UP",
    ]);
    expect(await searchSecurities(t.db, "synthetic", "OTHER")).toEqual([]);
    expect(await searchSecurities(t.db, "synthetic", "   ")).toEqual([]);
  });

  it("puts an active listing ahead of a delisted one with the same ticker", async () => {
    const r = await searchSecurities(t.db, "synthetic", "TEST_REUSE");
    expect(r.map((x) => [x.name, x.active])).toEqual([
      ["New Reuse Co", true],
      ["Old Reuse Co", false],
    ]);
  });
});

describe("quotes", () => {
  it("computes the change against a split-adjusted previous close", async () => {
    const [q] = await latestQuotes(t.db, "synthetic", { securityIds: [ids.SPLIT!] });
    expect(q!.close).toBe(51);
    expect(q!.change).toBeCloseTo(0.02, 10);
  });

  it("keeps each security's own latest date", async () => {
    const [q] = await latestQuotes(t.db, "synthetic", { tickers: ["TEST_OLD"] });
    expect(q!.date).toBe("2026-09-28");
    expect(q!.change).toBeCloseTo(0.1, 10);
  });

  it("ranks movers of the session, leaving out securities that did not trade", async () => {
    const m = await movers(t.db, "synthetic", "2026-09-29");
    expect(m.gainers.map((q) => q.ticker)).toEqual(["TEST_UP", "TEST_SPLIT"]);
    expect(m.losers.map((q) => q.ticker)).toEqual(["TEST_DOWN"]);
  });
});

describe("findSecurity", () => {
  it("resolves a reused ticker to the active listing", async () => {
    expect((await findSecurity(t.db, "TEST_REUSE"))?.name).toBe("New Reuse Co");
    expect(await findSecurity(t.db, "NOPE")).toBeNull();
  });
});

describe("assertDisplayable", () => {
  it("lets the owner see personal-plan data and refuses what the license forbids", () => {
    expect(() => assertDisplayable("tiingo", "daily_bars", "production")).not.toThrow();
    expect(() => assertDisplayable("synthetic", "daily_bars", "local")).not.toThrow();
    expect(() => assertDisplayable("synthetic", "daily_bars", "production")).toThrow();
    expect(() => assertDisplayable("twelvedata", "daily_bars", "local")).toThrow();
  });
});
