"use server";

import { OWNER_USER_ID } from "@market/config";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "../../../server/audit";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { findSecurity } from "../../../server/market";
import { nextPosition } from "../../../server/watchlists";

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};
const id = (form: FormData, name: string) => {
  const v = text(form, name);
  return /^\d{1,18}$/.test(v) ? v : null;
};
const back = (watchlistId: string | null, error?: string) =>
  redirect(
    `/watchlists${watchlistId ? `?id=${watchlistId}` : ""}${error ? `${watchlistId ? "&" : "?"}error=${error}` : ""}`,
  );

/** Only the owner's own watchlist ids pass. */
async function owned(watchlistId: string | null): Promise<string | null> {
  if (!watchlistId) return null;
  const row = await db()
    .selectFrom("watchlists")
    .select("watchlist_id")
    .where("watchlist_id", "=", watchlistId)
    .where("user_id", "=", OWNER_USER_ID)
    .executeTakeFirst();
  return row?.watchlist_id ?? null;
}

export async function createWatchlist(form: FormData): Promise<void> {
  await requireOwner();
  const name = text(form, "name").slice(0, 100);
  if (!name) back(null, "name");
  const row = await db()
    .insertInto("watchlists")
    .values({ user_id: OWNER_USER_ID, name })
    .onConflict((oc) => oc.columns(["user_id", "name"]).doUpdateSet({ updated_at: new Date() }))
    .returning("watchlist_id")
    .executeTakeFirstOrThrow();
  await audit("watchlist.create", { type: "watchlist", id: row.watchlist_id }, { name });
  revalidatePath("/watchlists");
  back(row.watchlist_id);
}

export async function renameWatchlist(form: FormData): Promise<void> {
  await requireOwner();
  const wid = await owned(id(form, "id"));
  const name = text(form, "name").slice(0, 100);
  if (!wid || !name) back(wid, "name");
  try {
    await db()
      .updateTable("watchlists")
      .set({ name, updated_at: new Date() })
      .where("watchlist_id", "=", wid)
      .where("user_id", "=", OWNER_USER_ID)
      .execute();
  } catch {
    back(wid, "duplicate");
  }
  await audit("watchlist.rename", { type: "watchlist", id: wid! }, { name });
  revalidatePath("/watchlists");
  back(wid);
}

export async function deleteWatchlist(form: FormData): Promise<void> {
  await requireOwner();
  const wid = await owned(id(form, "id"));
  if (wid) {
    await db()
      .deleteFrom("watchlists")
      .where("watchlist_id", "=", wid)
      .where("user_id", "=", OWNER_USER_ID)
      .execute();
    await audit("watchlist.delete", { type: "watchlist", id: wid });
  }
  revalidatePath("/watchlists");
  back(null);
}

export async function addToWatchlist(form: FormData): Promise<void> {
  await requireOwner();
  const wid = await owned(id(form, "id"));
  const returnTo = text(form, "returnTo");
  const security = await findSecurity(db(), text(form, "ticker").toUpperCase());
  if (!wid) back(null);
  if (!security) back(wid, "ticker");
  await db()
    .insertInto("watchlist_items")
    .values({
      watchlist_id: wid!,
      user_id: OWNER_USER_ID,
      security_id: security!.securityId,
      position: await nextPosition(wid!),
    })
    .onConflict((oc) => oc.columns(["watchlist_id", "security_id"]).doNothing())
    .execute();
  await audit("watchlist.add", { type: "watchlist", id: wid! }, { ticker: security!.ticker });
  revalidatePath("/watchlists");
  if (returnTo.startsWith("/stocks/")) {
    revalidatePath(returnTo);
    redirect(returnTo);
  }
  back(wid);
}

export async function removeFromWatchlist(form: FormData): Promise<void> {
  await requireOwner();
  const wid = await owned(id(form, "id"));
  const sid = id(form, "securityId");
  const returnTo = text(form, "returnTo");
  if (wid && sid) {
    await db()
      .deleteFrom("watchlist_items")
      .where("watchlist_id", "=", wid)
      .where("security_id", "=", sid)
      .where("user_id", "=", OWNER_USER_ID)
      .execute();
    await audit("watchlist.remove", { type: "watchlist", id: wid }, { securityId: sid });
  }
  revalidatePath("/watchlists");
  if (returnTo.startsWith("/stocks/")) {
    revalidatePath(returnTo);
    redirect(returnTo);
  }
  back(wid);
}

/**
 * Moves an item one place up or down (button-based reordering: no drag-only interaction,
 * WCAG 2.5.7). Positions are renumbered 0..n-1 in the new order.
 */
export async function moveInWatchlist(form: FormData): Promise<void> {
  await requireOwner();
  const wid = await owned(id(form, "id"));
  const sid = id(form, "securityId");
  const dir = text(form, "dir") === "up" ? -1 : 1;
  if (!wid || !sid) back(wid);
  await db()
    .transaction()
    .execute(async (trx) => {
      const items = await trx
        .selectFrom("watchlist_items as i")
        .innerJoin("market.securities as s", "s.security_id", "i.security_id")
        .select(["i.security_id"])
        .where("i.watchlist_id", "=", wid!)
        .where("i.user_id", "=", OWNER_USER_ID)
        .orderBy("i.position")
        .orderBy("s.ticker")
        .execute();
      const order = items.map((r) => r.security_id);
      const i = order.indexOf(sid!);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j]!, order[i]!];
      for (const [position, securityId] of order.entries()) {
        await trx
          .updateTable("watchlist_items")
          .set({ position })
          .where("watchlist_id", "=", wid!)
          .where("security_id", "=", securityId)
          .execute();
      }
    });
  revalidatePath("/watchlists");
  back(wid);
}
