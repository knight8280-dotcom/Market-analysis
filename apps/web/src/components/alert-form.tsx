"use client";

import { KIND_LABELS, OWNERSHIP_KINDS, PHASE2_KINDS, type AlertKind } from "@market/alerts";
import { Button, Input } from "@market/ui";
import Link from "next/link";
import { useState } from "react";
import { createAlert } from "../app/(app)/alerts/actions";
import {
  CHANNEL_LABELS,
  CHANNELS,
  FORM_CHOICES,
  isAlertKind,
  type Channel,
} from "../lib/alert-form";

const GROUPS: { label: string; kinds: AlertKind[] }[] = [
  { label: "Price", kinds: ["price_above", "price_below", "pct_move"] },
  {
    label: "Indicators and volume",
    kinds: ["rsi_below", "rsi_above", "sma_cross", "volume_spike"],
  },
  {
    label: "Events",
    kinds: ["earnings_upcoming", "new_filing", "insider_purchase", "screen_membership"],
  },
];

const field = "flex flex-col gap-1 text-sm";
const caption = "text-xs text-muted-foreground";
const select =
  "min-h-9 w-full rounded-md border bg-background px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-ring";

/**
 * New-alert form: the fields follow the chosen condition, and the server validates on submit
 * with the same rules (lib/alert-form). Phase 2 kinds appear while the `alert_types` flag is on,
 * and the insider-purchase kind while the `ownership` flag is on as well.
 */
export function AlertForm({
  ticker,
  kind: initialKind,
  moreKinds,
  ownership,
  push,
  screens,
}: {
  ticker?: string;
  kind?: string;
  moreKinds: boolean;
  ownership: boolean;
  /** Offer push next to email (the `push` flag). */
  push: boolean;
  screens: { id: string; name: string }[];
}) {
  const offered = (k: AlertKind) =>
    (moreKinds || !(PHASE2_KINDS as readonly AlertKind[]).includes(k)) &&
    (ownership || !(OWNERSHIP_KINDS as readonly AlertKind[]).includes(k));
  const [kind, setKind] = useState<AlertKind>(
    initialKind && isAlertKind(initialKind) && offered(initialKind) ? initialKind : "price_above",
  );
  const forScreen = kind === "screen_membership";

  return (
    <form action={createAlert} className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,22rem)]">
        {forScreen ? null : (
          <label className={field}>
            <span className={caption}>Ticker</span>
            <Input
              name="ticker"
              defaultValue={ticker}
              required
              maxLength={15}
              autoCapitalize="characters"
              placeholder="AAPL"
            />
          </label>
        )}
        <label className={field}>
          <span className={caption}>Condition</span>
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as AlertKind)}
            className={select}
          >
            {GROUPS.map((g) => {
              const kinds = g.kinds.filter(offered);
              return kinds.length ? (
                <optgroup key={g.label} label={g.label}>
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" key={kind}>
        <Fields kind={kind} screens={screens} />
      </div>

      {push ? <ChannelChoice /> : <input type="hidden" name="channels" value="email" />}

      <div className="flex flex-wrap items-end gap-3">
        <label className={field}>
          <span className={caption}>Cooldown (hours)</span>
          <Input
            name="cooldown"
            type="number"
            min={0}
            max={720}
            required
            defaultValue={24}
            className="w-32"
          />
        </label>
        <Button type="submit" variant="primary" disabled={forScreen && screens.length === 0}>
          Create alert
        </Button>
      </div>
    </form>
  );
}

function Fields({ kind, screens }: { kind: AlertKind; screens: { id: string; name: string }[] }) {
  switch (kind) {
    case "price_above":
    case "price_below":
      return (
        <label className={field}>
          <span className={caption}>Price (USD)</span>
          <Input name="price" inputMode="decimal" required placeholder="200.00" />
        </label>
      );
    case "pct_move":
      return (
        <>
          <label className={field}>
            <span className={caption}>Move (%)</span>
            <Input name="pct" inputMode="decimal" required placeholder="5" />
          </label>
          <label className={field}>
            <span className={caption}>Direction</span>
            <select name="direction" defaultValue="either" className={select}>
              <option value="either">Up or down</option>
              <option value="up">Up</option>
              <option value="down">Down</option>
            </select>
          </label>
        </>
      );
    case "earnings_upcoming":
      return (
        <label className={field}>
          <span className={caption}>Within (days)</span>
          <Input name="days" type="number" min={1} max={30} required defaultValue={7} />
        </label>
      );
    case "rsi_below":
    case "rsi_above":
      return (
        <>
          <label className={field}>
            <span className={caption}>RSI level</span>
            <Input
              name="level"
              inputMode="decimal"
              required
              defaultValue={kind === "rsi_below" ? 30 : 70}
            />
          </label>
          <label className={field}>
            <span className={caption}>RSI sessions</span>
            <Input name="period" type="number" min={2} max={100} required defaultValue={14} />
          </label>
        </>
      );
    case "sma_cross":
      return (
        <>
          <label className={field}>
            <span className={caption}>Fast average (sessions; 1 = the close)</span>
            <Input name="fast" type="number" min={1} max={399} required defaultValue={50} />
          </label>
          <label className={field}>
            <span className={caption}>Cross direction</span>
            <select name="cross" defaultValue="above" className={select}>
              <option value="above">Above</option>
              <option value="below">Below</option>
            </select>
          </label>
          <label className={field}>
            <span className={caption}>Slow average (sessions)</span>
            <Input name="slow" type="number" min={2} max={400} required defaultValue={200} />
          </label>
        </>
      );
    case "volume_spike":
      return (
        <>
          <label className={field}>
            <span className={caption}>Multiple of the average</span>
            <Input name="multiple" inputMode="decimal" required defaultValue={2} />
          </label>
          <label className={field}>
            <span className={caption}>Average over (sessions before)</span>
            <Input name="lookback" type="number" min={5} max={250} required defaultValue={20} />
          </label>
        </>
      );
    case "new_filing":
      return (
        <fieldset className="flex flex-col gap-2 sm:col-span-2 lg:col-span-4">
          <legend className={caption}>Forms (SEC EDGAR)</legend>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
            {FORM_CHOICES.map((c) => (
              <label key={c.id} className="flex min-h-8 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="forms"
                  value={c.id}
                  defaultChecked={c.id === "8-K" || c.id === "10-Q" || c.id === "10-K"}
                  className="size-4"
                />
                {c.label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <label className={field}>
              <span className={caption}>Other forms (comma-separated)</span>
              <Input name="otherForms" placeholder="424B2, 6-K" className="w-64" />
            </label>
            <label className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" name="amendments" defaultChecked className="size-4" />
              Include amendments (/A)
            </label>
          </div>
        </fieldset>
      );
    case "insider_purchase":
      return (
        <>
          <label className={field}>
            <span className={caption}>At least (USD, at the filed prices)</span>
            <Input name="minValue" inputMode="decimal" defaultValue={0} />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-1 lg:col-span-3">
            Fires when a Form 4 filed with SEC EDGAR reports an open-market purchase (code P) of the
            company&apos;s stock; 0 means any purchase. Checked as the evening&apos;s EDGAR refresh
            (from 21:00 ET) reads new Form 4s.
          </p>
        </>
      );
    case "screen_membership":
      return screens.length === 0 ? (
        <p className="text-sm text-muted-foreground sm:col-span-2">
          Save a screen on the{" "}
          <Link href="/screener" className="text-primary underline">
            Screener
          </Link>{" "}
          first; this alert reports securities entering or leaving its results.
        </p>
      ) : (
        <>
          <label className={field}>
            <span className={caption}>Saved screen</span>
            <select name="screen" required className={select}>
              {screens.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            <span className={caption}>Tell me when a security</span>
            <select name="change" defaultValue="either" className={select}>
              <option value="either">Enters or leaves</option>
              <option value="enters">Enters</option>
              <option value="leaves">Leaves</option>
            </select>
          </label>
        </>
      );
  }
}

/**
 * Email, push or both (Phase 2 step J2). Both are ticked to start with; the in-app notification
 * comes either way. Shared by the new-alert form and the alert's page.
 */
export function ChannelChoice({ chosen = CHANNELS }: { chosen?: readonly Channel[] }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className={caption}>Send by</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {CHANNELS.map((c) => (
          <label key={c} className="flex min-h-8 items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="channels"
              value={c}
              defaultChecked={chosen.includes(c)}
              className="size-4"
            />
            {c === "push" ? "Push notification" : CHANNEL_LABELS[c]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
