import { sql, type Database } from "@market/db";
import type { MacroObservation, MacroSeries } from "@market/market-data";

export async function upsertSeries(db: Database, s: MacroSeries): Promise<void> {
  const values = {
    series_id: s.series_id,
    source: s.source,
    title: s.title,
    units: s.units,
    frequency: s.frequency,
    seasonal_adjustment: s.seasonal_adjustment,
    last_updated: s.last_updated,
    observation_start: s.observation_start,
    observation_end: s.observation_end,
    ingested_at: s.fetched_at,
  };
  await db
    .insertInto("market.macro_series")
    .values(values)
    .onConflict((oc) => oc.column("series_id").doUpdateSet(values))
    .execute();
}

/** Inserts new observations and applies revisions. Returns { inserted, revised }. */
export async function upsertObservations(
  db: Database,
  observations: readonly MacroObservation[],
): Promise<{ inserted: number; revised: number }> {
  if (observations.length === 0) return { inserted: 0, revised: 0 };
  const col = <K extends keyof MacroObservation>(k: K) => observations.map((o) => o[k]);
  const result = await sql<{ inserted: string; revised: string }>`
    with s as (
      select * from unnest(${col("series_id")}::text[], ${col("date")}::date[],
                           ${col("value").map((v) => (v === null ? null : String(v)))}::numeric[],
                           ${col("realtime_start")}::date[]) as t(series_id, date, value, realtime_start)
    ),
    up as (
      insert into market.macro_observations (series_id, date, value, realtime_start)
      select series_id, date, value, realtime_start from s
      on conflict (series_id, date) do update
        set value = excluded.value, realtime_start = excluded.realtime_start, ingested_at = now()
        where market.macro_observations.value is distinct from excluded.value
      returning (xmax = 0) as inserted
    )
    select count(*) filter (where inserted) as inserted, count(*) filter (where not inserted) as revised from up
  `.execute(db);
  const row = result.rows[0];
  return { inserted: Number(row?.inserted ?? 0), revised: Number(row?.revised ?? 0) };
}
