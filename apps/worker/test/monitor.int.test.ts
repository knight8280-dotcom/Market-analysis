import { sql } from "@market/db";
import { afterEach, describe, expect, it } from "vitest";
import { harness, StubPrimary, type Harness } from "./helpers/context";

/**
 * Phase 0 acceptance: "staleness alerts fire in a simulated outage". The primary price provider
 * (a stub standing in for Tiingo) goes down on 2026-09-29; the clock is 18:31 ET, one minute
 * past the EOD freshness deadline.
 */
const AFTER_DEADLINE = "2026-09-29T22:31:00Z"; // 18:31 EDT
const BEFORE_DEADLINE = "2026-09-29T22:29:00Z"; // 18:29 EDT

let h: Harness | undefined;
afterEach(async () => {
  await h?.t.drop();
  h = undefined;
});

/** 10 securities, of which 8 are listed on 2026-09-29 (TEST_DELIST and the first TEST_REUSE holder are gone). */
async function setup(fallback: "synthetic" | null) {
  const synthetic = new (await import("@market/market-data/adapters/synthetic")).SyntheticProvider({
    universeSize: 10,
    now: () => new Date(AFTER_DEADLINE),
  });
  const primary = new StubPrimary(synthetic);
  h = await harness({
    universeSize: 10,
    now: BEFORE_DEADLINE,
    primary: "tiingo",
    fallback,
    extraProviders: [primary],
  });
  // Securities and history up to the day before the outage come from the synthetic source.
  await h.run("ingest-securities", { source: "synthetic" });
  const symbols = await h.t.db
    .selectFrom("market.provider_symbols")
    .select("source_symbol")
    .distinct()
    .execute();
  for (const { source_symbol } of symbols) {
    await h.run("ingest-eod", {
      symbol: source_symbol,
      start: "2026-09-21",
      end: "2026-09-28",
      source: "synthetic",
    });
  }
  await h.drain();
  return { h, primary };
}

const openAlerts = (h: Harness) =>
  h.t.db
    .selectFrom("ops.alerts")
    .select(["kind", "dataset", "source", "severity", "message"])
    .where("resolved_at", "is", null)
    .orderBy("kind")
    .execute();
const route = (h: Harness) =>
  h.t.db
    .selectFrom("ops.dataset_routing")
    .selectAll()
    .where("dataset", "=", "daily_bars")
    .executeTakeFirstOrThrow();

describe("simulated outage", () => {
  it("fires a staleness alert, fails over, backfills from the fallback, then fails back", async () => {
    const { h, primary } = await setup("synthetic");

    // One failed fetch from the primary is below the failover threshold.
    await expect(
      h.run("ingest-eod", { symbol: "TEST_SPLIT4", start: "2026-09-29", end: "2026-09-29" }),
    ).rejects.toThrow(/503/);
    expect((await route(h)).active_source).toBe("tiingo");

    // Before the 18:30 deadline nothing is stale yet.
    await h.run("staleness-monitor");
    expect(await openAlerts(h)).toEqual([]);

    // 18:31 ET: the monitor sees no bars for 2026-09-29.
    h.setNow(AFTER_DEADLINE);
    await h.run("staleness-monitor");
    const alerts = await openAlerts(h);
    expect(alerts).toMatchObject([
      { kind: "failover", dataset: "daily_bars", source: "tiingo", severity: "critical" },
      { kind: "staleness", dataset: "daily_bars", severity: "critical" },
    ]);
    expect(alerts[1]!.message).toMatch(/EOD bars for 2026-09-29 missing: 0\/8/);
    expect(h.events.map((e) => e.type)).toEqual(["alert_opened", "provider_failover"]);
    expect(h.events[1]).toMatchObject({ dataset: "daily_bars", from: "tiingo", to: "synthetic" });
    expect(await route(h)).toMatchObject({ active_source: "synthetic", primary_source: "tiingo" });

    // The monitor asked the fallback for the missing session; run those jobs.
    const drained = await h.drain();
    expect(drained.failed).toBe(0);
    const loaded = await sql<{
      n: string;
    }>`select count(distinct security_id) as n from market.prices_daily where date = '2026-09-29'`.execute(
      h.t.db,
    );
    expect(Number(loaded.rows[0]!.n)).toBe(8);
    const sources = await sql<{
      source: string;
    }>`select distinct source from market.prices_daily where date = '2026-09-29'`.execute(h.t.db);
    expect(sources.rows).toEqual([{ source: "synthetic" }]);

    // Data is fresh again: the staleness alert resolves; the failover alert stays until failback.
    await h.run("staleness-monitor");
    expect((await openAlerts(h)).map((a) => a.kind)).toEqual(["failover"]);
    expect(h.events.map((e) => e.type)).toContain("alert_resolved");

    // Primary recovers: three healthy probes fail back.
    primary.failing = false;
    await h.run("staleness-monitor");
    await h.run("staleness-monitor");
    expect((await route(h)).active_source).toBe("synthetic");
    await h.run("staleness-monitor");
    expect((await route(h)).active_source).toBe("tiingo");
    expect(await openAlerts(h)).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({
      type: "provider_failback",
      dataset: "daily_bars",
      from: "synthetic",
      to: "tiingo",
    });
    const failback = await h.t.db
      .selectFrom("ops.alerts")
      .select(["kind", "resolved_at"])
      .where("kind", "=", "failback")
      .execute();
    expect(failback).toHaveLength(1);
  });

  it("fails over after three consecutive primary failures, before any SLO breach", async () => {
    const { h } = await setup("synthetic");
    for (let i = 0; i < 3; i += 1) {
      await expect(
        h.run("ingest-eod", { symbol: "TEST_SPLIT4", start: "2026-09-29", end: "2026-09-29" }),
      ).rejects.toThrow();
    }
    expect((await route(h)).active_source).toBe("synthetic");
    expect(h.events).toMatchObject([
      {
        type: "provider_failover",
        reason: expect.stringMatching(/3 consecutive failures/) as unknown,
      },
    ]);
    const health = await h.t.db
      .selectFrom("ops.provider_health")
      .selectAll()
      .where("source", "=", "tiingo")
      .executeTakeFirstOrThrow();
    expect(health).toMatchObject({ consecutive_failures: 3, dataset: "daily_bars" });
    // The retried job now succeeds through the fallback.
    const r = (await h.run("ingest-eod", {
      symbol: "TEST_SPLIT4",
      start: "2026-09-29",
      end: "2026-09-29",
    })) as { source: string; rows_inserted: number };
    expect(r).toMatchObject({ source: "synthetic", rows_inserted: 1 });
  });

  it("with no fallback: staleness only alerts; repeated failures serve last-good data", async () => {
    const { h } = await setup(null);
    h.setNow(AFTER_DEADLINE);
    await h.run("staleness-monitor");
    // Nowhere to fail over to: the route stays, the staleness alert says what is wrong.
    expect(await route(h)).toMatchObject({ active_source: "tiingo" });
    expect((await openAlerts(h)).map((a) => a.kind)).toEqual(["staleness"]);

    for (let i = 0; i < 3; i += 1) {
      await expect(
        h.run("ingest-eod", { symbol: "TEST_SPLIT4", start: "2026-09-29", end: "2026-09-29" }),
      ).rejects.toThrow(/503/);
    }
    expect(await route(h)).toMatchObject({ active_source: null });
    const alerts = await openAlerts(h);
    expect(alerts.map((a) => a.kind)).toEqual(["failover", "staleness"]);
    expect(alerts[0]!.message).toMatch(/no fallback; serving last-good data/);
    // Jobs now fail fast instead of hammering a provider that is down.
    await expect(
      h.run("ingest-eod", { symbol: "TEST_SPLIT4", start: "2026-09-29", end: "2026-09-29" }),
    ).rejects.toThrow(/No provider is available/);
    // Last-good data is still there.
    const latest = await sql<{
      d: string;
    }>`select max(date)::text as d from market.prices_daily`.execute(h.t.db);
    expect(latest.rows[0]!.d).toBe("2026-09-28");
  });

  it("does not fail back on successes from before the outage", async () => {
    const { h, primary } = await setup("synthetic");
    // The primary answers fine (a streak of successes) but delivers nothing for 2026-09-29.
    primary.failing = false;
    for (let i = 0; i < 4; i += 1)
      await h.run("ingest-eod", { symbol: "TEST_SPLIT4", start: "2026-09-21", end: "2026-09-21" });
    const before = await h.t.db
      .selectFrom("ops.provider_health")
      .select("consecutive_successes")
      .where("source", "=", "tiingo")
      .executeTakeFirstOrThrow();
    expect(before.consecutive_successes).toBe(4);

    // 18:31 ET: stale, so fail over. The same monitor run then probes the healthy primary once.
    h.setNow(AFTER_DEADLINE);
    await h.run("staleness-monitor");
    expect((await route(h)).active_source).toBe("synthetic");
    const after = await h.t.db
      .selectFrom("ops.provider_health")
      .select("consecutive_successes")
      .where("source", "=", "tiingo")
      .executeTakeFirstOrThrow();
    expect(after.consecutive_successes).toBe(1);
    expect(h.events.filter((e) => e.type === "provider_failback")).toHaveLength(0);
  });
});
