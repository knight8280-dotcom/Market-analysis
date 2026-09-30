import { sql } from "@market/db";
import { FinnhubProvider } from "@market/market-data/adapters/finnhub";
import { FredProvider } from "@market/market-data/adapters/fred";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harness, type Harness } from "./helpers/context";

/** Earnings (Finnhub) and economic release (FRED) ingestion, with made-up payloads. */
let payload: { earnings: unknown; releases: unknown };

function fetchImpl(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  const body = url.pathname.endsWith("/calendar/earnings") ? payload.earnings : payload.releases;
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

const NOW = () => new Date("2026-09-30T12:00:00Z");
const earnings = (rows: [string, string, number | null][]) => ({
  earningsCalendar: rows.map(([symbol, date, eps]) => ({
    symbol,
    date,
    hour: "amc",
    quarter: 3,
    year: 2026,
    epsEstimate: eps,
    epsActual: null,
    revenueEstimate: null,
    revenueActual: null,
  })),
});
const releases = (rows: [number, string, string][]) => ({
  count: rows.length,
  offset: 0,
  limit: 1000,
  release_dates: rows.map(([release_id, release_name, date]) => ({
    release_id,
    release_name,
    date,
  })),
});

let h: Harness;

beforeAll(async () => {
  h = await harness({
    universeSize: 20,
    now: NOW().toISOString(),
    extraProviders: [
      new FinnhubProvider({
        apiKey: "test-key",
        baseUrl: "https://finnhub.test",
        fetch: fetchImpl,
        now: NOW,
      }),
      new FredProvider({
        apiKey: "test-key",
        baseUrl: "https://fred.test",
        fetch: fetchImpl,
        now: NOW,
      }),
    ],
  });
  await h.run("ingest-securities", { source: "synthetic" });
  // One real-vendor equity; synthetic ones must never match a vendor's events.
  await sql`
    with s as (
      insert into market.securities (ticker, name, asset_class) values ('TESTX', 'Test X', 'equity')
      returning security_id
    )
    insert into market.provider_symbols (security_id, source, source_symbol, valid_from)
    select security_id, 'tiingo', 'TESTX', '2020-01-02' from s
  `.execute(h.t.db);
});
afterAll(async () => {
  await h.t.drop();
});

const rows = () =>
  sql<{ ticker: string; report_date: string; eps_estimate: string | null }>`
    select s.ticker, e.report_date, e.eps_estimate from market.earnings_events e
    join market.securities s using (security_id) order by e.report_date
  `
    .execute(h.t.db)
    .then((r) => r.rows);

describe("ingest-earnings", () => {
  it("stores events for universe equities only, never for synthetic ones", async () => {
    payload = {
      earnings: earnings([
        ["TESTX", "2026-10-20", 1.25],
        ["TEST_DIV", "2026-10-21", 0.5],
        ["ELSEWHERE", "2026-10-22", 2],
      ]),
      releases: releases([]),
    };
    const result = (await h.run("ingest-earnings")) as { fetched: number; matched: number };
    expect(result).toMatchObject({ fetched: 3, matched: 1 });
    expect(await rows()).toEqual([
      { ticker: "TESTX", report_date: "2026-10-20", eps_estimate: "1.25" },
    ]);
  });

  it("moves a rescheduled date and keeps past events", async () => {
    await sql`
      insert into market.earnings_events (security_id, source, report_date, eps_actual, fetched_at)
      select security_id, 'finnhub', '2026-07-21', 1.1, now() from market.securities where ticker = 'TESTX'
    `.execute(h.t.db);
    payload.earnings = earnings([["TESTX", "2026-10-27", 1.3]]);
    const result = (await h.run("ingest-earnings")) as { removed: number };
    expect(result.removed).toBe(1);
    expect((await rows()).map((r) => r.report_date)).toEqual(["2026-07-21", "2026-10-27"]);
  });
});

describe("ingest-releases", () => {
  it("upserts release dates and drops moved future ones", async () => {
    payload.releases = releases([
      [50, "Employment Situation", "2026-10-02"],
      [10, "Consumer Price Index", "2026-10-14"],
    ]);
    await h.run("ingest-releases");
    payload.releases = releases([
      [50, "Employment Situation", "2026-10-09"],
      [10, "Consumer Price Index", "2026-10-14"],
    ]);
    const result = (await h.run("ingest-releases")) as { releases: number; removed: number };
    expect(result).toMatchObject({ releases: 2, removed: 1 });
    const stored = await sql<{ release_id: number; release_date: string }>`
      select release_id, release_date from market.economic_releases order by release_date
    `.execute(h.t.db);
    expect(stored.rows).toEqual([
      { release_id: 50, release_date: "2026-10-09" },
      { release_id: 10, release_date: "2026-10-14" },
    ]);
  });
});
