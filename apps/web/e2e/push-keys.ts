import { createECDH, createHash } from "node:crypto";

/**
 * A VAPID key pair for the tests only, the same in every process (the web server, the specs and
 * the worker CLI): derived from a fixed phrase, never stored. It signs messages to the tests'
 * stand-in push service and nothing else.
 */
export function e2eVapid(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(createHash("sha256").update("market-analysis e2e vapid pair").digest());
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

export const E2E_PUSH_CONTACT = "mailto:owner@e2e.invalid";

/** The WEB_PUSH_* settings for processes under test; loopback is allowed because APP_ENV=test. */
export function e2ePushEnv(): Record<string, string> {
  const { publicKey, privateKey } = e2eVapid();
  return {
    WEB_PUSH_PUBLIC_KEY: publicKey,
    WEB_PUSH_PRIVATE_KEY: privateKey,
    WEB_PUSH_CONTACT: E2E_PUSH_CONTACT,
    WEB_PUSH_ALLOW_LOOPBACK: "true",
  };
}
