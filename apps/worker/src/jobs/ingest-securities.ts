import { ProviderId } from "@market/market-data";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { statusDelta, statusSnapshot } from "../http-stats";
import { JOBS } from "../queues";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import { upsertSecurityRecord } from "../repo/securities";
import { resolveSource, withProviderHealth } from "../routing";

export const IngestSecuritiesInput = z.object({
  symbols: z.array(z.string().min(1)).optional(),
  source: ProviderId.optional(),
});

/** Loads the vendor's security list into the securities master (idempotent). */
export async function ingestSecurities(ctx: WorkerContext, raw: unknown) {
  const input = IngestSecuritiesInput.parse(raw);
  const { route, source, provider } = await resolveSource(ctx, "securities", input.source);
  const runId = await startRun(ctx.db, {
    jobName: JOBS.ingestSecurities,
    jobId: ctx.jobId,
    dataset: "securities",
    source,
    params: input,
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  const before = statusSnapshot(provider);
  try {
    // Vendors with a symbol quota (Tiingo) get exactly the configured universe.
    const symbols =
      input.symbols ??
      (ctx.universe && source !== "synthetic"
        ? ctx.universe.symbols.map((s) => s.symbol)
        : undefined);
    const records = await withProviderHealth(ctx, { route, source, dataset: "securities" }, () =>
      provider.getSecurities(symbols ? { symbols } : {}),
    );
    counts.rows_fetched = records.length;
    for (const record of records) {
      const { created } = await upsertSecurityRecord(ctx.db, record);
      if (created) counts.rows_inserted += 1;
      else counts.rows_updated += 1;
    }
    await finishRun(ctx.db, runId, {
      status: "succeeded",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      at: ctx.clock(),
    });
    return { runId, source, ...counts };
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
