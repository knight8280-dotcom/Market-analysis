import { checkVapidAuthorization, decryptPayload } from "@market/push";
import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";
import { e2eVapid } from "./push-keys";
import {
  clearPushSubscriptions,
  crossingLevel,
  type PushedMessage,
  runAlertsJob,
  startCaptureServer,
  startPushService,
} from "./worker";

/**
 * Push notifications (Phase 2 step J2) end to end, on a computer and a phone. A real browser
 * subscription needs Google's push servers, so the page's PushManager is replaced by a stand-in
 * that makes a real key pair and points at a local stand-in push service. Everything after that
 * is real: the app stores the subscription, the worker encrypts and signs, the stand-in checks
 * the signature, the test decrypts with the device's key, and the message is delivered to the
 * service worker through the browser's DevTools protocol (as DevTools' "Push" button does).
 */
test.describe.configure({ mode: "serial" });
// Notifications need the full Chromium build: Playwright's default for headless runs, the
// headless shell, reports them as blocked whatever permission is granted.
test.use({ channel: "chromium" });
test.beforeAll(clearPushSubscriptions);
test.afterAll(clearPushSubscriptions);

interface DeviceKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
  privateKey: string;
}
const KEY = "e2e-push-subscription";

/** Replaces PushManager before the app's scripts run; the subscription lives in localStorage. */
async function stubPushManager(context: BrowserContext, pushServiceUrl: string) {
  await context.addInitScript(
    ({ base, key }) => {
      const b64u = (bytes: ArrayBuffer | Uint8Array) =>
        btoa(String.fromCharCode(...new Uint8Array(bytes)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      const unb64u = (text: string) =>
        Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
          .buffer;
      type Stored = {
        endpoint: string;
        p256dh: string;
        auth: string;
        privateKey: string;
        serverKey: string;
      };
      const fake = (s: Stored) => ({
        endpoint: s.endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: unb64u(s.serverKey) },
        toJSON: () => ({
          endpoint: s.endpoint,
          expirationTime: null,
          keys: { p256dh: s.p256dh, auth: s.auth },
        }),
        unsubscribe: () => {
          localStorage.removeItem(key);
          return Promise.resolve(true);
        },
      });
      PushManager.prototype.getSubscription = function () {
        const s = localStorage.getItem(key);
        return Promise.resolve(
          s ? (fake(JSON.parse(s) as Stored) as unknown as PushSubscription) : null,
        );
      };
      PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
        const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
          "deriveBits",
        ]);
        const stored: Stored = {
          endpoint: `${base}/push/${crypto.randomUUID()}`,
          p256dh: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)),
          auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
          privateKey: (await crypto.subtle.exportKey("jwk", pair.privateKey)).d!,
          serverKey: b64u(options!.applicationServerKey as Uint8Array),
        };
        localStorage.setItem(key, JSON.stringify(stored));
        return fake(stored) as unknown as PushSubscription;
      };
    },
    { base: pushServiceUrl, key: KEY },
  );
}

const deviceKeys = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null") as DeviceKeys, KEY);

/** What the device would read: checks our signature, then decrypts with the device's key. */
function read(message: PushedMessage, keys: DeviceKeys, pushServiceUrl: string) {
  const vapid = checkVapidAuthorization(String(message.headers.authorization));
  expect(vapid.valid).toBe(true);
  expect(vapid.publicKey).toBe(e2eVapid().publicKey);
  expect(vapid.claims).toMatchObject({ aud: pushServiceUrl, sub: "mailto:owner@e2e.invalid" });
  expect(message.headers["content-encoding"]).toBe("aes128gcm");
  return JSON.parse(decryptPayload(message.body, keys).toString()) as Record<string, unknown>;
}

/** Delivers a message to the page's service worker and returns the notifications it shows. */
async function deliver(page: Page, baseURL: string, payload: unknown) {
  const cdp = await page.context().newCDPSession(page);
  const registrations: { registrationId: string; scopeURL: string; isDeleted: boolean }[] = [];
  cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => registrations.push(...e.registrations));
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => registrations.some((r) => !r.isDeleted)).toBe(true);
  const registration = registrations.find((r) => !r.isDeleted && r.scopeURL === `${baseURL}/`)!;
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: baseURL,
    registrationId: registration.registrationId,
    data: JSON.stringify(payload),
  });
  const shown = () =>
    page.evaluate(async () =>
      (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({
        title: n.title,
        body: n.body,
        tag: n.tag,
        data: n.data as unknown,
        actions: (n as Notification & { actions: { action: string; title: string }[] }).actions.map(
          (a) => ({ action: a.action, title: a.title }),
        ),
      })),
    );
  await expect.poll(async () => (await shown()).length).toBeGreaterThan(0);
  return shown();
}

async function turnOnPush(page: Page) {
  await signIn(page, "/settings");
  expect(await page.evaluate(() => Notification.permission), "notification permission").toBe(
    "granted",
  );
  const card = page.getByRole("region", { name: "Push notifications" });
  await expect(card.getByText("Push notifications are off for this device.")).toBeVisible();
  await card.getByRole("button", { name: "Turn on push for this device" }).click();
  await expect(card.getByText("Push notifications are on for this device.").first()).toBeVisible();
  await expect(card.getByRole("list", { name: "Devices with push on" })).toContainText(
    "via a test service",
  );
  return card;
}

test("on a computer: turn push on, get an alert pushed, snooze and delete it from the notification", async ({
  page,
  context,
  baseURL,
}) => {
  const service = await startPushService();
  const capture = await startCaptureServer();
  try {
    await context.grantPermissions(["notifications"], { origin: baseURL });
    await stubPushManager(context, service.url);
    const card = await turnOnPush(page);
    await expect(card.getByText("This device", { exact: true })).toHaveCount(2);
    await expectAccessible(page);
    const keys = await deviceKeys(page);

    // The test notification goes from the web app to the device.
    await card.getByRole("button", { name: "Send a test notification" }).click();
    await expect(card.getByRole("status")).toHaveText(
      "Sent. It should appear on that device in a few seconds.",
    );
    expect(service.messages).toHaveLength(1);
    expect(service.messages[0]!.path).toBe(new URL(keys.endpoint).pathname);
    expect(read(service.messages[0]!, keys, service.url)).toMatchObject({
      title: "Test notification",
      url: "/settings#push",
    });

    // An alert chooses push only; the worker pushes it when it fires.
    const { kind, level, money } = await crossingLevel("TEST_DIV");
    await page.goto("/alerts");
    await page.getByLabel("Ticker", { exact: true }).fill("TEST_DIV");
    await page.getByLabel("Condition").selectOption(kind);
    await page.getByLabel("Price (USD)").fill(String(level));
    const sendBy = page.getByRole("group", { name: "Send by" });
    await expect(sendBy.getByRole("checkbox", { name: "Push notification" })).toBeChecked();
    await sendBy.getByRole("checkbox", { name: "Email" }).uncheck();
    await page.getByRole("button", { name: "Create alert" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Alert created." })).toBeVisible();

    expect(await runAlertsJob(capture.url, baseURL, { push: true })).toContain('"fired"');
    const word = kind === "price_above" ? "above" : "below";
    const title = `[SAMPLE DATA] TEST_DIV closed ${word} ${money}`;
    // Email was not chosen for this alert.
    expect(capture.emails.find((e) => e.body.subject === title)).toBeUndefined();
    const pushed = service.messages.slice(1).map((m) => read(m, keys, service.url));
    const message = pushed.find((p) => p.title === title);
    expect(message, `pushed: ${pushed.map((p) => String(p.title)).join(" | ")}`).toBeTruthy();
    expect(message).toMatchObject({ v: 1, tag: `alert-${String(message!.alertId)}` });
    expect(message!.body).toContain("SAMPLE DATA");
    const alertPath = `/alerts/${String(message!.alertId)}`;
    expect(message!.url).toBe(alertPath);

    // The service worker shows it, with its buttons.
    const notifications = await deliver(page, baseURL!, message);
    expect(notifications.find((n) => n.title === title)).toEqual({
      title,
      body: message!.body,
      tag: message!.tag,
      data: { url: alertPath, alertId: message!.alertId },
      actions: [
        { action: "snooze", title: "Snooze 1 day" },
        { action: "delete", title: "Delete alert" },
      ],
    });

    await page.goto(alertPath);
    await expect(page.getByTestId("alert-channels")).toHaveText("Push, in the app");
    const event = page.getByRole("row").filter({ hasText: title.replace("[SAMPLE DATA] ", "") });
    await expect(event).toContainText("Pushed");
    await expect(event).toContainText("Not emailed");
    await expectAccessible(page);

    // The buttons post to the app's API with the session, from the app's own origin only.
    const api = `/api/alerts/${String(message!.alertId)}`;
    const elsewhere = await page.request.post(api, {
      data: { action: "snooze" },
      headers: { Origin: "https://evil.example" },
    });
    expect(elsewhere.status()).toBe(403);
    const snooze = await page.request.post(api, {
      data: { action: "snooze" },
      headers: { Origin: baseURL! },
    });
    expect(await snooze.json()).toEqual({ ok: true, action: "snooze" });
    await page.reload();
    await expect(page.getByText(/^Snoozed/).first()).toBeVisible();
    const remove = await page.request.post(api, {
      data: { action: "delete" },
      headers: { Origin: baseURL! },
    });
    expect(remove.status()).toBe(200);
    expect((await page.goto(alertPath))?.status()).toBe(404);

    // Turning push off removes the device.
    await page.goto("/settings");
    await card.getByRole("button", { name: "Turn off for this device" }).click();
    await expect(card.getByText("Push notifications are off for this device.")).toBeVisible();
    await expect(card.getByText("None yet.")).toBeVisible();
  } finally {
    capture.close();
    service.close();
  }
});

test.describe("on a phone", () => {
  const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 7"];
  test.use(pixel);

  test("turn push on and get a notification", async ({ page, context, baseURL }) => {
    const service = await startPushService();
    try {
      await context.grantPermissions(["notifications"], { origin: baseURL });
      await stubPushManager(context, service.url);
      const card = await turnOnPush(page);
      await expect(card.getByRole("list", { name: "Devices with push on" })).toContainText(
        "Chrome on Android",
      );
      await card.getByRole("button", { name: "Send a test notification" }).click();
      await expect(card.getByRole("status")).toHaveText(/^Sent\./);
      const message = read(service.messages[0]!, await deviceKeys(page), service.url);
      const [shown] = await deliver(page, baseURL!, message);
      expect(shown).toMatchObject({
        title: "Test notification",
        body: "Push notifications from Market Analysis work on this device.",
        actions: [],
      });
      await expectAccessible(page);
    } finally {
      service.close();
    }
  });
});
