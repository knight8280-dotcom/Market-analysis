import { BAR_KINDS } from "@market/alerts";
import { isTradingDay, previousTradingDay, type IsoDate } from "@market/calendar";
import {
  ProviderId,
  validateDailyBars,
  type DailyBar,
  type CorporateAction,
} from "@market/market-data";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { statusDelta, statusSnapshot } from "../http-stats";
import { queueAlertEvaluation } from "./alerts";
import { JOBS, jobId } from "../queues";
import { actionsFor, upsertActions } from "../repo/actions";
import { mergeDailyBars, previousClose } from "../repo/prices";
import { recordIssues, type IssueRow } from "../repo/quality";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import { mappingsFor, securityOn, symbolsListedOn } from "../repo/securities";
import { resolveSource, withProviderHealth } from "../routing";

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const IngestEodInput = z.object({
  /** Vendor symbol. */
  symbol: z.string().min(1),
  start: IsoDateSchema,
  end: IsoDateSchema,
  /** Bypass routing (backfills and tests). */
  source: ProviderId.optional(),
});
export type IngestEodInput = z.infer<typeof IngestEodInput>;

/**
 * Fetches raw daily bars and corporate actions for one vendor symbol and date range, validates
 * them, and merges them idempotently (spec §3.4, §3.7). Bars are attributed to securities by
 * date through provider_symbols, so a reused ticker's history lands on the right security.
 * New or changed corporate actions trigger an adjustment recompute.
 */
export async function ingestEod(ctx: WorkerContext, raw: unknown) {
  const input = IngestEodInput.parse(raw);
  const { route, source, provider } = await resolveSource(ctx, "daily_bars", input.source);
  const runId = await startRun(ctx.db, {
    jobName: JOBS.ingestEod,
    jobId: ctx.jobId,
    dataset: "daily_bars",
    source,
    params: input,
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  const before = statusSnapshot(provider);
  const changed = new Map<string, string>();

  try {
    const call = { route, source, dataset: "daily_bars" as const };
    const range = { symbol: input.symbol, start: input.start, end: input.end };
    const [bars, actions] = await withProviderHealth(ctx, call, () =>
      Promise.all([provider.getDailyBars(range), provider.getCorporateActions(range)]),
    );
    counts.rows_fetched = bars.length;

    const mappings = await mappingsFor(ctx.db, source, input.symbol);
    const barsBySecurity = new Map<string, DailyBar[]>();
    const actionsBySecurity = new Map<string, CorporateAction[]>();
    const issues: IssueRow[] = [];
    for (const bar of bars) {
      const securityId = securityOn(mappings, bar.date);
      if (!securityId) {
        counts.rows_rejected += 1;
        issues.push({
          runId,
          dataset: "daily_bars",
          source,
          securityId: null,
          date: bar.date,
          rule: "unmapped_symbol",
          severity: "error",
          action: "skipped",
          message: `${source} symbol ${input.symbol} is not mapped to a security on ${bar.date}; run ingest-securities`,
          payload: { symbol: input.symbol },
        });
        continue;
      }
      barsBySecurity.set(securityId, [...(barsBySecurity.get(securityId) ?? []), bar]);
    }
    for (const action of actions) {
      const securityId = securityOn(mappings, action.ex_date);
      if (securityId)
        actionsBySecurity.set(securityId, [...(actionsBySecurity.get(securityId) ?? []), action]);
    }

    const recompute = new Set<string>();
    for (const securityId of new Set([...barsBySecurity.keys(), ...actionsBySecurity.keys()])) {
      if ((await upsertActions(ctx.db, securityId, actionsBySecurity.get(securityId) ?? [])) > 0) {
        recompute.add(securityId);
      }
      const secBars = barsBySecurity.get(securityId) ?? [];
      if (secBars.length === 0) continue;
      const known = await actionsFor(ctx.db, securityId);
      const first = secBars.reduce((min, b) => (b.date < min ? b.date : min), secBars[0]!.date);
      const result = validateDailyBars(secBars, {
        previousClose: await previousClose(ctx.db, { securityId, source, before: first }),
        actionDates: new Set(known.map((a) => a.ex_date)),
        isTradingDay,
      });
      for (const issue of result.issues) {
        if (issue.action === "rejected") {
          // A conflicting duplicate rejects every copy of the bar.
          const copies = issue.payload.bars;
          counts.rows_rejected += Array.isArray(copies) ? copies.length : 1;
        }
        if (issue.action === "flagged") counts.rows_flagged += 1;
        issues.push({
          runId,
          dataset: "daily_bars",
          source,
          securityId,
          date: issue.date,
          rule: issue.rule,
          severity: issue.severity,
          action: issue.action,
          message: issue.message,
          payload: issue.payload,
        });
      }
      const merged = await mergeDailyBars(ctx.db, {
        securityId,
        source,
        bars: result.accepted,
        runId,
      });
      counts.rows_inserted += merged.inserted;
      counts.rows_updated += merged.updated;
      counts.rows_unchanged += merged.unchanged;
      if (merged.inserted + merged.updated > 0) {
        const latest = result.accepted.reduce((d, b) => (b.date > d ? b.date : d), "");
        if (latest > (changed.get(securityId) ?? "")) changed.set(securityId, latest);
      }
      // A corrected bar can change a dividend factor (it depends on the prior close).
      if (merged.updated > 0 && known.some((a) => a.cash_amount !== null))
        recompute.add(securityId);
    }
    await recordIssues(ctx.db, issues);

    for (const securityId of recompute) {
      await ctx.dispatch.dispatch({
        name: JOBS.recomputeAdjustments,
        data: { securityId },
        jobId: jobId(JOBS.recomputeAdjustments, securityId, runId),
      });
    }
    await finishRun(ctx.db, runId, {
      status: "succeeded",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      at: ctx.clock(),
    });
    // Live views (watchlists) refresh the securities whose bars changed.
    for (const [securityId, date] of changed) {
      await ctx.events.emit({ type: "bars_updated", securityId, date, source, at: ctx.clock() });
    }
    // Alerts on these securities are checked now rather than at 18:50 (Phase 2 step E2).
    await queueAlertEvaluation(ctx, {
      trigger: "bars",
      runId,
      securityIds: [...changed.keys()],
      kinds: BAR_KINDS,
    });
    return { runId, source, ...counts };
  } catch (err) {
    await finishRun(ctx.db, runId, {
      status: "failed",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      error: err instanceof Error ? err.message : String(err),
      at: ctx.clock(),
    });
    throw err;
  }
}

export const ScheduleEodInput = z.object({ date: IsoDateSchema, source: ProviderId.optional() });

/** Fans out one ingest-eod job per vendor symbol listed on `date` (scheduled after the close). */
export async function scheduleEod(ctx: WorkerContext, raw: unknown) {
  const { date, source: override } = ScheduleEodInput.parse(raw);
  if (!isTradingDay(date)) return { date, jobs: 0 };
  const { source } = await resolveSource(ctx, "daily_bars", override);
  const symbols = await symbolsListedOn(ctx.db, source, date);
  for (const symbol of symbols) {
    await ctx.dispatch.dispatch({
      name: JOBS.ingestEod,
      data: { symbol, start: date, end: date, ...(override ? { source: override } : {}) },
      jobId: jobId(JOBS.ingestEod, date, symbol),
    });
  }
  return { date, source, jobs: symbols.length };
}

export const ReconcileEodInput = z.object({
  /** Last trading date to reconcile (inclusive). */
  through: IsoDateSchema,
  days: z.number().int().min(1).max(30).default(5),
});

/**
 * Re-ingests the last N trading days nightly so late and corrected prints are picked up; the
 * merge logs every change in ops.data_corrections (spec §3.7).
 */
export async function reconcileEod(ctx: WorkerContext, raw: unknown) {
  const { through, days } = ReconcileEodInput.parse(raw);
  let start = through;
  for (let i = 1; i < days; i += 1) start = previousTradingDay(start);
  const { source } = await resolveSource(ctx, "daily_bars");
  // Anything listed at either end of the window (covers delistings and IPOs inside it).
  const symbols = [
    ...new Set([
      ...(await symbolsListedOn(ctx.db, source, start)),
      ...(await symbolsListedOn(ctx.db, source, through)),
    ]),
  ].sort();
  for (const symbol of symbols) {
    await ctx.dispatch.dispatch({
      name: JOBS.ingestEod,
      data: { symbol, start, end: through },
      jobId: jobId(JOBS.reconcileEod, through, symbol),
    });
  }
  return { start, through, jobs: symbols.length };
}

export type { IsoDate };
