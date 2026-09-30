import type { Database } from "@market/db";
import type { ProviderId } from "@market/market-data";

export interface RunCounts {
  rows_fetched: number;
  rows_inserted: number;
  rows_updated: number;
  rows_unchanged: number;
  rows_rejected: number;
  rows_flagged: number;
}

export const emptyCounts = (): RunCounts => ({
  rows_fetched: 0,
  rows_inserted: 0,
  rows_updated: 0,
  rows_unchanged: 0,
  rows_rejected: 0,
  rows_flagged: 0,
});

export async function startRun(
  db: Database,
  run: {
    jobName: string;
    jobId?: string;
    dataset: string;
    source: ProviderId | null;
    params: unknown;
    at: Date;
  },
): Promise<string> {
  const row = await db
    .insertInto("ops.data_ingestion_runs")
    .values({
      job_name: run.jobName,
      job_id: run.jobId ?? null,
      dataset: run.dataset,
      source: run.source,
      params: JSON.stringify(run.params ?? {}),
      started_at: run.at,
    })
    .returning("run_id")
    .executeTakeFirstOrThrow();
  return row.run_id;
}

export async function finishRun(
  db: Database,
  runId: string,
  result: {
    status: "succeeded" | "failed";
    counts?: RunCounts;
    httpStatusCounts?: ReadonlyMap<number, number>;
    error?: string;
    at: Date;
  },
): Promise<void> {
  await db
    .updateTable("ops.data_ingestion_runs")
    .set({
      status: result.status,
      finished_at: result.at,
      ...(result.counts ?? {}),
      http_status_counts: JSON.stringify(Object.fromEntries(result.httpStatusCounts ?? new Map())),
      error: result.error ?? null,
    })
    .where("run_id", "=", runId)
    .execute();
}
