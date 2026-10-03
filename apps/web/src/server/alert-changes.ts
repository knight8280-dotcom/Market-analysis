import "server-only";
import { OWNER_USER_ID } from "@market/config";
import { audit } from "./audit";
import { db } from "./db";

/**
 * Changes to one of the owner's alerts, shared by the pages' Server Actions and the API the
 * push notifications' buttons call (Phase 2 step J2). Each returns false when no such alert
 * exists, and is audited.
 */
export async function snoozeOwnerAlert(
  id: string,
  hours: number,
  via?: "push",
  now = new Date(),
): Promise<boolean> {
  const until = hours === 0 ? null : new Date(now.getTime() + hours * 3_600_000);
  const res = await db()
    .updateTable("alerts")
    .set({ snoozed_until: until, updated_at: now })
    .where("alert_id", "=", id)
    .where("user_id", "=", OWNER_USER_ID)
    .executeTakeFirst();
  if (res.numUpdatedRows === 0n) return false;
  await audit(
    until ? "alert.snooze" : "alert.unsnooze",
    { type: "alert", id },
    { ...(until ? { until: until.toISOString() } : {}), ...(via ? { via } : {}) },
  );
  return true;
}

/** Deletes the alert with its events and notifications. */
export async function deleteOwnerAlert(id: string, via?: "push"): Promise<boolean> {
  const res = await db()
    .deleteFrom("alerts")
    .where("alert_id", "=", id)
    .where("user_id", "=", OWNER_USER_ID)
    .executeTakeFirst();
  if (res.numDeletedRows === 0n) return false;
  await audit("alert.delete", { type: "alert", id }, via ? { via } : {});
  return true;
}
