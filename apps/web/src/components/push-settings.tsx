"use client";

import { Badge, Button, formatDateTimeET } from "@market/ui";
import { useCallback, useEffect, useState } from "react";
import {
  pushDeviceFor,
  removePushSubscription,
  savePushSubscription,
  sendTestPush,
} from "../app/(app)/settings/push-actions";

export interface DeviceView {
  id: string;
  device: string;
  service: string;
  createdAt: string;
  lastSentAt: string | null;
  lastError: string | null;
}

type Here =
  | { kind: "checking" }
  | { kind: "unsupported" }
  | { kind: "install-first" }
  | { kind: "blocked" }
  | { kind: "off" }
  | { kind: "on"; id: string };

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(key: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!key) return false;
  const a = new Uint8Array(key);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** iPhone and iPad allow web push only in an app added to the Home Screen. */
function iosBrowserTab(): boolean {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !window.matchMedia("(display-mode: standalone)").matches;
}

async function currentSubscription(publicKey: string): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  return sub && sameKey(sub.options.applicationServerKey, publicKey) ? sub : null;
}

/**
 * Push notifications in Settings (Phase 2 step J2): this device on or off, a test notification,
 * and every device that has push on.
 */
export function PushSettings({ publicKey, devices }: { publicKey: string; devices: DeviceView[] }) {
  const [here, setHere] = useState<Here>({ kind: "checking" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const check = useCallback(async (): Promise<Here> => {
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      return iosBrowserTab() ? { kind: "install-first" } : { kind: "unsupported" };
    }
    if (Notification.permission === "denied") return { kind: "blocked" };
    const sub = await currentSubscription(publicKey);
    const id = sub ? await pushDeviceFor(sub.endpoint) : null;
    return id ? { kind: "on", id } : { kind: "off" };
  }, [publicKey]);

  const deviceIds = devices.map((d) => d.id).join(",");
  useEffect(() => {
    let live = true;
    void check().then((state) => live && setHere(state));
    return () => {
      live = false;
    };
  }, [check, deviceIds]);

  const run = async (work: () => Promise<{ ok: boolean; text: string } | null>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await work());
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : "Something went wrong." });
    } finally {
      setHere(await check());
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      if ((await Notification.requestPermission()) !== "granted") {
        return { ok: false, text: "Notifications were not allowed for this site." };
      }
      const registration = await navigator.serviceWorker.ready;
      const old = await registration.pushManager.getSubscription();
      // A subscription made with an earlier key pair cannot be used: replace it.
      if (old && !sameKey(old.options.applicationServerKey, publicKey)) await old.unsubscribe();
      const sub =
        (await currentSubscription(publicKey)) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }));
      const saved = await savePushSubscription(sub.toJSON());
      // On success the status line above says so.
      return saved.ok ? null : { ok: false, text: saved.error };
    });

  const turnOff = () =>
    run(async () => {
      const sub = await currentSubscription(publicKey);
      if (sub) {
        await removePushSubscription({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      return null;
    });

  const test = (id: string) =>
    run(async () => {
      const sent = await sendTestPush(id);
      return { ok: sent.ok, text: sent.message };
    });

  const remove = (id: string) =>
    run(async () => {
      await removePushSubscription({ id });
      return { ok: true, text: "Device removed." };
    });

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="push-here" className="flex flex-col gap-2">
        <h3 id="push-here" className="text-sm font-medium">
          This device
        </h3>
        <HereStatus here={here} />
        <div className="flex flex-wrap gap-2">
          {here.kind === "off" ? (
            <Button type="button" variant="primary" disabled={busy} onClick={() => void turnOn()}>
              Turn on push for this device
            </Button>
          ) : null}
          {here.kind === "on" ? (
            <>
              <Button type="button" disabled={busy} onClick={() => void test(here.id)}>
                Send a test notification
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void turnOff()}>
                Turn off for this device
              </Button>
            </>
          ) : null}
        </div>
        <p role="status" className={note?.ok === false ? "text-sm text-down" : "text-sm"}>
          {note?.text ?? ""}
        </p>
      </section>

      <section aria-labelledby="push-devices" className="flex flex-col gap-2">
        <h3 id="push-devices" className="text-sm font-medium">
          Devices with push on
        </h3>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="flex flex-col divide-y" aria-label="Devices with push on">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="font-medium">{d.device}</span>
                {here.kind === "on" && here.id === d.id ? (
                  <Badge tone="info">This device</Badge>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  via {d.service} · added {formatDateTimeET(d.createdAt)} ·{" "}
                  {d.lastSentAt
                    ? `last notification ${formatDateTimeET(d.lastSentAt)}`
                    : "nothing sent yet"}
                </span>
                {d.lastError ? (
                  <span className="text-xs text-down">Last problem: {d.lastError}</span>
                ) : null}
                <span className="ml-auto flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void test(d.id)}
                  >
                    Send test to {d.device}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void remove(d.id)}
                  >
                    Remove {d.device}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function HereStatus({ here }: { here: Here }) {
  const text: Record<Here["kind"], string> = {
    checking: "Checking this device…",
    unsupported: "This browser cannot receive push notifications.",
    "install-first":
      "On iPhone and iPad, add the app to the Home Screen first (Share, then Add to Home Screen), open it from there and turn push on in its Settings.",
    blocked:
      "Notifications are blocked for this site in the browser's settings. Allow them there, then reload this page.",
    off: "Push notifications are off for this device.",
    on: "Push notifications are on for this device.",
  };
  // Announced when it changes (turned on or off).
  return (
    <p aria-live="polite" className="text-sm text-muted-foreground">
      {text[here.kind]}
    </p>
  );
}
