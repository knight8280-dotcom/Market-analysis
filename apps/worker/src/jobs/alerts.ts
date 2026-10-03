import {
  ALERT_KINDS,
  describeAlert,
  evaluateAlert,
  parseAlert,
  OWNERSHIP_KINDS,
  parseState,
  PHASE2_KINDS,
  screenFingerprint,
  SERIES_KINDS,
  type AlertDefinition,
  type AlertKind,
  type DailySeries,
  type Evaluation,
  type FilingItem,
  type InsiderPurchaseFiling,
  type LatestBar,
  type ScreenResults,
  type UpcomingEarnings,
} from "@market/alerts";
import { marketDateOf } from "@market/calendar";
import { OWNER_USER_ID, resolveFlags } from "@market/config";
import { sql } from "@market/db";
import { licenseFor, ProviderId } from "@market/market-data";
import { ownersLabel, roleOf, type OwnerLike } from "@market/ownership";
import { endpointLabel, sendPush } from "@market/push";
import { Screen, screenMembers } from "@market/screener";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { JOBS, jobId } from "../queues";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import { routeFor } from "../routing";

const DEFAULT_APP_URL = "http://localhost:3000";
/** Calendar days of adjusted bars for indicator and volume conditions (about 550 sessions). */
const SERIES_DAYS = 800;
const TRIGGERS = ["schedule", "bars", "filings", "insiders", "screener", "manual"] as const;
type Trigger = (typeof TRIGGERS)[number];

const Input = z.object({
  /** Evaluate the latest bar on or before this date (default: the latest bar). */
  through: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Only alerts on these securities (runs prompted by new bars or filings). */
  securityIds: z
    .array(z.string().regex(/^\d{1,18}$/))
    .max(5000)
    .optional(),
  /** Only alerts of these kinds. */
  kinds: z.array(z.enum(ALERT_KINDS)).optional(),
  /** What prompted the run, kept with its run record. */
  trigger: z.enum(TRIGGERS).default("schedule"),
});

interface AlertRow {
  alert_id: string;
  user_id: string;
  kind: string;
  params: unknown;
  state: unknown;
  cooldown_hours: number;
  last_fired_at: Date | null;
  snoozed_until: Date | null;
  created_at: Date;
  security_id: string | null;
  ticker: string | null;
  cik: string | null;
  screen_id: string | null;
  screen_name: string | null;
  screen_definition: unknown;
}

const isPhase2 = (kind: AlertKind) => (PHASE2_KINDS as readonly AlertKind[]).includes(kind);
const needsOwnership = (kind: AlertKind) =>
  (OWNERSHIP_KINDS as readonly AlertKind[]).includes(kind);

/** Notification links: a path in the app or a filing on www.sec.gov (the table checks it too). */
function safeHref(href: string | null): string | null {
  if (!href) return null;
  return /^\/[^/\\]/.test(href) || href.startsWith("https://www.sec.gov/") ? href : null;
}

/**
 * Evaluates active alerts against the latest end-of-day bars, adjusted series, upcoming
 * earnings, newly stored filings and saved screens' results; records each new event with an
 * in-app notification, then emails new events to the owner (Phase 1 steps I2 and I3, Phase 2
 * steps E1 to E3).
 *
 * - Runs at 18:50 ET for everything, and within seconds of new data for the alerts that data
 *   concerns: after an end-of-day load, a filings refresh or a screener rebuild (step E2).
 * - Idempotent: an event is unique per (alert, key), so re-running never fires twice.
 * - Delivery is separate from firing: events start "pending" and become "sent", "failed"
 *   (retried by the job's own retries within a day) or "suppressed" (no email configured, or
 *   over the daily cap). Resend's idempotency key stops a retry from sending a second copy.
 * - The Phase 2 kinds are evaluated only while the `alert_types` flag is on, and notifications
 *   are written only while the `notifications` flag is on.
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
    const flags = resolveFlags(
      await ctx.db.selectFrom("ops.feature_flags").select(["key", "enabled"]).execute(),
    );
    const rows = await sql<AlertRow>`
      select a.alert_id::text, a.user_id::text, a.kind, a.params, a.state, a.cooldown_hours,
        a.last_fired_at, a.snoozed_until, a.created_at, a.security_id::text, s.ticker, s.cik,
        a.screen_id::text, sc.name as screen_name, sc.definition as screen_definition
      from public.alerts a
      left join market.securities s on s.security_id = a.security_id
      left join public.saved_screens sc on sc.screen_id = a.screen_id
      where a.active
        ${input.securityIds ? sql`and a.security_id = any(${input.securityIds}::bigint[])` : sql``}
        ${input.kinds ? sql`and a.kind = any(${input.kinds}::text[])` : sql``}
      order by a.alert_id
    `.execute(ctx.db);
    counts.rows_fetched = rows.rows.length;

    const alerts = rows.rows.map((row) => ({ row, def: parseAlert(row.kind, row.params) }));
    const securitiesFor = (kinds: readonly AlertKind[]) => [
      ...new Set(
        alerts.flatMap(({ row, def }) =>
          def && row.security_id && kinds.includes(def.kind) ? [row.security_id] : [],
        ),
      ),
    ];
    const seriesKinds = flags.alert_types ? SERIES_KINDS : [];
    const [bars, earnings, series] = await Promise.all([
      latestBars(ctx, source, securitiesFor(["price_above", "price_below", "pct_move"]), through),
      upcomingEarnings(ctx, securitiesFor(["earnings_upcoming"]), today),
      adjustedSeries(ctx, source, securitiesFor(seriesKinds), through, today),
    ]);
    const screens = new Map<string, ScreenResults | null>();

    const attribution = licenseFor(source).attribution.text;
    const sample = source === "synthetic";
    const appUrl = ctx.alertDelivery?.appUrl ?? DEFAULT_APP_URL;
    const outcome = {
      fired: 0,
      notMet: 0,
      cooldown: 0,
      snoozed: 0,
      baseline: 0,
      noData: 0,
      invalid: 0,
      disabled: 0,
      duplicate: 0,
    };
    for (const { row: r, def } of alerts) {
      if (!def) {
        outcome.invalid++;
        continue;
      }
      if (
        (isPhase2(def.kind) && !flags.alert_types) ||
        (needsOwnership(def.kind) && !flags.ownership)
      ) {
        outcome.disabled++;
        continue;
      }
      const sid = r.security_id;
      const state = parseState(r.state);
      const result = evaluateAlert(def, {
        ticker: r.ticker ?? "",
        bar: sid ? (bars.get(sid) ?? null) : null,
        earnings: sid ? (earnings.get(sid) ?? null) : null,
        series: sid ? (series.get(sid) ?? null) : null,
        filings:
          def.kind === "new_filing" && r.cik
            ? await storedFilings(ctx, r.cik, r.created_at, state.filingsSeenThrough)
            : null,
        screen: def.kind === "screen_membership" ? await screenResults(ctx, r, screens) : null,
        insiderPurchases:
          def.kind === "insider_purchase" && r.cik
            ? await insiderPurchases(ctx, r.cik, r.created_at, state.insidersSeenThrough)
            : null,
        today,
        now,
        lastFiredAt: r.last_fired_at,
        cooldownHours: r.cooldown_hours,
        snoozedUntil: r.snoozed_until,
        state,
      });
      if (!result.fire) {
        if (result.reason === "cooldown") outcome.cooldown++;
        else if (result.reason === "snoozed") outcome.snoozed++;
        else if (result.reason === "baseline") outcome.baseline++;
        else if (result.reason === "no_data") outcome.noData++;
        else outcome.notMet++;
        if (result.state) {
          await ctx.db
            .updateTable("alerts")
            .set({ state: JSON.stringify(result.state) })
            .where("alert_id", "=", r.alert_id)
            .execute();
        }
        continue;
      }

      const dataLine = sourceLine(def, result, attribution);
      const sampleLine = sample
        ? "SAMPLE DATA: this environment uses synthetic prices, not real market data."
        : null;
      const subject = `${sample ? "[SAMPLE DATA] " : ""}${result.subject}`;
      const watched =
        def.kind === "screen_membership"
          ? `screen “${r.screen_name ?? "?"}”: ${describeAlert(def)}`
          : `${r.ticker}: ${describeAlert(def)}`;
      const footer = [
        dataLine,
        sampleLine,
        `Your alert on ${watched}.`,
        `Manage this alert (snooze, pause or delete): ${appUrl}/alerts/${r.alert_id}`,
        flags.notifications ? `All notifications: ${appUrl}/notifications` : null,
        "Informational only; not investment advice.",
      ].filter(Boolean);
      const message = `${subject}\n\n${result.text}\n\n${footer.join("\n")}`;
      const body = [result.summary ?? result.text, "", dataLine, sampleLine]
        .filter((l) => l !== null)
        .join("\n");

      const inserted = await ctx.db.transaction().execute(async (trx) => {
        const event = await trx
          .insertInto("alert_events")
          .values({
            alert_id: r.alert_id,
            user_id: r.user_id,
            bar_date: result.date,
            event_key: result.key,
            message,
            summary: body.slice(0, 4000),
            fired_at: now,
          })
          .onConflict((oc) => oc.columns(["alert_id", "event_key"]).doNothing())
          .returning("event_id")
          .executeTakeFirst();
        const state = result.state ? { state: JSON.stringify(result.state) } : {};
        if (event) {
          await trx
            .updateTable("alerts")
            .set({ last_fired_at: now, ...state })
            .where("alert_id", "=", r.alert_id)
            .execute();
          if (flags.notifications) {
            await trx
              .insertInto("notifications")
              .values({
                user_id: r.user_id,
                event_id: event.event_id,
                title: result.subject.slice(0, 300),
                body: body.slice(0, 4000),
                href: safeHref(result.href),
                created_at: now,
              })
              .execute();
          }
        } else if (result.state) {
          await trx.updateTable("alerts").set(state).where("alert_id", "=", r.alert_id).execute();
        }
        return Boolean(event);
      });
      if (inserted) outcome.fired++;
      else outcome.duplicate++;
    }
    counts.rows_inserted = outcome.fired;

    const delivery = await deliverPending(ctx, now, today);
    const push = await deliverPushPending(ctx, now, today, flags.push);
    counts.rows_updated = delivery.sent + push.sent;
    // Let the queue retry; firing is idempotent and delivery resumes where it stopped. A push
    // service that refuses a message is recorded, not retried by the queue: it would refuse
    // again.
    const failures = [
      delivery.failed > 0 ? `${delivery.failed} alert email(s) failed` : null,
      push.retry > 0 ? `${push.retry} push notification(s) to retry` : null,
    ].filter(Boolean);
    if (failures.length > 0) {
      throw new Error(`${failures.join(", ")}: ${[...delivery.errors, ...push.errors].join("; ")}`);
    }
    await finishRun(ctx.db, runId, { status: "succeeded", counts, at: ctx.clock() });
    return {
      runId,
      source,
      today,
      trigger: input.trigger,
      evaluated: rows.rows.length,
      ...outcome,
      delivery,
      push,
    };
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

/** Where the event's figures come from, with their date (spec: every number has a source). */
function sourceLine(
  def: AlertDefinition,
  result: Extract<Evaluation, { fire: true }>,
  attribution: string,
): string {
  switch (def.kind) {
    case "earnings_upcoming":
      return "Earnings dates: Finnhub (personal use).";
    case "new_filing":
      return "Filings: SEC EDGAR (public domain).";
    case "insider_purchase":
      return "Insider transactions: Form 4 filings, SEC EDGAR (public domain).";
    case "screen_membership":
      return `Screener snapshot as of ${result.date}, built from end-of-day data. ${attribution}.`;
    default:
      return `End-of-day data as of ${result.date}. ${attribution}.`;
  }
}

/**
 * Queues an evaluation as soon as new data is stored (step E2), when some active alert would
 * look at it. The job id names the ingestion run, so dispatching twice is a no-op.
 */
export async function queueAlertEvaluation(
  ctx: WorkerContext,
  opts: {
    trigger: Exclude<Trigger, "schedule" | "manual">;
    runId: string;
    securityIds?: string[];
    kinds: readonly AlertKind[];
  },
): Promise<boolean> {
  const { securityIds, kinds } = opts;
  if (securityIds?.length === 0) return false;
  const found = await sql<{ found: boolean }>`
    select exists (
      select 1 from public.alerts a
      where a.active and a.kind = any(${kinds}::text[])
        ${securityIds ? sql`and a.security_id = any(${securityIds}::bigint[])` : sql``}
    ) as found
  `.execute(ctx.db);
  if (!found.rows[0]?.found) return false;
  await ctx.dispatch.dispatch({
    name: JOBS.evaluateAlerts,
    data: { trigger: opts.trigger, kinds: [...kinds], ...(securityIds ? { securityIds } : {}) },
    jobId: jobId(JOBS.evaluateAlerts, opts.trigger, opts.runId),
  });
  return true;
}

/** The latest bar on or before `through` and the one before it, in the latest bar's split basis. */
async function latestBars(
  ctx: WorkerContext,
  source: ProviderId,
  ids: string[],
  through: string,
): Promise<Map<string, LatestBar>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{
    security_id: string;
    date: string | null;
    close: number | null;
    prev_date: string | null;
    prev_close: number | null;
  }>`
    select s.security_id::text, t.date, t.close::float8 as close, y.date as prev_date,
      y.close::float8 * coalesce(fy.split_factor, 1) / coalesce(ft.split_factor, 1) as prev_close
    from unnest(${ids}::bigint[]) as s(security_id)
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
  `.execute(ctx.db);
  const out = new Map<string, LatestBar>();
  for (const r of rows.rows) {
    if (r.date && r.close !== null) {
      out.set(r.security_id, {
        date: r.date,
        close: r.close,
        prevDate: r.prev_date,
        prevClose: r.prev_close,
      });
    }
  }
  return out;
}

async function upcomingEarnings(
  ctx: WorkerContext,
  ids: string[],
  today: string,
): Promise<Map<string, UpcomingEarnings>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ security_id: string; report_date: string; hour: string | null }>`
    select distinct on (security_id) security_id::text, report_date, hour
    from market.earnings_events
    where security_id = any(${ids}::bigint[]) and report_date > ${today}::date
    order by security_id, report_date
  `.execute(ctx.db);
  return new Map(rows.rows.map((r) => [r.security_id, { date: r.report_date, hour: r.hour }]));
}

/** Adjusted closes and split-adjusted volumes up to `through`, oldest first. */
async function adjustedSeries(
  ctx: WorkerContext,
  source: ProviderId,
  ids: string[],
  through: string,
  today: string,
): Promise<Map<string, DailySeries>> {
  if (ids.length === 0) return new Map();
  const end = through < today ? through : today;
  const from = new Date(Date.parse(`${end}T00:00:00Z`) - SERIES_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows = await sql<{ security_id: string; date: string; close: number; volume: number }>`
    select security_id::text, date, close, volume
    from market.prices_daily_adjusted
    where source = ${source} and security_id = any(${ids}::bigint[])
      and date > ${from}::date and date <= ${through}::date
    order by security_id, date
  `.execute(ctx.db);
  const out = new Map<string, DailySeries>();
  for (const r of rows.rows) {
    let s = out.get(r.security_id);
    if (!s) out.set(r.security_id, (s = { dates: [], close: [], volume: [] }));
    s.dates.push(r.date);
    s.close.push(r.close);
    s.volume.push(r.volume);
  }
  return out;
}

/** Filings accepted after the alert was created and stored after it last looked. */
async function storedFilings(
  ctx: WorkerContext,
  cik: string,
  createdAt: Date,
  seenThrough: string | undefined,
): Promise<FilingItem[]> {
  const rows = await sql<{
    accession_no: string;
    form_type: string;
    filed_at: Date;
    filing_date: string;
    url: string;
    ingested_at: Date;
  }>`
    select accession_no, form_type, filed_at, filing_date, url, ingested_at
    from market.filings
    where cik = ${cik} and filed_at > ${createdAt}
      and ingested_at > ${seenThrough ?? "-infinity"}::timestamptz
    order by ingested_at, accession_no
    limit 500
  `.execute(ctx.db);
  return rows.rows.map((f) => ({
    accessionNo: f.accession_no,
    form: f.form_type,
    filedAt: f.filed_at,
    filingDate: f.filing_date,
    url: f.url,
    storedAt: f.ingested_at,
  }));
}

/**
 * Form 4s (not amendments) for the company, accepted after the alert was created and read after
 * it last looked, that report at least one open-market purchase (code P, Table I, acquired).
 */
async function insiderPurchases(
  ctx: WorkerContext,
  cik: string,
  createdAt: Date,
  seenThrough: string | undefined,
): Promise<InsiderPurchaseFiling[]> {
  const rows = await sql<{
    accession_no: string;
    filed_at: Date;
    filing_date: string | null;
    url: string;
    fetched_at: Date;
    owners: OwnerLike[];
    lines: { date: string; shares: string | null; price: string | null }[];
  }>`
    select f.accession_no, f.filed_at, f.url, f.fetched_at, f.owners,
      (select fl.filing_date from market.filings fl where fl.accession_no = f.accession_no limit 1)
        as filing_date,
      json_agg(json_build_object('date', t.transaction_date, 'shares', t.shares, 'price', t.price)
               order by t.line) as lines
    from market.insider_filings f
    join market.insider_transactions t on t.accession_no = f.accession_no
    where f.issuer_cik = ${cik} and f.form_type = '4' and f.filed_at > ${createdAt}
      and f.fetched_at > ${seenThrough ?? "-infinity"}::timestamptz
      and t.code = 'P' and not t.derivative and t.acquired_disposed = 'A'
    group by f.accession_no
    order by f.fetched_at, f.accession_no
    limit 200
  `.execute(ctx.db);
  return rows.rows.map((f) => ({
    accessionNo: f.accession_no,
    filedAt: f.filed_at,
    filingDate: f.filing_date ?? marketDateOf(f.filed_at),
    url: f.url,
    storedAt: f.fetched_at,
    insider: ownersLabel(f.owners),
    role: f.owners[0] ? roleOf(f.owners[0]) : "Reporting person",
    lines: f.lines.map((l) => ({
      date: l.date,
      shares: l.shares === null ? null : Number(l.shares),
      price: l.price === null ? null : Number(l.price),
    })),
  }));
}

/** A saved screen's results on the current snapshot, computed once per screen per run. */
async function screenResults(
  ctx: WorkerContext,
  r: AlertRow,
  cache: Map<string, ScreenResults | null>,
): Promise<ScreenResults | null> {
  if (!r.screen_id) return null;
  if (cache.has(r.screen_id)) return cache.get(r.screen_id)!;
  const parsed = Screen.safeParse(r.screen_definition);
  let results: ScreenResults | null = null;
  if (parsed.success) {
    const { members, asOf } = await screenMembers(ctx.db, parsed.data);
    if (asOf) {
      results = {
        screenId: r.screen_id,
        name: r.screen_name ?? "",
        definition: screenFingerprint(parsed.data),
        asOf,
        members,
      };
    }
  }
  cache.set(r.screen_id, results);
  return results;
}

async function deliverPending(ctx: WorkerContext, now: Date, today: string) {
  const d = ctx.alertDelivery;
  const pending = await sql<{
    event_id: string;
    user_id: string;
    message: string;
    channels: string[];
  }>`
    select e.event_id::text, e.user_id::text, e.message, a.channels
    from public.alert_events e join public.alerts a on a.alert_id = e.alert_id
    where e.delivery_status = 'pending'
       or (e.delivery_status = 'failed' and e.fired_at > ${now}::timestamptz - interval '1 day')
    order by e.fired_at, e.event_id
  `.execute(ctx.db);
  const result = { sent: 0, suppressed: 0, failed: 0, errors: [] as string[] };
  const mark = (eventId: string, status: "sent" | "failed" | "suppressed", error: string | null) =>
    ctx.db
      .updateTable("alert_events")
      .set({ delivery_status: status, error, delivered_at: status === "sent" ? now : null })
      .where("event_id", "=", eventId)
      .execute();

  for (const e of pending.rows) {
    if (!e.channels.includes("email")) {
      await mark(e.event_id, "suppressed", "email not chosen for this alert");
      result.suppressed++;
      continue;
    }
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

/** How long a push service keeps an alert for a device that is off: a day. */
const PUSH_TTL_SECONDS = 24 * 3600;

/**
 * Push notifications for fired alerts (Phase 2 step J2, ADR-038), to every device the owner
 * turned push on for. An event counts as pushed when at least one device took it. Devices the
 * push service no longer knows are removed; the others keep their latest error for the
 * settings page.
 */
async function deliverPushPending(
  ctx: WorkerContext,
  now: Date,
  today: string,
  switchedOn: boolean,
) {
  const d = ctx.alertDelivery;
  const sender = d?.push ?? null;
  const pending = await sql<{
    event_id: string;
    user_id: string;
    alert_id: string;
    message: string;
    summary: string | null;
    channels: string[];
  }>`
    select e.event_id::text, e.user_id::text, e.alert_id::text, e.message, e.summary, a.channels
    from public.alert_events e join public.alerts a on a.alert_id = e.alert_id
    where e.push_status = 'pending'
       or (e.push_status = 'failed' and e.fired_at > ${now}::timestamptz - interval '1 day')
    order by e.fired_at, e.event_id
  `.execute(ctx.db);
  const result = {
    sent: 0,
    suppressed: 0,
    failed: 0,
    retry: 0,
    removed: 0,
    errors: [] as string[],
  };
  const mark = (eventId: string, status: "sent" | "failed" | "suppressed", error: string | null) =>
    ctx.db
      .updateTable("alert_events")
      .set({
        push_status: status,
        push_error: error?.slice(0, 500) ?? null,
        push_sent_at: status === "sent" ? now : null,
      })
      .where("event_id", "=", eventId)
      .execute();
  const suppress = async (eventId: string, why: string) => {
    await mark(eventId, "suppressed", why);
    result.suppressed++;
  };

  for (const e of pending.rows) {
    if (!e.channels.includes("push")) {
      await suppress(e.event_id, "push not chosen for this alert");
      continue;
    }
    if (!switchedOn) {
      await suppress(e.event_id, "push notifications are switched off (Settings)");
      continue;
    }
    if (e.user_id !== OWNER_USER_ID) {
      await suppress(e.event_id, "push notifications go only to the owner");
      continue;
    }
    if (!d || !sender) {
      await suppress(
        e.event_id,
        "push not configured (WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY, WEB_PUSH_CONTACT)",
      );
      continue;
    }
    const devices = await ctx.db
      .selectFrom("push_subscriptions")
      .select(["subscription_id", "endpoint", "p256dh", "auth", "device"])
      .where("user_id", "=", e.user_id)
      .orderBy("subscription_id")
      .execute();
    if (devices.length === 0) {
      await suppress(e.event_id, "no device has push notifications turned on");
      continue;
    }
    const sentToday = await sql<{ n: number }>`
      select count(*)::int as n from public.alert_events
      where user_id = ${e.user_id} and push_status = 'sent'
        and (push_sent_at at time zone 'America/New_York')::date = ${today}::date
    `.execute(ctx.db);
    if ((sentToday.rows[0]?.n ?? 0) >= d.dailyCap) {
      await suppress(e.event_id, `daily cap of ${d.dailyCap} push notifications reached`);
      continue;
    }

    const [title = "Market Analysis alert"] = e.message.split("\n\n");
    const payload = {
      v: 1,
      title: title.slice(0, 120),
      body: (e.summary ?? "").slice(0, 400),
      url: `/alerts/${e.alert_id}`,
      tag: `alert-${e.alert_id}`,
      alertId: Number(e.alert_id),
      eventId: Number(e.event_id),
    };
    let delivered = 0;
    let retry = false;
    const problems: string[] = [];
    for (const device of devices) {
      const sent = await sendPush(
        device,
        { payload, ttlSeconds: PUSH_TTL_SECONDS, topic: `alert-${e.alert_id}`, now },
        sender,
      );
      const row = ctx.db
        .updateTable("push_subscriptions")
        .where("subscription_id", "=", device.subscription_id);
      if (sent.outcome === "sent") {
        delivered++;
        await row.set({ last_sent_at: now, failures: 0, last_error: null }).execute();
      } else if (sent.outcome === "gone") {
        // The browser unsubscribed or its subscription expired.
        await ctx.db
          .deleteFrom("push_subscriptions")
          .where("subscription_id", "=", device.subscription_id)
          .execute();
        result.removed++;
      } else {
        const why = `${sent.status ?? "no answer"} ${sent.detail}`.trim().slice(0, 300);
        problems.push(`${device.device}: ${why}`);
        retry ||= sent.outcome === "retry";
        await row.set((eb) => ({ failures: eb("failures", "+", 1), last_error: why })).execute();
        ctx.log.warn(
          { eventId: e.event_id, service: endpointLabel(device.endpoint), outcome: sent.outcome },
          "push notification not delivered",
        );
      }
    }
    if (delivered > 0) {
      await mark(e.event_id, "sent", problems.length > 0 ? problems.join("; ") : null);
      result.sent++;
    } else if (problems.length === 0) {
      await suppress(e.event_id, "no device has push notifications turned on");
    } else {
      await mark(e.event_id, "failed", problems.join("; "));
      result.failed++;
      if (retry) result.retry++;
      result.errors.push(...problems);
    }
  }
  return result;
}
