import "server-only";
import { describeAlert, parseAlert } from "@market/alerts";
import { OWNER_USER_ID } from "@market/config";
import { CHANNELS, type Channel } from "../lib/alert-form";
import { db } from "./db";

/** What an alert watches: a security (by ticker) or one of the owner's saved screens. */
export type AlertTarget =
  | { type: "security"; ticker: string; name: string }
  | { type: "screen"; screenId: string; name: string };

export interface AlertRow {
  id: string;
  kind: string;
  target: AlertTarget;
  /** The condition in words, or a note when the stored definition no longer validates. */
  condition: string;
  active: boolean;
  /** Set while snoozed (in the future). */
  snoozedUntil: Date | null;
  cooldownHours: number;
  lastFiredAt: Date | null;
  createdAt: Date;
  /** Besides the in-app notifications: email, push or both (Phase 2 step J2). */
  channels: Channel[];
}

function alertsQuery() {
  return db()
    .selectFrom("alerts as a")
    .leftJoin("market.securities as s", "s.security_id", "a.security_id")
    .leftJoin("saved_screens as sc", "sc.screen_id", "a.screen_id")
    .select([
      "a.alert_id",
      "a.kind",
      "a.params",
      "a.active",
      "a.snoozed_until",
      "a.cooldown_hours",
      "a.last_fired_at",
      "a.created_at",
      "a.channels",
      "a.screen_id",
      "s.ticker",
      "s.name as security_name",
      "sc.name as screen_name",
    ])
    .where("a.user_id", "=", OWNER_USER_ID);
}

type Row = Awaited<ReturnType<ReturnType<typeof alertsQuery>["execute"]>>[number];

function toAlert(r: Row, now: Date): AlertRow {
  const def = parseAlert(r.kind, r.params);
  const target: AlertTarget =
    r.screen_id !== null
      ? { type: "screen", screenId: r.screen_id, name: r.screen_name ?? "" }
      : { type: "security", ticker: r.ticker ?? "", name: r.security_name ?? "" };
  return {
    id: r.alert_id,
    kind: r.kind,
    target,
    condition: def
      ? describeAlert(def, { screenName: r.screen_name ?? undefined })
      : `Unreadable ${r.kind} alert`,
    active: r.active,
    snoozedUntil: r.snoozed_until && r.snoozed_until > now ? r.snoozed_until : null,
    cooldownHours: r.cooldown_hours,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
    channels: CHANNELS.filter((c) => r.channels.includes(c)),
  };
}

export async function listAlerts(now = new Date()): Promise<AlertRow[]> {
  const rows = await alertsQuery()
    .orderBy("a.active", "desc")
    .orderBy("s.ticker")
    .orderBy("sc.name")
    .orderBy("a.alert_id")
    .execute();
  return rows.map((r) => toAlert(r, now));
}

export async function getAlert(id: string, now = new Date()): Promise<AlertRow | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const row = await alertsQuery().where("a.alert_id", "=", id).executeTakeFirst();
  return row ? toAlert(row, now) : null;
}

export interface AlertEventRow {
  id: string;
  alertId: string;
  /** The security's ticker, or the screen's name. */
  label: string;
  date: string;
  subject: string;
  firedAt: Date;
  status: "pending" | "sent" | "failed" | "suppressed";
  error: string | null;
  push: { status: AlertEventRow["status"]; error: string | null };
}

export async function recentAlertEvents(
  opts: { limit?: number; alertId?: string } = {},
): Promise<AlertEventRow[]> {
  let q = db()
    .selectFrom("alert_events as e")
    .innerJoin("alerts as a", "a.alert_id", "e.alert_id")
    .leftJoin("market.securities as s", "s.security_id", "a.security_id")
    .leftJoin("saved_screens as sc", "sc.screen_id", "a.screen_id")
    .select([
      "e.event_id",
      "e.alert_id",
      "e.bar_date",
      "e.message",
      "e.fired_at",
      "e.delivery_status",
      "e.error",
      "e.push_status",
      "e.push_error",
      "s.ticker",
      "sc.name as screen_name",
    ])
    .where("e.user_id", "=", OWNER_USER_ID);
  if (opts.alertId) q = q.where("e.alert_id", "=", opts.alertId);
  const rows = await q
    .orderBy("e.fired_at", "desc")
    .orderBy("e.event_id", "desc")
    .limit(opts.limit ?? 50)
    .execute();
  return rows.map((r) => ({
    id: r.event_id,
    alertId: r.alert_id,
    label: r.ticker ?? r.screen_name ?? "",
    date: r.bar_date,
    subject: (r.message.split("\n\n")[0] ?? r.message).replace(/^\[SAMPLE DATA\] /, ""),
    firedAt: r.fired_at,
    status: r.delivery_status as AlertEventRow["status"],
    error: r.error,
    push: { status: r.push_status as AlertEventRow["status"], error: r.push_error },
  }));
}

export interface NotificationRow {
  id: string;
  title: string;
  body: string;
  href: string | null;
  createdAt: Date;
  read: boolean;
  alert: { id: string; kind: string; active: boolean; snoozedUntil: Date | null };
}

export async function listNotifications(limit = 100, now = new Date()): Promise<NotificationRow[]> {
  const rows = await db()
    .selectFrom("notifications as n")
    .innerJoin("alert_events as e", "e.event_id", "n.event_id")
    .innerJoin("alerts as a", "a.alert_id", "e.alert_id")
    .select([
      "n.notification_id",
      "n.title",
      "n.body",
      "n.href",
      "n.created_at",
      "n.read_at",
      "a.alert_id",
      "a.kind",
      "a.active",
      "a.snoozed_until",
    ])
    .where("n.user_id", "=", OWNER_USER_ID)
    .orderBy("n.created_at", "desc")
    .orderBy("n.notification_id", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.notification_id,
    title: r.title,
    body: r.body,
    href: r.href,
    createdAt: r.created_at,
    read: r.read_at !== null,
    alert: {
      id: r.alert_id,
      kind: r.kind,
      active: r.active,
      snoozedUntil: r.snoozed_until && r.snoozed_until > now ? r.snoozed_until : null,
    },
  }));
}

export async function unreadNotifications(): Promise<number> {
  const row = await db()
    .selectFrom("notifications")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("user_id", "=", OWNER_USER_ID)
    .where("read_at", "is", null)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}
