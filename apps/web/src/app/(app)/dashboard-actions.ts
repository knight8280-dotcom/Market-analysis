"use server";

import { OWNER_USER_ID } from "@market/config";
import { revalidatePath } from "next/cache";
import { applyChange, LayoutChange, type Layout } from "../../lib/dashboard";
import { requireOwner } from "../../server/auth/owner";
import { dashboardLayout, saveDashboardLayout } from "../../server/dashboard";
import { db } from "../../server/db";
import { flagEnabled } from "../../server/flags";

/**
 * Applies one change from the dashboard editor (Phase 2 step F2) and returns the saved layout.
 * Called from the page without a navigation, so keyboard focus stays where it was.
 */
export async function changeDashboard(raw: unknown): Promise<Layout | null> {
  await requireOwner();
  if (!(await flagEnabled("dashboard"))) return null;
  const change = LayoutChange.safeParse(raw);
  if (!change.success) return null;
  if (change.data.type === "screen") {
    const owned = await db()
      .selectFrom("saved_screens")
      .select("screen_id")
      .where("screen_id", "=", change.data.screenId)
      .where("user_id", "=", OWNER_USER_ID)
      .executeTakeFirst();
    if (!owned) return null;
  }
  const layout = applyChange(await dashboardLayout(), change.data);
  await saveDashboardLayout(layout);
  revalidatePath("/");
  return layout;
}
