import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPayload } from "../src/encrypt";
import { endpointLabel, endpointPolicy, isPushServiceEndpoint } from "../src/hosts";
import { type PushRequest, sendPush } from "../src/send";
import { generateVapidKeys } from "../src/vapid";
import { checkVapidAuthorization } from "../src/verify";

const NOW = new Date("2026-10-02T12:00:00Z");
const vapid = generateVapidKeys();
const contact = "mailto:owner@example.invalid";

function browser(endpoint = "https://fcm.googleapis.com/fcm/send/token-123") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    target: {
      endpoint,
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

/** A stand-in push service: records each request and answers with the given response. */
function pushService(respond: () => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    seen.push({
      url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      init: init ?? {},
    });
    return Promise.resolve(respond());
  };
  return { seen, fetch };
}

const request: PushRequest = {
  payload: { title: "TEST_DIV crossed $50", url: "/alerts/7" },
  ttlSeconds: 3600,
  urgency: "high",
  topic: "alert-7",
  now: NOW,
};

describe("sendPush", () => {
  it("posts an encrypted, VAPID-signed message the browser can read", async () => {
    const { target, privateKey } = browser();
    const service = pushService(() => new Response(null, { status: 201 }));
    const result = await sendPush(target, request, { vapid, contact, fetch: service.fetch });
    expect(result).toEqual({ outcome: "sent", status: 201 });

    const [sent] = service.seen;
    expect(sent!.url).toBe(target.endpoint);
    expect(sent!.init.method).toBe("POST");
    expect(sent!.init.redirect).toBe("error");
    const headers = sent!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "3600",
      Urgency: "high",
      Topic: "alert-7",
    });
    const token = checkVapidAuthorization(headers.Authorization!);
    expect(token.valid).toBe(true);
    expect(token.publicKey).toBe(vapid.publicKey);
    expect(token.claims.aud).toBe("https://fcm.googleapis.com");
    const text = decryptPayload(sent!.init.body as Uint8Array, { ...target, privateKey });
    expect(JSON.parse(text.toString())).toEqual(request.payload);
  });

  it("reads the push service's answer", async () => {
    const { target } = browser();
    const answer = async (res: Response) =>
      sendPush(target, request, {
        vapid,
        contact,
        fetch: pushService(() => res).fetch,
      });
    expect(await answer(new Response(null, { status: 410 }))).toEqual({
      outcome: "gone",
      status: 410,
    });
    expect(await answer(new Response(null, { status: 404 }))).toEqual({
      outcome: "gone",
      status: 404,
    });
    expect(
      await answer(new Response("slow down", { status: 429, headers: { "Retry-After": "30" } })),
    ).toEqual({ outcome: "retry", status: 429, detail: "slow down", retryAfterSeconds: 30 });
    expect(await answer(new Response("oops", { status: 503 }))).toMatchObject({
      outcome: "retry",
      status: 503,
    });
    expect(await answer(new Response("bad jwt", { status: 403 }))).toEqual({
      outcome: "rejected",
      status: 403,
      detail: "bad jwt",
    });
    expect(await answer(new Response("too big", { status: 413 }))).toMatchObject({
      outcome: "rejected",
      status: 413,
    });
  });

  it("treats no answer as a reason to try again", async () => {
    const { target } = browser();
    const fetch = (() => Promise.reject(new TypeError("fetch failed"))) as typeof globalThis.fetch;
    expect(await sendPush(target, request, { vapid, contact, fetch })).toEqual({
      outcome: "retry",
      status: null,
      detail: "no response from the push service (TypeError)",
    });
  });

  it("contacts only allowlisted push services", async () => {
    const { target } = browser("https://push.example.invalid/token");
    const service = pushService(() => new Response(null, { status: 201 }));
    expect(await sendPush(target, request, { vapid, contact, fetch: service.fetch })).toEqual({
      outcome: "rejected",
      status: null,
      detail: "push.example.invalid is not an allowed push service",
    });
    expect(service.seen).toHaveLength(0);
    await expect(
      sendPush(
        browser().target,
        { ...request, topic: "not a topic!" },
        { vapid, contact, fetch: service.fetch },
      ),
    ).rejects.toThrow(/topic/);
  });
});

describe("push service allowlist", () => {
  it("knows the browsers' push services and nothing else", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com/wp/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QGabc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(isPushServiceEndpoint(ok), ok).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pw@fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com.evil.example/abc",
      "https://evil.example/fcm.googleapis.com",
      "https://notify.windows.com/w/abc",
      "https://evilnotify.windows.com.example/w",
      "https://127.0.0.1/push",
      "not a url",
    ]) {
      expect(isPushServiceEndpoint(bad), bad).toBe(false);
    }
  });

  it("lets loopback in only when the test switch is on", () => {
    expect(endpointPolicy(false)("http://127.0.0.1:4100/push/abc")).toBe(false);
    expect(endpointPolicy(true)("http://127.0.0.1:4100/push/abc")).toBe(true);
    expect(endpointPolicy(true)("http://localhost:4100/push/abc")).toBe(true);
    expect(endpointPolicy(true)("http://192.168.1.10:4100/push/abc")).toBe(false);
    expect(endpointPolicy(true)("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
  });

  it("labels an endpoint by host only, never its token", () => {
    expect(endpointLabel("https://fcm.googleapis.com/fcm/send/secret-token")).toBe(
      "fcm.googleapis.com",
    );
  });
});
