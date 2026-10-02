import {
  BacktestError,
  checkRunRequest,
  describeError,
  resolveStrategy,
  runBacktest,
  splitMetrics,
  sweep,
  walkForward,
  warmupSessions,
  type BacktestReport,
  type CheckedRequest,
} from "@market/backtest";
import { dataSnapshotId } from "@market/backtest/snapshot";
import type { Database } from "@market/db";
import { loadBacktestData } from "./load";

/**
 * Runs one queued backtest (Phase 2 step B7): claims it, loads its data, runs it, and stores the
 * results with the code version and a fingerprint of the data, so that the same request on the
 * same data can be shown to give the same results. A strategy or data problem fails the run
 * with a message for the owner; only a database failure is thrown (and retried by the queue).
 */

export interface ExecuteOptions {
  /** Price source for bars, actions and the benchmark (the daily-bars route). */
  source: string;
  codeVersion: string;
  timeLimitMs: number;
}

export interface RunOutcome {
  runId: string;
  status: "succeeded" | "failed" | "skipped";
  error?: string;
  dataSnapshotId?: string;
}

/** Headline figures stored with the results, for run lists. */
export interface RunSummary {
  totalReturn: number | null;
  cagr: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  trades: number | null;
  benchmarkTotalReturn: number | null;
  first: string | null;
  last: string | null;
  combinations: number;
  best: Record<string, number> | null;
}

function fromReport(r: BacktestReport): RunSummary {
  return {
    totalReturn: r.metrics.totalReturn,
    cagr: r.metrics.cagr,
    sharpe: r.metrics.sharpe,
    maxDrawdown: r.metrics.maxDrawdown,
    trades: r.metrics.trades,
    benchmarkTotalReturn: r.benchmark?.metrics.totalReturn ?? null,
    first: r.sessions.first,
    last: r.sessions.last,
    combinations: 1,
    best: null,
  };
}

/** The most history any combination reads, so every combination sees the same data. */
function warmupFor(checked: CheckedRequest): number {
  let warmup = 0;
  for (const values of checked.combinations) {
    try {
      warmup = Math.max(warmup, warmupSessions(resolveStrategy(checked.request.strategy, values)));
    } catch {
      // An invalid combination is reported in the sweep's rows.
    }
  }
  return warmup || warmupSessions(checked.strategy);
}

async function compute(db: Database, checked: CheckedRequest, opts: ExecuteOptions) {
  const { data, inputs } = await loadBacktestData(db, checked.strategy, {
    source: opts.source,
    warmup: warmupFor(checked),
  });
  const snapshot = dataSnapshotId(data);
  const deadline = Date.now() + opts.timeLimitMs;
  const request = checked.request;

  switch (request.kind) {
    case "single": {
      const report = runBacktest(checked.strategy, data, { deadline });
      const validation = request.split
        ? { kind: "split" as const, ...splitMetrics(report, request.split, data) }
        : null;
      return { snapshot, inputs, report, validation, summary: fromReport(report) };
    }
    case "sweep": {
      const result = sweep(
        request.strategy,
        data,
        request.params,
        request.objective,
        undefined,
        deadline,
      );
      if (!result.best) {
        const reason = result.rows.find((r) => r.error)?.error;
        throw new BacktestError(
          `no combination gave a ${request.objective.replace("_", " ")}${reason ? ` (${reason})` : ""}`,
        );
      }
      const report = runBacktest(resolveStrategy(request.strategy, result.best.values), data, {
        deadline,
      });
      return {
        snapshot,
        inputs,
        report,
        validation: {
          kind: "sweep" as const,
          objective: request.objective,
          params: request.params,
          ...result,
        },
        summary: {
          ...fromReport(report),
          combinations: result.combinations,
          best: result.best.values,
        },
      };
    }
    case "walk_forward": {
      const wf = walkForward(
        request.strategy,
        data,
        request.params,
        request.objective,
        request.trainMonths,
        request.testMonths,
        deadline,
      );
      if (!wf.metrics) throw new BacktestError("no test window produced results");
      const summary: RunSummary = {
        totalReturn: wf.metrics.totalReturn,
        cagr: wf.metrics.cagr,
        sharpe: wf.metrics.sharpe,
        maxDrawdown: wf.metrics.maxDrawdown,
        trades: wf.windows.reduce((n, w) => n + (w.outOfSample?.trades ?? 0), 0),
        benchmarkTotalReturn: wf.benchmark?.metrics?.totalReturn ?? null,
        first: wf.dates[0] ?? null,
        last: wf.dates.at(-1) ?? null,
        combinations: wf.combinations,
        best: null,
      };
      return {
        snapshot,
        inputs,
        report: null,
        validation: {
          kind: "walk_forward" as const,
          objective: request.objective,
          params: request.params,
          trainMonths: request.trainMonths,
          testMonths: request.testMonths,
          ...wf,
        },
        summary,
      };
    }
  }
}

export async function executeRun(
  db: Database,
  runId: string,
  opts: ExecuteOptions,
): Promise<RunOutcome> {
  // A run still marked running belongs to this job (one job per run id): a retry after a crash.
  const run = await db
    .updateTable("backtest_runs")
    .set({ status: "running", started_at: new Date(), error: null, finished_at: null })
    .where("run_id", "=", runId)
    .where("status", "in", ["queued", "running"])
    .returning(["user_id", "request"])
    .executeTakeFirst();
  if (!run) return { runId, status: "skipped" };

  let result: Awaited<ReturnType<typeof compute>>;
  try {
    result = await compute(db, checkRunRequest(run.request), opts);
  } catch (err) {
    const error = describeError(err);
    await db
      .updateTable("backtest_runs")
      .set({ status: "failed", error, finished_at: new Date() })
      .where("run_id", "=", runId)
      .execute();
    return { runId, status: "failed", error };
  }

  const row = {
    user_id: run.user_id,
    summary: JSON.stringify(result.summary),
    report: result.report ? JSON.stringify(result.report) : null,
    validation: result.validation ? JSON.stringify(result.validation) : null,
    inputs: JSON.stringify(result.inputs),
  };
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("backtest_results")
      .values({ run_id: runId, ...row })
      .onConflict((oc) => oc.column("run_id").doUpdateSet(row))
      .execute();
    await trx
      .updateTable("backtest_runs")
      .set({
        status: "succeeded",
        code_version: opts.codeVersion,
        data_snapshot_id: result.snapshot,
        finished_at: new Date(),
      })
      .where("run_id", "=", runId)
      .execute();
  });
  return { runId, status: "succeeded", dataSnapshotId: result.snapshot };
}

/** Marks a run failed from outside (the thread died or ran past the hard limit). */
export async function failRun(db: Database, runId: string, error: string): Promise<void> {
  await db
    .updateTable("backtest_runs")
    .set({ status: "failed", error, finished_at: new Date() })
    .where("run_id", "=", runId)
    .where("status", "=", "running")
    .execute();
}
