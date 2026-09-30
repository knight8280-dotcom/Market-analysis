import { describeAlert, evaluateAlert, parseAlert } from "@market/alerts";
import { marketDateOf } from "@market/calendar";
import { OWNER_USER_ID } from "@market/config";
import { sql } from "@market/db";
import { licenseFor, ProviderId } from "@market/market-data";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { JOBS } from "../queues";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import { routeFor } from "../routing";

const Input = z.object({
  /** Evaluate the latest bar on or before this date (default: the latest bar). */
  through: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

interface AlertRow {
  alert_id: string;
  user_id: string;
  kind: string;
  params: unknown;
  cooldown_hours: number;
  last_fired_at: Date | null;
  ticker: string;
  date: string | null;
  close: number | null;
  prev_date: string | null;
  prev_close: number | null;
  earnings_date: string | null;
  earnings_hour: string | null;
}

/**
 * Evaluates every active alert against the latest end-of-day bar and upcoming earnings, then
 * emails new events to the owner (Phase 1 steps I2 and I3).
 *
 * - Idempotent: an event is unique per (alert, bar date), or per (alert, report date) for
 *   earnings, so re-running never fires twice.
 * - Delivery is separate from firing: events start "pending" and become "sent", "failed" (retried
 *   by the job's own retries within a day) or "suppressed" (no email configured, or over the
 *   daily cap). Resend's idempotency key stops a retry from sending a second copy.
 */
export async function evaluateAlerts(ctx: WorkerContext, raw: unknown) {
  const input = Input.parse(raw ?? {});
  const now = ctx.clock();
  const today = marketDateOf(now);
  const route = await routeFor(ctx, "daily_bars");
  const source = ProviderId.parse(route.active ?? route.primary);
  const through = input.through ?? "9999-12-31";
  const runId = await startRun(ctx.db, {
    jobName: JOBS.evaluateAlerts,
    jobId: ctx.jobId,
    dataset: "alerts",
    source,
    params: input,
    at: now,
  });
  const counts = emptyCounts();
  try {
    const rows = await sql<AlertRow>`
      select a.alert_id::text, a.user_id::text, a.kind, a.params, a.cooldown_hours,
        a.last_fired_at, s.ticker, t.date, t.close::float8 as close, y.date as prev_date,
        y.close::float8 * coalesce(fy.split_factor, 1) / coalesce(ft.split_factor, 1) as prev_close,
        e.report_date as earnings_date, e.hour as earnings_hour
      from public.alerts a
      join market.securities s using (security_id)
      left join lateral (
        select p.date, p.close from market.prices_daily p
        where p.security_id = s.security_id and p.source = ${source} and p.date <= ${through}::date
        order by p.date desc limit 1
      ) t on true
      left join lateral (
        select p.date, p.close from market.prices_daily p
        where p.security_id = s.security_id and p.source = ${source} and p.date < t.date
        order by p.date desc limit 1
      ) y on true
      left join lateral (
        select af.split_factor from market.adjustment_factors af
        where af.security_id = s.security_id and af.ex_date > t.date
        order by af.ex_date limit 1
      ) ft on true
      left join lateral (
        select af.split_factor from market.adjustment_factors af
        where af.security_id = s.security_id and af.ex_date > y.date
        order by af.ex_date limit 1
      ) fy on true
      left join lateral (
        select ee.report_date, ee.hour from market.earnings_events ee
        where ee.security_id = s.security_id and ee.report_date > ${today}::date
        order by ee.report_date limit 1
      ) e on true
      where a.active
      order by a.alert_id
    `.execute(ctx.db);
    counts.rows_fetched = rows.rows.length;

    const attribution = licenseFor(source).attribution.text;
    const sample = source === "synthetic";
    const outcome = { fired: 0, notMet: 0, cooldown: 0, noData: 0, invalid: 0, duplicate: 0 };
    for (const r of rows.rows) {
      const def = parseAlert(r.kind, r.params);
      if (!def) {
        outcome.invalid++;
        continue;
      }
      const result = evaluateAlert(def, {
        ticker: r.ticker,
        bar:
          r.date && r.close !== null
            ? { date: r.date, close: r.close, prevDate: r.prev_date, prevClose: r.prev_close }
            : null,
        earnings: r.earnings_date ? { date: r.earnings_date, hour: r.earnings_hour } : null,
        today,
        now,
        lastFiredAt: r.last_fired_at,
        cooldownHours: r.cooldown_hours,
      });
      if (!result.fire) {
        if (result.reason === "cooldown") outcome.cooldown++;
        else if (result.reason === "no_data") outcome.noData++;
        else outcome.notMet++;
        continue;
      }
      const footer = [
        def.kind === "earnings_upcoming"
          ? "Earnings dates: Finnhub (personal use)."
          : `End-of-day data as of ${r.date}. ${attribution}.`,
        sample
          ? "SAMPLE DATA: this environment uses synthetic prices, not real market data."
          : null,
        `Your alert: ${r.ticker}, ${describeAlert(def).toLowerCase()}. Manage alerts under Alerts in Market Analysis.`,
        "Informational only; not investment advice.",
      ].filter(Boolean);
      const subject = `${sample ? "[SAMPLE DATA] " : ""}${result.subject}`;
      const message = `${subject}\n\n${result.text}\n\n${footer.join("\n")}`;
      const inserted = await ctx.db.transaction().execute(async (trx) => {
        const event = await trx
          .insertInto("alert_events")
          .values({
            alert_id: r.alert_id,
            user_id: r.user_id,
            bar_date: result.key,
            message,
            fired_at: now,
          })
          .onConflict((oc) => oc.columns(["alert_id", "bar_date"]).doNothing())
          .returning("event_id")
          .executeTakeFirst();
        if (event) {
          await trx
            .updateTable("alerts")
            .set({ last_fired_at: now })
            .where("alert_id", "=", r.alert_id)
            .execute();
        }
        return Boolean(event);
      });
      if (inserted) outcome.fired++;
      else outcome.duplicate++;
    }
    counts.rows_inserted = outcome.fired;

    const delivery = await deliverPending(ctx, now, today);
    counts.rows_updated = delivery.sent;
    if (delivery.failed > 0) {
      // Let the queue retry; firing is idempotent and delivery resumes where it stopped.
      throw new Error(`${delivery.failed} alert email(s) failed: ${delivery.errors.join("; ")}`);
    }
    await finishRun(ctx.db, runId, { status: "succeeded", counts, at: ctx.clock() });
    return { runId, source, today, evaluated: rows.rows.length, ...outcome, delivery };
  } catch (err) {
    await finishRun(ctx.db, runId, {
      status: "failed",
      counts,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      at: ctx.clock(),
    });
    throw err;
  }
}

async function deliverPending(ctx: WorkerContext, now: Date, today: string) {
  const d = ctx.alertDelivery;
  const pending = await sql<{
    event_id: string;
    user_id: string;
    message: string;
  }>`
    select event_id::text, user_id::text, message from public.alert_events
    where delivery_status = 'pending'
       or (delivery_status = 'failed' and fired_at > ${now}::timestamptz - interval '1 day')
    order by fired_at, event_id
  `.execute(ctx.db);
  const result = { sent: 0, suppressed: 0, failed: 0, errors: [] as string[] };
  const mark = (eventId: string, status: "sent" | "failed" | "suppressed", error: string | null) =>
    ctx.db
      .updateTable("alert_events")
      .set({ delivery_status: status, error, delivered_at: status === "sent" ? now : null })
      .where("event_id", "=", eventId)
      .execute();

  for (const e of pending.rows) {
    // Personal use: the only recipient is the owner's own address.
    if (e.user_id !== OWNER_USER_ID) {
      await mark(e.event_id, "suppressed", "emails go only to the owner");
      result.suppressed++;
      continue;
    }
    if (!d?.mailer || !d.to) {
      await mark(e.event_id, "suppressed", "email not configured (RESEND_API_KEY, ALERT_EMAIL_TO)");
      result.suppressed++;
      continue;
    }
    const sentToday = await sql<{ n: number }>`
      select count(*)::int as n from public.alert_events
      where user_id = ${e.user_id} and delivery_status = 'sent'
        and (delivered_at at time zone 'America/New_York')::date = ${today}::date
    `.execute(ctx.db);
    if ((sentToday.rows[0]?.n ?? 0) >= d.dailyCap) {
      await mark(e.event_id, "suppressed", `daily cap of ${d.dailyCap} emails reached`);
      result.suppressed++;
      continue;
    }
    const [subject = "Market Analysis alert", ...rest] = e.message.split("\n\n");
    try {
      await d.mailer.send({
        from: d.from,
        to: d.to,
        subject,
        text: rest.join("\n\n"),
        idempotencyKey: `alert-event-${e.event_id}`,
      });
      await mark(e.event_id, "sent", null);
      result.sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await mark(e.event_id, "failed", message.slice(0, 500));
      result.failed++;
      result.errors.push(message);
      ctx.log.warn({ eventId: e.event_id, err: message }, "alert email failed");
    }
  }
  return result;
}
