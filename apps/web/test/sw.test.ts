import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { isSameOrigin } from "../src/server/auth/same-origin";

/**
 * The service worker's push handling (Phase 2 step J2), run in a sandbox with stand-ins for the
 * browser: what a push shows, and what the notification's buttons and a tap do.
 */
const SOURCE = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
const ORIGIN = "https://desk.example.ts.net";

type Listener = (event: Record<string, unknown>) => void;
let listeners: Record<string, Listener>;
let shown: { title: string; options: Record<string, unknown> }[];
let fetched: { url: string; init: RequestInit }[];
let opened: string[];
let windows: { url: string; focused: boolean; navigatedTo?: string }[];
let answer: number | "offline";

function load() {
  listeners = {};
  shown = [];
  fetched = [];
  opened = [];
  windows = [];
  answer = 200;
  const self = {
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () =>
        Promise.resolve(
          windows.map((w) => ({
            url: w.url,
            focus: () => {
              w.focused = true;
              return Promise.resolve();
            },
            navigate: (url: string) => {
              w.navigatedTo = url;
              return Promise.resolve();
            },
          })),
        ),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
    location: { origin: ORIGIN },
  };
  const fetch = (url: string, init: RequestInit) => {
    fetched.push({ url, init });
    return answer === "offline"
      ? Promise.reject(new TypeError("Failed to fetch"))
      : Promise.resolve(new Response(null, { status: answer }));
  };
  vm.runInNewContext(SOURCE, { self, fetch, Response, URL, Intl, caches: {} });
}

async function dispatch(type: string, event: Record<string, unknown>) {
  const pending: Promise<unknown>[] = [];
  listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
}

const push = (message: unknown) =>
  dispatch("push", {
    data: {
      json: () => (typeof message === "string" ? JSON.parse(message) : message) as unknown,
    },
  });

const click = (action: string, data: unknown) =>
  dispatch("notificationclick", { action, notification: { data, close: () => undefined } });

beforeEach(load);

describe("push", () => {
  it("shows an alert with snooze and delete buttons", async () => {
    await push({
      v: 1,
      title: "[SAMPLE DATA] TEST_DIV closed above $50.00",
      body: "TEST_DIV closed at $50.12",
      url: "/alerts/7",
      tag: "alert-7",
      alertId: 7,
      eventId: 9,
    });
    expect(shown).toEqual([
      {
        title: "[SAMPLE DATA] TEST_DIV closed above $50.00",
        options: {
          body: "TEST_DIV closed at $50.12",
          tag: "alert-7",
          icon: "/icon/192",
          data: { url: "/alerts/7", alertId: 7 },
          actions: [
            { action: "snooze", title: "Snooze 1 day" },
            { action: "delete", title: "Delete alert" },
          ],
        },
      },
    ]);
  });

  it("never opens another site, and always shows something", async () => {
    await push({ title: "Test", url: "https://evil.example/", body: "x" });
    await push({ title: "Test", url: "//evil.example/x", body: "x" });
    expect(shown.map((s) => s.options.data)).toEqual([
      { url: "/notifications", alertId: null },
      { url: "/notifications", alertId: null },
    ]);
    // A test notification has no alert, so no buttons.
    expect(shown[0]!.options.actions).toEqual([]);
    await push("not json");
    expect(shown[2]).toEqual({
      title: "Market Analysis",
      options: { body: "Something new: open the app to see it.", tag: "market-analysis" },
    });
  });
});

describe("notification click", () => {
  const data = { url: "/alerts/7", alertId: 7 };

  it("snoozes or deletes through the app's API, with the session", async () => {
    await click("snooze", data);
    await click("delete", data);
    expect(fetched.map((f) => [f.url, f.init.method, f.init.body, f.init.credentials])).toEqual([
      ["/api/alerts/7", "POST", '{"action":"snooze"}', "same-origin"],
      ["/api/alerts/7", "POST", '{"action":"delete"}', "same-origin"],
    ]);
    expect(opened).toEqual([]);
  });

  it("opens the alert when the button cannot work (signed out, offline)", async () => {
    answer = 401;
    await click("snooze", data);
    answer = "offline";
    await click("delete", data);
    expect(opened).toEqual([`${ORIGIN}/alerts/7`, `${ORIGIN}/alerts/7`]);
  });

  it("a tap focuses an open window of the app, or opens one", async () => {
    await click("", data);
    expect(opened).toEqual([`${ORIGIN}/alerts/7`]);
    windows = [
      { url: "https://other.example/", focused: false },
      { url: `${ORIGIN}/screener`, focused: false },
    ];
    await click("", data);
    expect(windows[1]).toMatchObject({ focused: true, navigatedTo: `${ORIGIN}/alerts/7` });
    expect(windows[0]!.focused).toBe(false);
  });
});

describe("isSameOrigin (the notification buttons' API)", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it("takes requests from the app's own pages and service worker only", () => {
    expect(isSameOrigin(h({ origin: ORIGIN, host: "desk.example.ts.net" }))).toBe(true);
    expect(
      isSameOrigin(
        h({ origin: ORIGIN, host: "127.0.0.1:3000", "x-forwarded-host": "desk.example.ts.net" }),
      ),
    ).toBe(true);
    expect(
      isSameOrigin(
        h({ origin: ORIGIN, host: "desk.example.ts.net", "sec-fetch-site": "same-origin" }),
      ),
    ).toBe(true);
    expect(isSameOrigin(h({ origin: "https://evil.example", host: "desk.example.ts.net" }))).toBe(
      false,
    );
    expect(
      isSameOrigin(
        h({ origin: ORIGIN, host: "desk.example.ts.net", "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(false);
    expect(isSameOrigin(h({ host: "desk.example.ts.net" }))).toBe(false);
    expect(isSameOrigin(h({ origin: "null", host: "desk.example.ts.net" }))).toBe(false);
  });
});
