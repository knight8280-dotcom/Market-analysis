import "server-only";
import { describeAlert, parseAlert } from "@market/alerts";
import { OWNER_USER_ID } from "@market/config";
import { db } from "./db";

export interface AlertRow {
  id: string;
  ticker: string;
  name: string;
  /** The condition in words, or a note when the stored definition no longer validates. */
  condition: string;
  active: boolean;
  cooldownHours: number;
  lastFiredAt: Date | null;
}

export async function listAlerts(): Promise<AlertRow[]> {
  const rows = await db()
    .selectFrom("alerts as a")
    .innerJoin("market.securities as s", "s.security_id", "a.security_id")
    .select([
      "a.alert_id",
      "a.kind",
      "a.params",
      "a.active",
      "a.cooldown_hours",
      "a.last_fired_at",
      "s.ticker",
      "s.name",
    ])
    .where("a.user_id", "=", OWNER_USER_ID)
    .orderBy("a.active", "desc")
    .orderBy("s.ticker")
    .orderBy("a.alert_id")
    .execute();
  return rows.map((r) => {
    const def = parseAlert(r.kind, r.params);
    return {
      id: r.alert_id,
      ticker: r.ticker,
      name: r.name,
      condition: def ? describeAlert(def) : `Unreadable ${r.kind} alert`,
      active: r.active,
      cooldownHours: r.cooldown_hours,
      lastFiredAt: r.last_fired_at,
    };
  });
}

export interface AlertEventRow {
  id: string;
  ticker: string;
  date: string;
  subject: string;
  firedAt: Date;
  status: "pending" | "sent" | "failed" | "suppressed";
  error: string | null;
}

export async function recentAlertEvents(limit = 50): Promise<AlertEventRow[]> {
  const rows = await db()
    .selectFrom("alert_events as e")
    .innerJoin("alerts as a", "a.alert_id", "e.alert_id")
    .innerJoin("market.securities as s", "s.security_id", "a.security_id")
    .select([
      "e.event_id",
      "e.bar_date",
      "e.message",
      "e.fired_at",
      "e.delivery_status",
      "e.error",
      "s.ticker",
    ])
    .where("e.user_id", "=", OWNER_USER_ID)
    .orderBy("e.fired_at", "desc")
    .orderBy("e.event_id", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.event_id,
    ticker: r.ticker,
    date: r.bar_date,
    subject: (r.message.split("\n\n")[0] ?? r.message).replace(/^\[SAMPLE DATA\] /, ""),
    firedAt: r.fired_at,
    status: r.delivery_status as AlertEventRow["status"],
    error: r.error,
  }));
}
