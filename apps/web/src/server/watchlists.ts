import "server-only";
import { OWNER_USER_ID } from "@market/config";
import { sql } from "@market/db";
import { db } from "./db";

export interface WatchlistSummary {
  id: string;
  name: string;
  count: number;
}

export async function listWatchlists(): Promise<WatchlistSummary[]> {
  const rows = await db()
    .selectFrom("watchlists as w")
    .leftJoin("watchlist_items as i", "i.watchlist_id", "w.watchlist_id")
    .select(["w.watchlist_id", "w.name", (eb) => eb.fn.count<string>("i.security_id").as("n")])
    .where("w.user_id", "=", OWNER_USER_ID)
    .groupBy(["w.watchlist_id", "w.name", "w.position"])
    .orderBy("w.position")
    .orderBy("w.name")
    .execute();
  return rows.map((r) => ({ id: r.watchlist_id, name: r.name, count: Number(r.n) }));
}

export interface WatchlistEntry {
  securityId: string;
  ticker: string;
  name: string;
  position: number;
}

export async function watchlistEntries(watchlistId: string): Promise<WatchlistEntry[]> {
  const rows = await db()
    .selectFrom("watchlist_items as i")
    .innerJoin("market.securities as s", "s.security_id", "i.security_id")
    .select(["i.security_id", "s.ticker", "s.name", "i.position"])
    .where("i.watchlist_id", "=", watchlistId)
    .where("i.user_id", "=", OWNER_USER_ID)
    .orderBy("i.position")
    .orderBy("s.ticker")
    .execute();
  return rows.map((r) => ({
    securityId: r.security_id,
    ticker: r.ticker,
    name: r.name,
    position: r.position,
  }));
}

/** Watchlists that contain a security, for the ticker page's add/remove control. */
export async function watchlistsContaining(securityId: string): Promise<Set<string>> {
  const rows = await db()
    .selectFrom("watchlist_items")
    .select("watchlist_id")
    .where("security_id", "=", securityId)
    .where("user_id", "=", OWNER_USER_ID)
    .execute();
  return new Set(rows.map((r) => r.watchlist_id));
}

/** Next position at the end of a watchlist. */
export async function nextPosition(watchlistId: string): Promise<number> {
  const r = await sql<{ p: number | null }>`
    select max(position) as p from public.watchlist_items
    where watchlist_id = ${watchlistId} and user_id = ${OWNER_USER_ID}
  `.execute(db());
  return (r.rows[0]?.p ?? -1) + 1;
}
