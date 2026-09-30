import { marketDateOf, type IsoDate } from "@market/calendar";
import { sql } from "@market/db";
import { FredProvider } from "@market/market-data/adapters/fred";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { statusDelta, statusSnapshot } from "../http-stats";
import { JOBS } from "../queues";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import { resolveSource, withProviderHealth } from "../routing";
import { normalizeTicker } from "./edgar";

const Window = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const DAY = 86_400_000;
const addDays = (d: IsoDate, n: number) =>
  new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);

/**
 * Earnings calendar for the universe (Phase 1 step H1). Events are matched to listed equities by
 * ticker; synthetic securities are never matched to a real vendor's events. Future dates that a
 * company has moved are removed; past events (with actuals) are kept.
 */
export async function ingestEarnings(ctx: WorkerContext, raw: unknown) {
  const input = Window.parse(raw);
  const today = marketDateOf(ctx.clock());
  const from = input.from ?? addDays(today, -14);
  const to = input.to ?? addDays(today, 90);
  const { route, source, provider } = await resolveSource(ctx, "earnings");
  const runId = await startRun(ctx.db, {
    jobName: JOBS.ingestEarnings,
    jobId: ctx.jobId,
    dataset: "earnings",
    source,
    params: { from, to },
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  const before = statusSnapshot(provider);
  try {
    const events = await withProviderHealth(ctx, { route, source, dataset: "earnings" }, () =>
      provider.getEarningsCalendar({ from, to }),
    );
    counts.rows_fetched = events.length;
    const securities = await sql<{ security_id: string; ticker: string }>`
      select s.security_id, s.ticker from market.securities s
      where s.is_active and s.asset_class = 'equity'
        and exists (select 1 from market.provider_symbols ps
                    where ps.security_id = s.security_id and ps.source <> 'synthetic')
    `.execute(ctx.db);
    const byTicker = new Map(
      securities.rows.map((s) => [normalizeTicker(s.ticker), s.security_id]),
    );
    const kept: { securityId: string; date: string }[] = [];
    await ctx.db.transaction().execute(async (trx) => {
      for (const e of events) {
        const securityId = byTicker.get(normalizeTicker(e.source_symbol));
        if (!securityId) continue;
        kept.push({ securityId, date: e.report_date });
        const values = {
          hour: e.hour,
          fiscal_year: e.fiscal_year,
          fiscal_quarter: e.fiscal_quarter,
          eps_estimate: e.eps_estimate === null ? null : String(e.eps_estimate),
          eps_actual: e.eps_actual === null ? null : String(e.eps_actual),
          revenue_estimate: e.revenue_estimate === null ? null : String(e.revenue_estimate),
          revenue_actual: e.revenue_actual === null ? null : String(e.revenue_actual),
          fetched_at: e.fetched_at,
        };
        await trx
          .insertInto("market.earnings_events")
          .values({ security_id: securityId, source, report_date: e.report_date, ...values })
          .onConflict((oc) =>
            oc.columns(["security_id", "source", "report_date"]).doUpdateSet(values),
          )
          .execute();
      }
      counts.rows_inserted = kept.length;
      // A moved date: drop future rows in the window the vendor no longer lists.
      const removed = await trx
        .deleteFrom("market.earnings_events")
        .where("source", "=", source)
        .where("report_date", ">=", today > from ? today : from)
        .where("report_date", "<=", to)
        .where((eb) =>
          kept.length === 0
            ? eb.val(true)
            : eb.not(
                eb.or(
                  kept.map((k) =>
                    eb.and([eb("security_id", "=", k.securityId), eb("report_date", "=", k.date)]),
                  ),
                ),
              ),
        )
        .executeTakeFirst();
      counts.rows_updated = Number(removed.numDeletedRows);
    });
    await finishRun(ctx.db, runId, {
      status: "succeeded",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      at: ctx.clock(),
    });
    return {
      runId,
      from,
      to,
      fetched: events.length,
      matched: kept.length,
      removed: counts.rows_updated,
    };
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

/** Economic release dates from FRED (Phase 1 step H2). Moved future dates are removed. */
export async function ingestReleases(ctx: WorkerContext, raw: unknown) {
  const input = Window.parse(raw);
  const today = marketDateOf(ctx.clock());
  const from = input.from ?? addDays(today, -7);
  const to = input.to ?? addDays(today, 60);
  const fred = ctx.providers.get("fred");
  if (!(fred instanceof FredProvider)) throw new Error("FRED is not configured (FRED_ENABLED)");
  const runId = await startRun(ctx.db, {
    jobName: JOBS.ingestReleases,
    jobId: ctx.jobId,
    dataset: "macro",
    source: "fred",
    params: { from, to },
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  const before = statusSnapshot(fred);
  try {
    const route = { ...(await resolveSource(ctx, "macro")).route };
    const releases = await withProviderHealth(
      ctx,
      { route, source: "fred", dataset: "macro" },
      () => fred.getReleaseDates({ from, to }),
    );
    counts.rows_fetched = releases.length;
    await ctx.db.transaction().execute(async (trx) => {
      for (const r of releases) {
        await trx
          .insertInto("market.economic_releases")
          .values({
            source: "fred",
            release_id: r.release_id,
            name: r.name,
            release_date: r.release_date,
            fetched_at: r.fetched_at,
          })
          .onConflict((oc) =>
            oc.columns(["source", "release_id", "release_date"]).doUpdateSet({
              name: r.name,
              fetched_at: r.fetched_at,
            }),
          )
          .execute();
      }
      const removed = await trx
        .deleteFrom("market.economic_releases")
        .where("source", "=", "fred")
        .where("release_date", ">=", today > from ? today : from)
        .where("release_date", "<=", to)
        .where((eb) =>
          releases.length === 0
            ? eb.val(true)
            : eb.not(
                eb.or(
                  releases.map((r) =>
                    eb.and([
                      eb("release_id", "=", r.release_id),
                      eb("release_date", "=", r.release_date),
                    ]),
                  ),
                ),
              ),
        )
        .executeTakeFirst();
      counts.rows_inserted = releases.length;
      counts.rows_updated = Number(removed.numDeletedRows);
    });
    await finishRun(ctx.db, runId, {
      status: "succeeded",
      counts,
      httpStatusCounts: statusDelta(fred, before),
      at: ctx.clock(),
    });
    return { runId, from, to, releases: releases.length, removed: counts.rows_updated };
  } catch (err) {
    await finishRun(ctx.db, runId, {
      status: "failed",
      counts,
      httpStatusCounts: statusDelta(fred, before),
      error: err instanceof Error ? err.message : String(err),
      at: ctx.clock(),
    });
    throw err;
  }
}
