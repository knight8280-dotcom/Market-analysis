"use server";

import { OWNER_USER_ID } from "@market/config";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { deviceLabel } from "../../../lib/device-label";
import { parseSubscription } from "../../../lib/push-subscription";
import { audit } from "../../../server/audit";
import { requireOwner } from "../../../server/auth/owner";
import { db } from "../../../server/db";
import { flagEnabled } from "../../../server/flags";
import {
  MAX_DEVICES,
  pushConfig,
  sendTestNotification,
  type TestOutcome,
} from "../../../server/push";

export type PushActionResult = { ok: true; id?: string } | { ok: false; error: string };

/** Stores this browser's subscription (Phase 2 step J2); the same endpoint is updated in place. */
export async function savePushSubscription(input: unknown): Promise<PushActionResult> {
  await requireOwner();
  const config = pushConfig();
  if (!config || !(await flagEnabled("push"))) {
    return { ok: false, error: "Push notifications are not set up in the app." };
  }
  const parsed = parseSubscription(input, config.allowEndpoint);
  if (!parsed.ok) return parsed;
  const { endpoint, p256dh, auth } = parsed.subscription;
  const known = await db()
    .selectFrom("push_subscriptions")
    .select("subscription_id")
    .where("endpoint", "=", endpoint)
    .executeTakeFirst();
  if (!known) {
    const { n } = await db()
      .selectFrom("push_subscriptions")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("user_id", "=", OWNER_USER_ID)
      .executeTakeFirstOrThrow();
    if (Number(n) >= MAX_DEVICES) {
      return { ok: false, error: `At most ${MAX_DEVICES} devices; remove one first.` };
    }
  }
  const device = deviceLabel((await headers()).get("user-agent"));
  const row = await db()
    .insertInto("push_subscriptions")
    .values({ user_id: OWNER_USER_ID, endpoint, p256dh, auth, device })
    .onConflict((oc) =>
      oc.column("endpoint").doUpdateSet({
        user_id: OWNER_USER_ID,
        p256dh,
        auth,
        device,
        failures: 0,
        last_error: null,
      }),
    )
    .returning("subscription_id")
    .executeTakeFirstOrThrow();
  await audit("push.subscribe", { type: "push_subscription", id: row.subscription_id }, { device });
  revalidatePath("/settings");
  return { ok: true, id: row.subscription_id };
}

/** Removes a device by its id (Settings) or by its endpoint (this browser turning push off). */
export async function removePushSubscription(
  which: { id: string } | { endpoint: string },
): Promise<PushActionResult> {
  await requireOwner();
  let q = db().deleteFrom("push_subscriptions").where("user_id", "=", OWNER_USER_ID);
  if ("id" in which) {
    if (!/^\d{1,18}$/.test(which.id)) return { ok: false, error: "No such device." };
    q = q.where("subscription_id", "=", which.id);
  } else {
    q = q.where("endpoint", "=", String(which.endpoint).slice(0, 2048));
  }
  const removed = await q.returning("subscription_id").execute();
  for (const r of removed) {
    await audit("push.unsubscribe", { type: "push_subscription", id: r.subscription_id });
  }
  revalidatePath("/settings");
  return { ok: true };
}

const TEST_MESSAGES: Record<TestOutcome, string> = {
  sent: "Sent. It should appear on that device in a few seconds.",
  gone: "That device's subscription has expired and was removed; turn push on there again.",
  failed: "The push service did not take it",
  not_configured: "Push notifications are not set up in the app.",
  unknown: "No such device.",
};

export async function sendTestPush(id: string): Promise<{ ok: boolean; message: string }> {
  await requireOwner();
  if (!/^\d{1,18}$/.test(id)) return { ok: false, message: TEST_MESSAGES.unknown };
  const result = await sendTestNotification(id);
  revalidatePath("/settings");
  return {
    ok: result.outcome === "sent",
    message:
      result.outcome === "failed"
        ? `${TEST_MESSAGES.failed}: ${result.detail ?? "no reason given"}.`
        : TEST_MESSAGES[result.outcome],
  };
}

/** Which stored device, if any, is this browser (its endpoint stays out of the page). */
export async function pushDeviceFor(endpoint: string): Promise<string | null> {
  await requireOwner();
  const row = await db()
    .selectFrom("push_subscriptions")
    .select("subscription_id")
    .where("endpoint", "=", String(endpoint).slice(0, 2048))
    .where("user_id", "=", OWNER_USER_ID)
    .executeTakeFirst();
  return row?.subscription_id ?? null;
}
