import { sql, type Database } from "@market/db";
import type { ProviderId } from "@market/market-data";

/** Provider health per (source, dataset) (spec §7): latency, error counts, last success. */

export async function recordSuccess(
  db: Database,
  h: { source: ProviderId; dataset: string; latencyMs: number; at: Date },
): Promise<number> {
  const row = await db
    .insertInto("ops.provider_health")
    .values({
      source: h.source,
      dataset: h.dataset,
      last_success_at: h.at,
      consecutive_successes: 1,
      last_latency_ms: Math.round(h.latencyMs),
      requests_total: 1,
      updated_at: h.at,
    })
    .onConflict((oc) =>
      oc.columns(["source", "dataset"]).doUpdateSet({
        last_success_at: h.at,
        consecutive_failures: 0,
        consecutive_successes: sql`ops.provider_health.consecutive_successes + 1`,
        last_latency_ms: Math.round(h.latencyMs),
        requests_total: sql`ops.provider_health.requests_total + 1`,
        updated_at: h.at,
      }),
    )
    .returning("consecutive_successes")
    .executeTakeFirstOrThrow();
  return row.consecutive_successes;
}

/** Returns the consecutive-failure count after this failure. */
export async function recordFailure(
  db: Database,
  h: { source: ProviderId; dataset: string; error: string; at: Date },
): Promise<number> {
  const error = h.error.slice(0, 2000);
  const row = await db
    .insertInto("ops.provider_health")
    .values({
      source: h.source,
      dataset: h.dataset,
      last_failure_at: h.at,
      last_error: error,
      consecutive_failures: 1,
      requests_total: 1,
      failures_total: 1,
      updated_at: h.at,
    })
    .onConflict((oc) =>
      oc.columns(["source", "dataset"]).doUpdateSet({
        last_failure_at: h.at,
        last_error: error,
        consecutive_failures: sql`ops.provider_health.consecutive_failures + 1`,
        consecutive_successes: 0,
        requests_total: sql`ops.provider_health.requests_total + 1`,
        failures_total: sql`ops.provider_health.failures_total + 1`,
        updated_at: h.at,
      }),
    )
    .returning("consecutive_failures")
    .executeTakeFirstOrThrow();
  return row.consecutive_failures;
}
