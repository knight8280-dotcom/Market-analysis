import { marketDateOf } from "@market/calendar";
import { sql } from "@market/db";
import type { WorkerContext } from "../context";
import { openAlert, resolveAlerts } from "../repo/alerts";

/**
 * Creates this year's and next year's prices_daily partitions ahead of time, and alerts if the
 * DEFAULT partition holds rows (they would block creating that year's partition; RUNBOOK).
 */
export async function ensurePartitions(ctx: WorkerContext) {
  const now = ctx.clock();
  const year = Number(marketDateOf(now).slice(0, 4));
  for (const y of [year, year + 1]) {
    await sql`select market.ensure_prices_daily_partition(${y}::int)`.execute(ctx.db);
  }
  const defaultRows = await countDefaultPartitionRows(ctx);
  if (defaultRows > 0) {
    await openAlert(ctx.db, {
      kind: "partition",
      dataset: "daily_bars",
      source: null,
      severity: "warning",
      message: `${defaultRows} rows in market.prices_daily_default; move them before creating their year's partition`,
      details: { rows: defaultRows },
      at: now,
    });
  } else {
    await resolveAlerts(ctx.db, { kind: "partition", dataset: "daily_bars", at: now });
  }
  return { years: [year, year + 1], defaultRows };
}

export async function countDefaultPartitionRows(ctx: WorkerContext): Promise<number> {
  const r = await sql<{ n: string }>`select count(*) as n from market.prices_daily_default`.execute(
    ctx.db,
  );
  return Number(r.rows[0]?.n ?? 0);
}
