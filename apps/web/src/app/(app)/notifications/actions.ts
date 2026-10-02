"use server";

import { OWNER_USER_ID } from "@market/config";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { requireFlag } from "../../../server/flags";

/**
 * Marks notifications read once they have been shown (called by the page after it renders).
 * The page itself is not refreshed, so what was new stays marked for this visit.
 */
export async function markNotificationsRead(ids: string[]): Promise<number> {
  await requireOwner();
  await requireFlag("notifications");
  const valid = ids.filter((id) => /^\d{1,18}$/.test(id)).slice(0, 200);
  if (valid.length === 0) return 0;
  const res = await db()
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", OWNER_USER_ID)
    .where("notification_id", "in", valid)
    .where("read_at", "is", null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/** Removes one notification; the alert and its history stay. */
export async function dismissNotification(form: FormData): Promise<void> {
  await requireOwner();
  await requireFlag("notifications");
  const id = form.get("id");
  if (typeof id === "string" && /^\d{1,18}$/.test(id)) {
    await db()
      .deleteFrom("notifications")
      .where("notification_id", "=", id)
      .where("user_id", "=", OWNER_USER_ID)
      .execute();
  }
  revalidatePath("/notifications");
  redirect("/notifications");
}
