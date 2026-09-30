import "server-only";
import { sql, type Database } from "@market/db";
import { ProviderId } from "@market/market-data";
import type { HeatTile } from "../lib/heatmap/layout";
import type { HeatmapPeriod } from "../lib/heatmap/scale";

export type HeatmapSet = "stocks" | "etfs";
export type HeatmapSize = "cap" | "dollar";

export interface HeatmapData {
  tiles: HeatTile[];
  /** Securities left out because the chosen size is unknown for them. */
  missingSize: number;
  /** Whether any security in the set has a market cap (otherwise only dollar volume works). */
  anyMarketCap: boolean;
  asOf: string | null;
  refreshedAt: Date | null;
  source: ProviderId | null;
}

/**
 * Heatmap tiles from the screener snapshot (Phase 1 step H3). Market cap comes from SEC shares
 * outstanding times the close; dollar volume is the close times 30-day average volume.
 */
export async function heatmapData(
  db: Database,
  set: HeatmapSet,
  period: HeatmapPeriod,
  size: HeatmapSize,
): Promise<HeatmapData> {
  const rows = await sql<{
    security_id: string;
    ticker: string;
    name: string;
    sector: string | null;
    market_cap: number | null;
    dollar_volume: number | null;
    change: number | null;
    as_of: string;
    refreshed_at: Date;
    source: string;
  }>`
    select security_id::text, ticker, name, sector, market_cap,
      close::double precision * avg_volume_30d as dollar_volume,
      ${sql.ref(period.field)} as change, as_of, refreshed_at, source
    from market.screener_snapshot
    where asset_class = ${set === "etfs" ? "etf" : "equity"}
  `.execute(db);
  const other = set === "etfs" ? "ETFs" : "Unclassified";
  const tiles: HeatTile[] = [];
  let missingSize = 0;
  for (const r of rows.rows) {
    const weight = size === "cap" ? r.market_cap : r.dollar_volume;
    if (weight === null || !(weight > 0)) {
      missingSize++;
      continue;
    }
    tiles.push({
      securityId: r.security_id,
      ticker: r.ticker,
      name: r.name,
      group: r.sector ?? other,
      size: weight,
      change: r.change,
    });
  }
  const latest = rows.rows.reduce<(typeof rows.rows)[number] | null>(
    (m, r) => (m === null || r.as_of > m.as_of ? r : m),
    null,
  );
  return {
    tiles,
    missingSize,
    anyMarketCap: rows.rows.some((r) => r.market_cap !== null && r.market_cap > 0),
    asOf: latest?.as_of ?? null,
    refreshedAt: latest?.refreshed_at ?? null,
    source: latest ? ProviderId.parse(latest.source) : null,
  };
}
