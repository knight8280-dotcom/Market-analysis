import { sql, type Database } from "@market/db";
import type { ProviderId } from "@market/market-data";

export type AlertKind =
  "staleness" | "failover" | "failback" | "data_quality" | "partition" | "rate_limit";

export interface AlertInput {
  kind: AlertKind;
  dataset: string;
  source: ProviderId | null;
  severity: "info" | "warning" | "critical";
  message: string;
  details?: Record<string, unknown>;
  at: Date;
}

/** Opens an alert, or refreshes the open one with the same (kind, dataset, source). */
export async function openAlert(db: Database, a: AlertInput): Promise<{ opened: boolean }> {
  const row = await sql<{ inserted: boolean }>`
    insert into ops.alerts (kind, dataset, source, severity, message, details, opened_at, last_seen_at)
    values (${a.kind}, ${a.dataset}, ${a.source}, ${a.severity}, ${a.message},
            ${JSON.stringify(a.details ?? {})}::jsonb, ${a.at}, ${a.at})
    on conflict (kind, dataset, source) where resolved_at is null
    do update set last_seen_at = excluded.last_seen_at, message = excluded.message,
                  severity = excluded.severity, details = excluded.details
    returning (xmax = 0) as inserted
  `.execute(db);
  return { opened: row.rows[0]?.inserted === true };
}

/** Resolves open alerts of this kind for the dataset (any source unless given). */
export async function resolveAlerts(
  db: Database,
  r: { kind: AlertKind; dataset: string; source?: ProviderId | null; at: Date },
): Promise<number> {
  let q = db
    .updateTable("ops.alerts")
    .set({ resolved_at: r.at })
    .where("kind", "=", r.kind)
    .where("dataset", "=", r.dataset)
    .where("resolved_at", "is", null);
  if (r.source !== undefined)
    q = r.source === null ? q.where("source", "is", null) : q.where("source", "=", r.source);
  const result = await q.executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** Records a one-off event as an already-resolved alert (e.g. a failback), for history. */
export async function recordEventAlert(db: Database, a: AlertInput): Promise<void> {
  await db
    .insertInto("ops.alerts")
    .values({
      kind: a.kind,
      dataset: a.dataset,
      source: a.source,
      severity: a.severity,
      message: a.message,
      details: JSON.stringify(a.details ?? {}),
      opened_at: a.at,
      last_seen_at: a.at,
      resolved_at: a.at,
    })
    .execute();
}
