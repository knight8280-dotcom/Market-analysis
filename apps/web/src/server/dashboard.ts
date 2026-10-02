import "server-only";
import { OWNER_USER_ID } from "@market/config";
import { sql } from "@market/db";
import { normalizeLayout, type Layout } from "../lib/dashboard";
import { db } from "./db";

/** The owner's dashboard layout, or the default one. */
export async function dashboardLayout(): Promise<Layout> {
  const row = await db()
    .selectFrom("dashboard_layouts")
    .select("layout")
    .where("user_id", "=", OWNER_USER_ID)
    .executeTakeFirst();
  return normalizeLayout(row?.layout ?? null);
}

export async function saveDashboardLayout(layout: Layout): Promise<void> {
  await db()
    .insertInto("dashboard_layouts")
    .values({ user_id: OWNER_USER_ID, layout: JSON.stringify(layout) })
    .onConflict((oc) =>
      oc.column("user_id").doUpdateSet({ layout: JSON.stringify(layout), updated_at: sql`now()` }),
    )
    .execute();
}
