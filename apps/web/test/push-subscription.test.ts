import { createECDH, randomBytes } from "node:crypto";
import { endpointPolicy } from "@market/push";
import { describe, expect, it } from "vitest";
import { deviceLabel } from "../src/lib/device-label";
import { parseSubscription } from "../src/lib/push-subscription";

/** Turning push on (Phase 2 step J2): what the server accepts from a browser. */
function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey(), auth: randomBytes(16) };
}
const allow = endpointPolicy(false);

describe("parseSubscription", () => {
  it("accepts a browser's subscription and stores its keys as base64url", () => {
    const { p256dh, auth } = browserKeys();
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc:def";
    // Some browsers pad, or use the standard alphabet: both read the same.
    const sent = {
      endpoint,
      keys: { p256dh: p256dh.toString("base64"), auth: auth.toString("base64") },
    };
    expect(parseSubscription(sent, allow)).toEqual({
      ok: true,
      subscription: {
        endpoint,
        p256dh: p256dh.toString("base64url"),
        auth: auth.toString("base64url"),
      },
    });
  });

  it("refuses other hosts, wrong keys and anything else", () => {
    const { p256dh, auth } = browserKeys();
    const keys = { p256dh: p256dh.toString("base64url"), auth: auth.toString("base64url") };
    expect(parseSubscription({ endpoint: "https://evil.example/push", keys }, allow)).toEqual({
      ok: false,
      error: "This browser's push service is not one the app sends to.",
    });
    expect(
      parseSubscription({ endpoint: "http://127.0.0.1:4100/push/a", keys }, allow),
    ).toMatchObject({ ok: false });
    expect(
      parseSubscription({ endpoint: "http://127.0.0.1:4100/push/a", keys }, endpointPolicy(true)),
    ).toMatchObject({ ok: true });
    const fcm = "https://fcm.googleapis.com/fcm/send/abc";
    for (const bad of [
      { ...keys, auth: randomBytes(8).toString("base64url") },
      { ...keys, p256dh: randomBytes(65).toString("base64url") },
      { ...keys, p256dh: "not base64!" },
    ]) {
      expect(parseSubscription({ endpoint: fcm, keys: bad }, allow)).toEqual({
        ok: false,
        error: "The subscription's keys are not in the expected form.",
      });
    }
    for (const junk of [null, "x", { endpoint: fcm }, { endpoint: 5, keys }]) {
      expect(parseSubscription(junk, allow)).toEqual({
        ok: false,
        error: "That is not a push subscription.",
      });
    }
  });
});

describe("deviceLabel", () => {
  it("names common browsers and systems", () => {
    const cases: [string, string][] = [
      [
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
        "Chrome on Android",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
        "Safari on iPhone",
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
        "Edge on Windows",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0",
        "Firefox on Mac",
      ],
      [
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
        "Chrome on Linux",
      ],
    ];
    for (const [ua, label] of cases) expect(deviceLabel(ua), ua).toBe(label);
    expect(deviceLabel(null)).toBe("A browser");
  });
});
