import { createECDH, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OWNER_USER_ID } from "@market/config";
import { sql } from "@market/db";
import {
  checkVapidAuthorization,
  decryptPayload,
  endpointPolicy,
  generateVapidKeys,
  vapidSigningKey,
} from "@market/push";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "./helpers/context";

/**
 * Push notifications for fired alerts (Phase 2 step J2) against a real database, with a local
 * HTTP server standing in for the browsers' push services: it answers by path (ok, gone, busy,
 * refuse), checks our VAPID signature and decrypts each message the way the browser would.
 */
interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
let server: Server;
let base: string;
let received: Received[] = [];
let h: Harness;
const vapid = generateVapidKeys();
const sender = () => ({
  vapid,
  contact: "mailto:owner@test.invalid",
  signingKey: vapidSigningKey(vapid),
  allowEndpoint: endpointPolicy(true),
});
const browsers = new Map<string, { p256dh: string; auth: string; privateKey: string }>();

function deliver(opts: { push?: boolean; dailyCap?: number } = {}) {
  h.ctx.alertDelivery = {
    mailer: null,
    to: null,
    from: "Market Analysis <onboarding@resend.dev>",
    dailyCap: opts.dailyCap ?? 20,
    push: opts.push === false ? null : sender(),
  };
}

/** A browser that turned push on: its keys, and its row as the web app stores it. */
async function device(name: string, label = "Chrome on Android") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
  const endpoint = `${base}/push/${name}`;
  browsers.set(endpoint, keys);
  await h.t.db
    .insertInto("push_subscriptions")
    .values({
      user_id: OWNER_USER_ID,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      device: label,
    })
    .execute();
  return endpoint;
}

async function crossing(ticker: string, channels: string[]): Promise<string> {
  await sql`
    insert into market.securities (ticker, name, asset_class)
    values (${ticker}, ${`${ticker} Corp`}, 'equity')
  `.execute(h.t.db);
  for (const [date, close] of [
    ["2026-09-29", 99],
    ["2026-09-30", 101],
  ] as const) {
    await sql`
      insert into market.prices_daily (security_id, date, source, open, high, low, close, volume)
      select security_id, ${date}::date, 'synthetic', ${close}, ${close}, ${close}, ${close}, 1000
      from market.securities where ticker = ${ticker}
    `.execute(h.t.db);
  }
  const r = await sql<{ alert_id: string }>`
    insert into public.alerts (user_id, security_id, kind, params, channels)
    select ${OWNER_USER_ID}, security_id, 'price_above', '{"price": 100}'::jsonb,
      ${channels}::text[]
    from market.securities where ticker = ${ticker}
    returning alert_id::text
  `.execute(h.t.db);
  return r.rows[0]!.alert_id;
}

const eventOf = (alertId: string) =>
  h.t.db
    .selectFrom("alert_events")
    .select(["event_id", "delivery_status", "error", "push_status", "push_error", "push_sent_at"])
    .where("alert_id", "=", alertId)
    .executeTakeFirstOrThrow();

const devices = () =>
  h.t.db
    .selectFrom("push_subscriptions")
    .select(["endpoint", "failures", "last_error", "last_sent_at"])
    .orderBy("subscription_id")
    .execute();

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      received.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
      if (path.includes("/gone")) res.writeHead(410).end();
      else if (path.includes("/busy")) res.writeHead(503, { "Retry-After": "60" }).end("busy");
      else if (path.includes("/refuse")) res.writeHead(403).end("bad jwt");
      else res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 19:00 EDT on Wednesday 2026-09-30.
  h = await harness({ now: "2026-09-30T23:00:00Z" });
});

afterAll(async () => {
  server.close();
  await h.t.drop();
});

beforeEach(async () => {
  received = [];
  deliver();
  await h.t.db.deleteFrom("push_subscriptions").execute();
});

describe("push notifications for fired alerts", () => {
  it("reach every device, encrypted and signed; devices the service forgot are removed", async () => {
    const alertId = await crossing("TEST_PUSH", ["push"]);
    const phone = await device("ok-phone");
    await device("gone-old-laptop", "Firefox on Linux");

    const result = (await h.run("evaluate-alerts")) as Record<string, unknown>;
    expect(result).toMatchObject({
      fired: 1,
      // Email was not chosen for this alert.
      delivery: { sent: 0, suppressed: 1 },
      push: { sent: 1, removed: 1, failed: 0, retry: 0 },
    });

    expect(received.map((r) => r.path)).toEqual(["/push/ok-phone", "/push/gone-old-laptop"]);
    const message = received[0]!;
    expect(message.headers).toMatchObject({
      ttl: "86400",
      urgency: "normal",
      topic: `alert-${alertId}`,
      "content-encoding": "aes128gcm",
    });
    const token = checkVapidAuthorization(message.headers.authorization!);
    expect(token.valid).toBe(true);
    expect(token.publicKey).toBe(vapid.publicKey);
    expect(token.claims).toMatchObject({ aud: base, sub: "mailto:owner@test.invalid" });
    const payload = JSON.parse(
      decryptPayload(message.body, { ...browsers.get(phone)! }).toString(),
    ) as Record<string, unknown>;
    const event = await eventOf(alertId);
    expect(payload).toEqual({
      v: 1,
      title: "[SAMPLE DATA] TEST_PUSH closed above $100.00",
      body: expect.stringContaining("TEST_PUSH closed at $101.00") as unknown,
      url: `/alerts/${alertId}`,
      tag: `alert-${alertId}`,
      alertId: Number(alertId),
      eventId: Number(event.event_id),
    });
    expect(payload.body).toContain("SAMPLE DATA");

    expect(event).toMatchObject({
      delivery_status: "suppressed",
      error: "email not chosen for this alert",
      push_status: "sent",
      push_error: null,
    });
    expect(event.push_sent_at).not.toBeNull();
    const left = await devices();
    expect(left.map((d) => d.endpoint)).toEqual([phone]);
    expect(left[0]!.last_sent_at).not.toBeNull();

    // Nothing is pushed twice.
    received = [];
    expect(await h.run("evaluate-alerts")).toMatchObject({ fired: 0, push: { sent: 0 } });
    expect(received).toHaveLength(0);
  });

  it("records why nothing was pushed", async () => {
    await device("ok-phone");
    const emailOnly = await crossing("TEST_PUSH_EMAIL", ["email"]);
    await h.run("evaluate-alerts");
    expect(await eventOf(emailOnly)).toMatchObject({
      push_status: "suppressed",
      push_error: "push not chosen for this alert",
    });

    deliver({ push: false });
    const unconfigured = await crossing("TEST_PUSH_NOKEYS", ["email", "push"]);
    await h.run("evaluate-alerts");
    expect(await eventOf(unconfigured)).toMatchObject({
      push_status: "suppressed",
      push_error:
        "push not configured (WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY, WEB_PUSH_CONTACT)",
    });

    deliver();
    await h.t.db.deleteFrom("push_subscriptions").execute();
    const noDevice = await crossing("TEST_PUSH_NODEV", ["push"]);
    await h.run("evaluate-alerts");
    expect(await eventOf(noDevice)).toMatchObject({
      push_status: "suppressed",
      push_error: "no device has push notifications turned on",
    });

    await device("ok-phone-2");
    deliver({ dailyCap: 1 });
    const capped = await crossing("TEST_PUSH_CAP", ["push"]);
    await h.run("evaluate-alerts");
    expect(await eventOf(capped)).toMatchObject({
      push_status: "suppressed",
      push_error: "daily cap of 1 push notifications reached",
    });
    expect(received).toHaveLength(0);
  });

  it("retries a busy push service, and records a refusal without retrying it", async () => {
    await device("busy-phone");
    await device("refuse-tablet", "Safari on iPad");
    const alertId = await crossing("TEST_PUSH_FAIL", ["push"]);
    await expect(h.run("evaluate-alerts")).rejects.toThrow(/1 push notification\(s\) to retry/);
    expect(await eventOf(alertId)).toMatchObject({
      push_status: "failed",
      push_error: "Chrome on Android: 503 busy; Safari on iPad: 403 bad jwt",
    });
    expect((await devices()).map((d) => [d.failures, d.last_error])).toEqual([
      [1, "503 busy"],
      [1, "403 bad jwt"],
    ]);

    // Only refusals now: recorded, and the job does not ask the queue to retry.
    await h.t.db.deleteFrom("push_subscriptions").where("endpoint", "like", "%busy%").execute();
    await expect(h.run("evaluate-alerts")).resolves.toMatchObject({
      push: { failed: 1, retry: 0 },
    });
    expect(await eventOf(alertId)).toMatchObject({
      push_status: "failed",
      push_error: "Safari on iPad: 403 bad jwt",
    });
  });
});
