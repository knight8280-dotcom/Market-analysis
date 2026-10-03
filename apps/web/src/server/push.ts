import "server-only";
import { loadWebEnv, OWNER_USER_ID } from "@market/config";
import { endpointPolicy, type PushSender, sendPush, vapidSigningKey } from "@market/push";
import { audit } from "./audit";
import { db } from "./db";

/**
 * Web Push in the web app (Phase 2 step J2, ADR-038): the public key browsers subscribe with,
 * the devices that turned push on, and the "test notification" button. Alert notifications
 * themselves are sent by the worker.
 */
export interface PushConfig {
  publicKey: string;
  allowEndpoint: (endpoint: string) => boolean;
  sender: PushSender;
}

/** Null when the WEB_PUSH_* settings are not in .env. */
export function pushConfig(): PushConfig | null {
  const env = loadWebEnv();
  const { WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY, WEB_PUSH_CONTACT } = env;
  if (!WEB_PUSH_PUBLIC_KEY || !WEB_PUSH_PRIVATE_KEY || !WEB_PUSH_CONTACT) return null;
  const vapid = { publicKey: WEB_PUSH_PUBLIC_KEY, privateKey: WEB_PUSH_PRIVATE_KEY };
  const allowEndpoint = endpointPolicy(env.WEB_PUSH_ALLOW_LOOPBACK);
  return {
    publicKey: WEB_PUSH_PUBLIC_KEY,
    allowEndpoint,
    sender: { vapid, contact: WEB_PUSH_CONTACT, signingKey: vapidSigningKey(vapid), allowEndpoint },
  };
}

export interface PushDevice {
  id: string;
  device: string;
  endpoint: string;
  createdAt: Date;
  lastSentAt: Date | null;
  lastError: string | null;
}

export async function pushDevices(): Promise<PushDevice[]> {
  const rows = await db()
    .selectFrom("push_subscriptions")
    .select(["subscription_id", "device", "endpoint", "created_at", "last_sent_at", "last_error"])
    .where("user_id", "=", OWNER_USER_ID)
    .orderBy("created_at")
    .execute();
  return rows.map((r) => ({
    id: r.subscription_id,
    device: r.device,
    endpoint: r.endpoint,
    createdAt: r.created_at,
    lastSentAt: r.last_sent_at,
    lastError: r.last_error,
  }));
}

/** More than enough for one person's computers and phones; stops a runaway loop filling up. */
export const MAX_DEVICES = 20;

export type TestOutcome = "sent" | "gone" | "failed" | "not_configured" | "unknown";

/** Sends a test notification to one device and records the result like an alert's. */
export async function sendTestNotification(
  id: string,
): Promise<{ outcome: TestOutcome; detail?: string }> {
  const config = pushConfig();
  if (!config) return { outcome: "not_configured" };
  const device = await db()
    .selectFrom("push_subscriptions")
    .select(["subscription_id", "endpoint", "p256dh", "auth"])
    .where("subscription_id", "=", id)
    .where("user_id", "=", OWNER_USER_ID)
    .executeTakeFirst();
  if (!device) return { outcome: "unknown" };
  const now = new Date();
  const result = await sendPush(
    device,
    {
      payload: {
        v: 1,
        title: "Test notification",
        body: "Push notifications from Market Analysis work on this device.",
        url: "/settings#push",
        tag: "test",
      },
      ttlSeconds: 600,
      topic: "test",
      now,
    },
    config.sender,
  );
  const row = db().updateTable("push_subscriptions").where("subscription_id", "=", id);
  await audit("push.test", { type: "push_subscription", id }, { outcome: result.outcome });
  if (result.outcome === "sent") {
    await row.set({ last_sent_at: now, failures: 0, last_error: null }).execute();
    return { outcome: "sent" };
  }
  if (result.outcome === "gone") {
    await db().deleteFrom("push_subscriptions").where("subscription_id", "=", id).execute();
    return { outcome: "gone" };
  }
  const detail = `${result.status ?? "no answer"} ${result.detail}`.trim().slice(0, 300);
  await row.set((eb) => ({ failures: eb("failures", "+", 1), last_error: detail })).execute();
  return { outcome: "failed", detail };
}
