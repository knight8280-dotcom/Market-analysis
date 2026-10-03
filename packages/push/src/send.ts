import type { KeyObject } from "node:crypto";
import { encryptPayload, type SubscriptionKeys } from "./encrypt";
import { endpointLabel, isPushServiceEndpoint } from "./hosts";
import { vapidAuthorization, type VapidKeys } from "./vapid";

/** A browser's subscription, as it reports it (`PushSubscription.toJSON()`). */
export interface PushTarget extends SubscriptionKeys {
  endpoint: string;
}

export interface PushSender {
  vapid: VapidKeys;
  /** mailto: or https: address given to push services. */
  contact: string;
  signingKey?: KeyObject;
  fetch?: typeof fetch;
  /** Which endpoints may be contacted; the push-service allowlist unless a test says otherwise. */
  allowEndpoint?: (endpoint: string) => boolean;
  timeoutMs?: number;
}

export interface PushRequest {
  payload: unknown;
  /** Seconds the push service keeps an undelivered message (the device may be off). */
  ttlSeconds: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** A newer message with the same topic replaces an undelivered older one. */
  topic?: string;
  now: Date;
}

export type PushResult =
  | { outcome: "sent"; status: number }
  /** The subscription no longer exists (the browser unsubscribed or expired it): delete it. */
  | { outcome: "gone"; status: number }
  /** Try again later: the push service is busy or failing, or the network is. */
  | { outcome: "retry"; status: number | null; detail: string; retryAfterSeconds?: number }
  /** Our request is wrong (bad keys, signature, size): retrying will not help. */
  | { outcome: "rejected"; status: number | null; detail: string };

const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Sends one message to one subscription (RFC 8030 with RFC 8291 encryption and RFC 8292 VAPID).
 * Never follows a redirect, so a push service cannot point us at another host.
 */
export async function sendPush(
  target: PushTarget,
  request: PushRequest,
  sender: PushSender,
): Promise<PushResult> {
  const allowed = sender.allowEndpoint ?? isPushServiceEndpoint;
  if (!allowed(target.endpoint)) {
    return {
      outcome: "rejected",
      status: null,
      detail: `${endpointLabel(target.endpoint)} is not an allowed push service`,
    };
  }
  if (request.topic !== undefined && !TOPIC.test(request.topic)) {
    throw new Error("A push topic is 1 to 32 base64url characters");
  }
  // A plain Uint8Array: what both Node's and the DOM's fetch types take as a body.
  const body = new Uint8Array(encryptPayload(Buffer.from(JSON.stringify(request.payload)), target));
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization(
      target.endpoint,
      sender.vapid,
      sender.contact,
      request.now,
      sender.signingKey,
    ),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(Math.max(0, Math.floor(request.ttlSeconds))),
    Urgency: request.urgency ?? "normal",
  };
  if (request.topic) headers.Topic = request.topic;

  let res: Response;
  try {
    res = await (sender.fetch ?? fetch)(target.endpoint, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(sender.timeoutMs ?? 15_000),
    });
  } catch (err) {
    const why = err instanceof Error ? err.name : "error";
    return { outcome: "retry", status: null, detail: `no response from the push service (${why})` };
  }
  const detail = async () => (await res.text().catch(() => "")).slice(0, 200);
  if (res.status >= 200 && res.status < 300) return { outcome: "sent", status: res.status };
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel();
    return { outcome: "gone", status: res.status };
  }
  if (res.status === 429 || res.status >= 500) {
    const after = Number(res.headers.get("retry-after"));
    return {
      outcome: "retry",
      status: res.status,
      detail: await detail(),
      ...(Number.isFinite(after) && after > 0 ? { retryAfterSeconds: after } : {}),
    };
  }
  return { outcome: "rejected", status: res.status, detail: await detail() };
}
