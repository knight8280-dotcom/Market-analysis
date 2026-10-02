import { OWNER_USER_ID } from "@market/config";
import { sql } from "@market/db";
import type { BacktestReport, StrategyInput } from "@market/backtest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataError, loadBacktestData } from "../src/backtest/load";
import { threadRunner } from "../src/backtest/runner";
import type { RunOutcome } from "../src/backtest/execute";
import { dispatchQueuedBacktests } from "../src/jobs/backtest";
import { resolveStrategy } from "@market/backtest";
import { harness, type Harness } from "./helpers/context";

/**
 * Backtests against the database (Phase 2 steps B3 and B7): the loader on the synthetic
 * universe (splits, dividends, a delisting, a reused ticker), runs through the job, the same
 * results when re-run on the same data, and the worker-thread runner.
 */
let h: Harness;
const RANGE = { start: "2020-01-02", end: "2021-12-31", source: "synthetic" };

const strategy = (over: Partial<StrategyInput> = {}): StrategyInput => ({
  version: 1,
  universe: { kind: "all", assetClass: "equity" },
  entry: {
    combine: "all",
    rules: [
      {
        left: { kind: "price", field: "close" },
        op: ">",
        right: { kind: "indicator", id: "sma", params: { period: 20 } },
      },
    ],
  },
  exit: {
    combine: "all",
    rules: [
      {
        left: { kind: "price", field: "close" },
        op: "<",
        right: { kind: "indicator", id: "sma", params: { period: 20 } },
      },
    ],
  },
  sizing: { maxPositions: 5 },
  costs: { commissionPerTrade: 1, commissionBps: 0, slippageBps: 5 },
  initialCapital: 100_000,
  start: "2020-06-01",
  end: "2021-12-31",
  benchmark: "TEST_DIV",
  ...over,
});

async function queue(request: unknown, kind = "single"): Promise<string> {
  const row = await h.t.db
    .insertInto("backtest_runs")
    .values({
      user_id: OWNER_USER_ID,
      name: "Test run",
      kind,
      request: JSON.stringify(request),
    })
    .returning("run_id")
    .executeTakeFirstOrThrow();
  return row.run_id;
}

const runOf = (runId: string) =>
  h.t.db
    .selectFrom("backtest_runs")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirstOrThrow();
const resultOf = (runId: string) =>
  h.t.db
    .selectFrom("backtest_results")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirstOrThrow();

beforeAll(async () => {
  h = await harness({ universeSize: 30, now: "2022-01-03T12:00:00Z" });
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
  // Three-month T-bill rates for Sharpe and Sortino.
  await sql`
    insert into market.macro_series (series_id, title, source) values ('DTB3', 'T-bill', 'fred')
    on conflict do nothing
  `.execute(h.t.db);
  await sql`
    insert into market.macro_observations (series_id, date, value, realtime_start)
    values ('DTB3', '2020-01-02', 1.5, '2020-01-02'), ('DTB3', '2021-01-04', 0.08, '2021-01-04')
  `.execute(h.t.db);
}, 300_000);
afterAll(async () => {
  await h.t.drop();
});

describe("loading", () => {
  it("includes a delisted security until the day before it delisted", async () => {
    const { data, inputs } = await loadBacktestData(h.t.db, resolveStrategy(strategy()), {
      source: "synthetic",
    });
    const delisted = data.securities.find((s) => s.ticker === "TEST_DELIST")!;
    expect(delisted.delistedAt).toBe("2021-03-31");
    expect(delisted.membership).toEqual([{ from: inputs.loadedFrom, to: "2021-03-30" }]);
    expect(delisted.bars.dates.at(-1)! < "2021-03-31").toBe(true);
    expect(inputs.runFrom).toBe("2020-06-01");
    expect(inputs.warmupSessions).toBe(40);
    expect(data.sessions[0]).toBe(inputs.loadedFrom);
    expect(inputs.loadedFrom < "2020-06-01").toBe(true);
    expect(data.riskFree!.rate[0]).toBeCloseTo(0.015, 12);
    expect(data.benchmark!.ticker).toBe("TEST_DIV");
  });

  it("keeps raw prices with the factors that adjust them across a split", async () => {
    const s = resolveStrategy(
      strategy({ universe: { kind: "tickers", tickers: ["TEST_SPLIT4"] } }),
    );
    const { data } = await loadBacktestData(h.t.db, s, { source: "synthetic" });
    const sec = data.securities[0]!;
    expect(sec.shareChanges).toEqual([{ exDate: "2020-08-31", ratio: 4 }]);
    const k = sec.bars.dates.indexOf("2020-08-31");
    const b = sec.bars;
    // Raw closes fall about 4× at the split; adjusted closes do not jump.
    expect(b.close[k - 1]! / b.close[k]!).toBeGreaterThan(3);
    const adj = (i: number) => b.close[i]! * b.splitFactor[i]! * b.dividendFactor[i]!;
    expect(Math.abs(adj(k) / adj(k - 1) - 1)).toBeLessThan(0.2);
    expect(b.splitFactor[k - 1]).toBeCloseTo(0.25, 12);
    expect(b.splitFactor[k]).toBe(1);
  });

  it("uses the security that held a reused ticker last, and says so", async () => {
    const s = resolveStrategy(
      strategy({ universe: { kind: "tickers", tickers: ["TEST_REUSE"] }, start: "2019-03-01" }),
    );
    const { data, inputs } = await loadBacktestData(h.t.db, s, { source: "synthetic" });
    expect(data.securities).toHaveLength(1);
    expect(inputs.notes.join(" ")).toMatch(/TEST_REUSE also named another security/);
    expect(inputs.notes.join(" ")).toMatch(/Prices start on 2020-01-02/);
  });

  it("refuses unknown tickers", async () => {
    const s = resolveStrategy(strategy({ universe: { kind: "tickers", tickers: ["TEST_NOPE"] } }));
    await expect(loadBacktestData(h.t.db, s, { source: "synthetic" })).rejects.toThrow(DataError);
  });
});

describe("runs", () => {
  let first: string;

  it("runs a queued backtest and stores its results, code version and data fingerprint", async () => {
    first = await queue({ kind: "single", strategy: strategy(), split: "2021-01-04" });
    const outcome = (await h.run("run-backtest", { runId: first })) as RunOutcome;
    expect(outcome.status).toBe("succeeded");
    const run = await runOf(first);
    expect(run.status).toBe("succeeded");
    expect(run.code_version).toMatch(/^backtest \d+\.\d+\.\d+, engine \d+/);
    expect(run.data_snapshot_id).toMatch(/^[0-9a-f]{64}$/);
    expect(run.started_at).not.toBeNull();
    const result = await resultOf(first);
    const report = result.report as unknown as BacktestReport;
    expect(report.sessions.first).toBe("2020-06-01");
    expect(report.benchmark?.ticker).toBe("TEST_DIV");
    expect(report.riskFreeAvailable).toBe(true);
    expect(report.trades.length).toBeGreaterThan(0);
    expect(result.validation).toMatchObject({ kind: "split", split: "2021-01-04" });
    expect(result.summary).toMatchObject({ first: "2020-06-01", combinations: 1 });
  });

  it("trades a stock that later delisted and closes it at its last close", async () => {
    const report = (await resultOf(first)).report as unknown as BacktestReport;
    const delisted = report.trades.filter((t) => t.ticker === "TEST_DELIST");
    expect(delisted.length).toBeGreaterThan(0);
    for (const t of report.trades.filter((x) => x.exitReason === "delisted")) {
      expect(t.ticker).toBe("TEST_DELIST");
      expect(t.exitDate! < "2021-03-31").toBe(true);
    }
    expect(report.fills.some((f) => f.date >= "2021-03-31" && f.ticker === "TEST_DELIST")).toBe(
      false,
    );
  });

  it("gives identical results when re-run on the same data", async () => {
    const again = await queue({ kind: "single", strategy: strategy(), split: "2021-01-04" });
    await h.run("run-backtest", { runId: again });
    const [a, b] = await Promise.all([runOf(first), runOf(again)]);
    expect(b.data_snapshot_id).toBe(a.data_snapshot_id);
    const [ra, rb] = await Promise.all([resultOf(first), resultOf(again)]);
    expect(rb.report).toEqual(ra.report);
    expect(rb.summary).toEqual(ra.summary);
    expect(rb.inputs).toEqual(ra.inputs);
  });

  it("changes the fingerprint when a stored price is corrected", async () => {
    await sql`
      update market.prices_daily set close = close + 0.01
      where date = '2021-06-01' and source = 'synthetic'
        and security_id = (select security_id from market.securities where ticker = 'TEST_DIV')
    `.execute(h.t.db);
    const corrected = await queue({ kind: "single", strategy: strategy(), split: null });
    await h.run("run-backtest", { runId: corrected });
    expect((await runOf(corrected)).data_snapshot_id).not.toBe(
      (await runOf(first)).data_snapshot_id,
    );
  });

  it("runs a parameter sweep and keeps the best combination's full report", async () => {
    const swept = strategy({
      entry: {
        combine: "all",
        rules: [
          {
            left: { kind: "price", field: "close" },
            op: ">",
            right: { kind: "indicator", id: "sma", params: { period: { $param: "n" } } },
          },
        ],
      },
      exit: null,
    });
    const id = await queue(
      { kind: "sweep", strategy: swept, params: { n: [10, 50] }, objective: "total_return" },
      "sweep",
    );
    await h.run("run-backtest", { runId: id });
    expect((await runOf(id)).status).toBe("succeeded");
    const result = await resultOf(id);
    const validation = result.validation as {
      kind: string;
      rows: { values: { n: number }; summary: { totalReturn: number } }[];
      best: { values: { n: number } };
    };
    expect(validation.kind).toBe("sweep");
    expect(validation.rows).toHaveLength(2);
    const best = Math.max(...validation.rows.map((r) => r.summary.totalReturn));
    const report = result.report as unknown as BacktestReport;
    expect(report.metrics.totalReturn).toBe(best);
    expect(result.summary).toMatchObject({ combinations: 2, best: validation.best.values });
  });

  it("runs a walk-forward analysis without a single report", async () => {
    const swept = strategy({
      entry: {
        combine: "all",
        rules: [
          {
            left: { kind: "price", field: "close" },
            op: ">",
            right: { kind: "indicator", id: "ema", params: { period: { $param: "n" } } },
          },
        ],
      },
      start: "2020-03-02",
    });
    const id = await queue(
      {
        kind: "walk_forward",
        strategy: swept,
        params: { n: [10, 30] },
        objective: "sharpe",
        trainMonths: 6,
        testMonths: 6,
      },
      "walk_forward",
    );
    await h.run("run-backtest", { runId: id });
    const run = await runOf(id);
    expect(run.error).toBeNull();
    const result = await resultOf(id);
    expect(result.report).toBeNull();
    expect(result.validation).toMatchObject({ kind: "walk_forward", trainMonths: 6 });
    expect((result.validation as { windows: unknown[] }).windows).toHaveLength(3);
  });

  it("fails a run with a message the owner can act on", async () => {
    const unknown = await queue({
      kind: "single",
      strategy: strategy({ universe: { kind: "tickers", tickers: ["TEST_NOPE"] } }),
    });
    await h.run("run-backtest", { runId: unknown });
    expect(await runOf(unknown)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/no security had the ticker TEST_NOPE/) as unknown,
    });
    const invalid = await queue({ kind: "single", strategy: { ...strategy(), sizing: {} } });
    await h.run("run-backtest", { runId: invalid });
    expect((await runOf(invalid)).error).toMatch(/sizing\.maxPositions/);
  });

  it("explains that ranking by Sharpe ratio needs T-bill rates", async () => {
    const swept = strategy({
      entry: {
        combine: "all",
        rules: [
          {
            left: { kind: "price", field: "close" },
            op: ">",
            right: { kind: "indicator", id: "sma", params: { period: { $param: "n" } } },
          },
        ],
      },
      start: "2020-01-02",
      end: "2020-12-31",
    });
    await sql`delete from market.macro_observations where series_id = 'DTB3'`.execute(h.t.db);
    try {
      const id = await queue(
        { kind: "sweep", strategy: swept, params: { n: [10, 20] }, objective: "sharpe" },
        "sweep",
      );
      await h.run("run-backtest", { runId: id });
      expect((await runOf(id)).error).toMatch(/Sharpe ratio needs the 3-month T-bill rate/);
    } finally {
      await sql`
        insert into market.macro_observations (series_id, date, value, realtime_start)
        values ('DTB3', '2020-01-02', 1.5, '2020-01-02'), ('DTB3', '2021-01-04', 0.08, '2021-01-04')
      `.execute(h.t.db);
    }
  });

  it("skips a run that is no longer queued", async () => {
    const id = await queue({ kind: "single", strategy: strategy() });
    await h.t.db
      .updateTable("backtest_runs")
      .set({ status: "cancelled" })
      .where("run_id", "=", id)
      .execute();
    expect(await h.run("run-backtest", { runId: id })).toMatchObject({ status: "skipped" });
  });
});

describe("dispatch", () => {
  it("enqueues each queued run once and fails runs abandoned while running", async () => {
    const queued = await queue({ kind: "single", strategy: strategy() });
    const stuck = await queue({ kind: "single", strategy: strategy() });
    await h.t.db
      .updateTable("backtest_runs")
      .set({ status: "running", started_at: new Date("2021-12-31T00:00:00Z") })
      .where("run_id", "=", stuck)
      .execute();
    const before = h.dispatcher.size;
    const result = await dispatchQueuedBacktests(h.ctx);
    expect(result.abandoned).toBe(1);
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    await dispatchQueuedBacktests(h.ctx);
    expect(h.dispatcher.size - before).toBe(result.dispatched);
    expect(await runOf(stuck)).toMatchObject({ status: "failed" });
    await h.drain();
    expect((await runOf(queued)).status).toBe("succeeded");
  });
});

describe("worker thread", () => {
  it("runs a backtest off the main thread with the same results", async () => {
    const id = await queue({ kind: "single", strategy: strategy(), split: "2021-01-04" });
    const runner = threadRunner({ db: h.t.db, databaseUrl: h.t.url, log: h.ctx.log });
    const outcome = await runner(id, "synthetic");
    expect(outcome.status).toBe("succeeded");
    const reference = await queue({ kind: "single", strategy: strategy(), split: "2021-01-04" });
    await h.run("run-backtest", { runId: reference });
    expect((await resultOf(id)).report).toEqual((await resultOf(reference)).report);
    expect((await runOf(id)).code_version).toMatch(/^backtest .*, [0-9a-f]{12}$/);
  });
});
