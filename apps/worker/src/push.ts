import type { WorkerEnv } from "@market/config";
import { endpointPolicy, type PushSender, vapidSigningKey } from "@market/push";

/**
 * Web Push from the worker (Phase 2 step J2, ADR-038): the VAPID pair and contact from env, the
 * pair checked at startup (a mismatch would make every push service refuse us), and the
 * push-service allowlist (loopback only for tests).
 */
export function pushSenderFromEnv(env: WorkerEnv): PushSender | null {
  const { WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY, WEB_PUSH_CONTACT } = env;
  if (!WEB_PUSH_PUBLIC_KEY || !WEB_PUSH_PRIVATE_KEY || !WEB_PUSH_CONTACT) return null;
  const vapid = { publicKey: WEB_PUSH_PUBLIC_KEY, privateKey: WEB_PUSH_PRIVATE_KEY };
  return {
    vapid,
    contact: WEB_PUSH_CONTACT,
    signingKey: vapidSigningKey(vapid),
    allowEndpoint: endpointPolicy(env.WEB_PUSH_ALLOW_LOOPBACK),
  };
}
