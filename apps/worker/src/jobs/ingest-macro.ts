import { z } from "zod";
import type { WorkerContext } from "../context";
import { statusDelta, statusSnapshot } from "../http-stats";
import { JOBS } from "../queues";
import { upsertObservations, upsertSeries } from "../repo/macro";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import { resolveSource, withProviderHealth } from "../routing";

/** Public-domain FRED series ingested daily (spec §2.4). Add series only after a license check. */
export const DEFAULT_MACRO_SERIES = [
  "DGS3MO",
  "DGS2",
  "DGS10",
  "FEDFUNDS",
  "CPIAUCSL",
  "UNRATE",
  "GDP",
] as const;

export const IngestMacroInput = z.object({ seriesId: z.string().min(1) });

export async function ingestMacro(ctx: WorkerContext, raw: unknown) {
  const { seriesId } = IngestMacroInput.parse(raw);
  const { route, source, provider } = await resolveSource(ctx, "macro");
  const runId = await startRun(ctx.db, {
    jobName: JOBS.ingestMacro,
    jobId: ctx.jobId,
    dataset: "macro",
    source,
    params: { seriesId },
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  const before = statusSnapshot(provider);
  try {
    const call = { route, source, dataset: "macro" as const };
    const series = await withProviderHealth(ctx, call, () => provider.getMacroSeries({ seriesId }));
    const observations = await withProviderHealth(ctx, call, () =>
      provider.getMacroObservations({ seriesId }),
    );
    await upsertSeries(ctx.db, series);
    const { inserted, revised } = await upsertObservations(ctx.db, observations);
    counts.rows_fetched = observations.length;
    counts.rows_inserted = inserted;
    counts.rows_updated = revised;
    counts.rows_unchanged = observations.length - inserted - revised;
    await finishRun(ctx.db, runId, {
      status: "succeeded",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      at: ctx.clock(),
    });
    return { runId, seriesId, ...counts };
  } catch (err) {
    await finishRun(ctx.db, runId, {
      status: "failed",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      error: err instanceof Error ? err.message : String(err),
      at: ctx.clock(),
    });
    throw err;
  }
}
