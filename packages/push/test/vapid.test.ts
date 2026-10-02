import { describe, expect, it } from "vitest";
import {
  generateVapidKeys,
  VAPID_TOKEN_SECONDS,
  vapidAuthorization,
  vapidSigningKey,
} from "../src/vapid";
import { checkVapidAuthorization } from "../src/verify";

const NOW = new Date("2026-10-02T12:00:00Z");

describe("VAPID (RFC 8292)", () => {
  it("signs a token for the push service's origin that our public key verifies", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc:def",
      keys,
      "mailto:owner@example.invalid",
      NOW,
    );
    const token = checkVapidAuthorization(header);
    expect(token.valid).toBe(true);
    expect(token.publicKey).toBe(keys.publicKey);
    expect(token.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(token.claims).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: NOW.getTime() / 1000 + VAPID_TOKEN_SECONDS,
      sub: "mailto:owner@example.invalid",
    });
    // Push services refuse tokens that last more than a day.
    expect(VAPID_TOKEN_SECONDS).toBeLessThanOrEqual(24 * 3600);
    // Naming another key pair's public key does not verify.
    const forged = header.replace(keys.publicKey, generateVapidKeys().publicKey);
    expect(checkVapidAuthorization(forged).valid).toBe(false);
  });

  it("checks that the two keys belong together", () => {
    const a = generateVapidKeys();
    const b = generateVapidKeys();
    expect(() => vapidSigningKey({ publicKey: a.publicKey, privateKey: b.privateKey })).toThrow(
      /does not belong/,
    );
    expect(() => vapidSigningKey({ publicKey: "AAAA", privateKey: a.privateKey })).toThrow(
      /65-byte/,
    );
    expect(() => vapidSigningKey({ publicKey: a.publicKey, privateKey: "AAAA" })).toThrow(
      /32 bytes/,
    );
  });
});
