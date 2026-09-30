import type { IsoDate } from "@market/calendar";
import { sql, type Database } from "@market/db";
import type { DailyBar, ProviderId } from "@market/market-data";

export interface MergeResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Idempotent merge of validated raw bars for one security and source.
 * - new bars are inserted;
 * - bars identical to what is stored are left alone (re-running changes nothing);
 * - bars the vendor has corrected are updated, and the old and new values are logged in
 *   ops.data_corrections (spec §3.7 "late and corrected prints").
 * Values are compared as numeric(20,6), the stored precision.
 */
export async function mergeDailyBars(
  db: Database,
  m: { securityId: string; source: ProviderId; bars: readonly DailyBar[]; runId: string | null },
): Promise<MergeResult> {
  if (m.bars.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
  const col = <K extends keyof DailyBar>(k: K) => m.bars.map((b) => b[k]);
  const s = sql`
    select * from unnest(
      ${col("date")}::date[], ${col("open")}::numeric(20,6)[], ${col("high")}::numeric(20,6)[],
      ${col("low")}::numeric(20,6)[], ${col("close")}::numeric(20,6)[], ${col("volume")}::bigint[],
      ${col("vwap")}::numeric(20,6)[]
    ) as t(date, open, high, low, close, volume, vwap)`;

  return db.transaction().execute(async (trx) => {
    const updated = await sql<{ n: string }>`
      with s as (${s}),
      changed as (
        select p.date,
          jsonb_build_object('open', p.open, 'high', p.high, 'low', p.low, 'close', p.close,
                             'volume', p.volume, 'vwap', p.vwap) as old_values,
          jsonb_build_object('open', s.open, 'high', s.high, 'low', s.low, 'close', s.close,
                             'volume', s.volume, 'vwap', s.vwap) as new_values
        from s join market.prices_daily p
          on p.security_id = ${m.securityId} and p.source = ${m.source} and p.date = s.date
        where (p.open, p.high, p.low, p.close, p.volume, p.vwap)
          is distinct from (s.open, s.high, s.low, s.close, s.volume, s.vwap)
      ),
      logged as (
        insert into ops.data_corrections (security_id, date, source, old_values, new_values, run_id)
        select ${m.securityId}, date, ${m.source}, old_values, new_values, ${m.runId} from changed
        returning 1
      ),
      applied as (
        update market.prices_daily p
        set open = s.open, high = s.high, low = s.low, close = s.close, volume = s.volume,
            vwap = s.vwap, ingestion_run_id = ${m.runId}, ingested_at = now()
        from s
        where p.security_id = ${m.securityId} and p.source = ${m.source} and p.date = s.date
          and (p.open, p.high, p.low, p.close, p.volume, p.vwap)
            is distinct from (s.open, s.high, s.low, s.close, s.volume, s.vwap)
        returning 1
      )
      select (select count(*) from applied) as n, (select count(*) from logged) as logged
    `.execute(trx);

    const inserted = await sql<{ n: string }>`
      with s as (${s}),
      ins as (
        insert into market.prices_daily
          (security_id, date, source, open, high, low, close, volume, vwap, ingestion_run_id)
        select ${m.securityId}, date, ${m.source}, open, high, low, close, volume, vwap, ${m.runId} from s
        on conflict (security_id, date, source) do nothing
        returning 1
      )
      select count(*) as n from ins
    `.execute(trx);

    const nUpdated = Number(updated.rows[0]?.n ?? 0);
    const nInserted = Number(inserted.rows[0]?.n ?? 0);
    return {
      inserted: nInserted,
      updated: nUpdated,
      unchanged: m.bars.length - nInserted - nUpdated,
    };
  });
}

/** Last stored raw close before `date` (any source preference: the given source only). */
export async function previousClose(
  db: Database,
  q: { securityId: string; source: ProviderId; before: IsoDate },
): Promise<number | null> {
  const row = await db
    .selectFrom("market.prices_daily")
    .select("close")
    .where("security_id", "=", q.securityId)
    .where("source", "=", q.source)
    .where("date", "<", q.before)
    .orderBy("date", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ? Number(row.close) : null;
}

/** Raw closes on specific dates, by source. */
export async function closesOn(
  db: Database,
  securityId: string,
  dates: readonly IsoDate[],
): Promise<{ date: IsoDate; source: string; close: number }[]> {
  if (dates.length === 0) return [];
  const rows = await db
    .selectFrom("market.prices_daily")
    .select(["date", "source", "close"])
    .where("security_id", "=", securityId)
    .where("date", "in", dates)
    .execute();
  return rows.map((r) => ({ date: r.date, source: r.source, close: Number(r.close) }));
}
