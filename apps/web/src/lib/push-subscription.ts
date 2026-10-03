import { z } from "zod";

/**
 * A browser's push subscription as it reports it (`PushSubscription.toJSON()`), checked before
 * it is stored (Phase 2 step J2): an endpoint the policy allows, an uncompressed P-256 public
 * key and a 16-byte secret. Keys are stored as base64url without padding.
 */
const Json = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function base64url(text: string): Buffer | null {
  const normalized = text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return /^[A-Za-z0-9_-]+$/.test(normalized) ? Buffer.from(normalized, "base64url") : null;
}

export function parseSubscription(
  input: unknown,
  allowEndpoint: (endpoint: string) => boolean,
): { ok: true; subscription: StoredSubscription } | { ok: false; error: string } {
  const json = Json.safeParse(input);
  if (!json.success) return { ok: false, error: "That is not a push subscription." };
  const { endpoint, keys } = json.data;
  if (!allowEndpoint(endpoint)) {
    return { ok: false, error: "This browser's push service is not one the app sends to." };
  }
  const p256dh = base64url(keys.p256dh);
  const auth = base64url(keys.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04 || !auth || auth.length !== 16) {
    return { ok: false, error: "The subscription's keys are not in the expected form." };
  }
  return {
    ok: true,
    subscription: {
      endpoint,
      p256dh: p256dh.toString("base64url"),
      auth: auth.toString("base64url"),
    },
  };
}

/** Whose push service a device uses, for the device list. */
function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
}

export function pushServiceName(endpoint: string): string {
  const host = hostOf(endpoint);
  if (!host) return "an unknown service";
  if (host === "fcm.googleapis.com") return "Google";
  if (host === "updates.push.services.mozilla.com") return "Mozilla";
  if (host === "web.push.apple.com") return "Apple";
  if (host.endsWith(".notify.windows.com")) return "Microsoft";
  if (host === "127.0.0.1" || host === "localhost") return "a test service";
  return host;
}
