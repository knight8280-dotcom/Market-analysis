import { z } from "zod";
import { BACKTEST_TIME_LIMIT_MS, inProcessRunner } from "../backtest/runner";
import type { WorkerContext } from "../context";
import { JOBS, jobId } from "../queues";
import { routeFor } from "../routing";

/**
 * Backtest jobs (Phase 2 step B7). The web queues a run by inserting it into
 * public.backtest_runs; the worker polls for queued runs and enqueues one `run-backtest` job per
 * run id (deterministic id, so polling twice is harmless).
 */

const Data = z.object({ runId: z.string().regex(/^[0-9]+$/) });

export async function runBacktestJob(ctx: WorkerContext, data: unknown) {
  const { runId } = Data.parse(data);
  const route = await routeFor(ctx, "daily_bars");
  const runner = ctx.backtests ?? inProcessRunner(ctx.db);
  const outcome = await runner(runId, route.active ?? route.primary);
  ctx.log.info({ outcome }, "backtest finished");
  return outcome;
}

/** A run still marked running this long after it started lost its worker. */
export const ABANDONED_AFTER_MS = 3 * BACKTEST_TIME_LIMIT_MS;

export async function dispatchQueuedBacktests(
  ctx: Pick<WorkerContext, "db" | "clock" | "dispatch">,
) {
  const abandoned = await ctx.db
    .updateTable("backtest_runs")
    .set({
      status: "failed",
      error: "the worker stopped before the run finished; run it again",
      finished_at: ctx.clock(),
    })
    .where("status", "=", "running")
    .where("started_at", "<", new Date(ctx.clock().getTime() - ABANDONED_AFTER_MS))
    .executeTakeFirst();
  const queued = await ctx.db
    .selectFrom("backtest_runs")
    .select("run_id")
    .where("status", "=", "queued")
    .orderBy("created_at")
    .orderBy("run_id")
    .limit(100)
    .execute();
  for (const { run_id } of queued) {
    await ctx.dispatch.dispatch({
      name: JOBS.runBacktest,
      data: { runId: run_id },
      jobId: jobId(JOBS.runBacktest, run_id),
    });
  }
  return { dispatched: queued.length, abandoned: Number(abandoned.numUpdatedRows) };
}
