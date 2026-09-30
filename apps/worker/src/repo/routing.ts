import type { Database } from "@market/db";
import {
  initialRouteState,
  type Dataset,
  type ProviderId,
  type RouteConfig,
  type RouteState,
} from "@market/market-data";

/**
 * Persisted routing state (ops.dataset_routing), shared by every worker process. If the
 * configured primary/fallback changed since the row was written, the row is reset to the new
 * configuration.
 */
export async function loadRoute(
  db: Database,
  dataset: Dataset,
  config: RouteConfig,
): Promise<RouteState> {
  const row = await db
    .selectFrom("ops.dataset_routing")
    .selectAll()
    .where("dataset", "=", dataset)
    .executeTakeFirst();
  if (row && row.primary_source === config.primary && row.fallback_source === config.fallback) {
    return {
      dataset,
      primary: row.primary_source,
      fallback: row.fallback_source,
      active: row.active_source as ProviderId | null,
      failedOverAt: row.failed_over_at,
      reason: row.reason,
    };
  }
  const state = initialRouteState(dataset, config);
  await saveRoute(db, state, new Date());
  return state;
}

export async function saveRoute(db: Database, state: RouteState, at: Date): Promise<void> {
  const values = {
    dataset: state.dataset,
    primary_source: state.primary,
    fallback_source: state.fallback,
    active_source: state.active,
    failed_over_at: state.failedOverAt,
    reason: state.reason,
    updated_at: at,
  };
  await db
    .insertInto("ops.dataset_routing")
    .values(values)
    .onConflict((oc) => oc.column("dataset").doUpdateSet(values))
    .execute();
}
