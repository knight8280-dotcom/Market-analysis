import { marketDateOf } from "@market/calendar";
import { FinraProvider } from "@market/market-data/adapters/finra";
import { compactTicker, namesAgree } from "@market/ownership";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { statusDelta, statusSnapshot } from "../http-stats";
import { JOBS } from "../queues";
import { recordIssues, type IssueRow } from "../repo/quality";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import { resolveSource, withProviderHealth } from "../routing";

/**
 * FINRA short interest for our listings (Phase 2 step H3, ADR-033). Each run asks for every
 * settlement date since five weeks before the latest one stored, so FINRA's revisions replace
 * what we had; the first run reaches back about a year.
 */
export const FIRST_RUN_DAYS = 400;
const REVISION_DAYS = 35;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Input = z.object({ from: Day.optional(), to: Day.optional() });

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function ingestShortInterest(ctx: WorkerContext, raw: unknown) {
  const input = Input.parse(raw ?? {});
  if (!ctx.providers.has("finra")) {
    return {
      configured: false as const,
      note: "Set FINRA_API_CLIENT_ID and FINRA_API_CLIENT_SECRET",
    };
  }
  const { route, source, provider } = await resolveSource(ctx, "short_interest");
  if (!(provider instanceof FinraProvider)) {
    throw new Error(`Short interest comes from FINRA, not ${source}`);
  }
  const today = marketDateOf(ctx.clock());
  const latest = await ctx.db
    .selectFrom("market.short_interest")
    .select((eb) => eb.fn.max("settlement_date").as("d"))
    .executeTakeFirst();
  const from =
    input.from ??
    (latest?.d ? addDays(String(latest.d), -REVISION_DAYS) : addDays(today, -FIRST_RUN_DAYS));
  const to = input.to ?? today;

  // Real listings only, by ticker without separators (FINRA writes BRK.B as BRKB).
  const securities = await ctx.db
    .selectFrom("market.securities as s")
    .select(["s.security_id", "s.ticker", "s.name"])
    .where("s.asset_class", "in", ["equity", "etf", "adr", "fund"])
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("market.provider_symbols as ps")
          .select("ps.security_id")
          .whereRef("ps.security_id", "=", "s.security_id")
          .where("ps.source", "<>", "synthetic"),
      ),
    )
    .execute();
  const bySymbol = new Map<string, typeof securities>();
  for (const s of securities) {
    const key = compactTicker(s.ticker);
    bySymbol.set(key, [...(bySymbol.get(key) ?? []), s]);
  }

  const runId = await startRun(ctx.db, {
    jobName: JOBS.ingestShortInterest,
    jobId: ctx.jobId,
    dataset: "short_interest",
    source,
    params: { from, to },
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  const before = statusSnapshot(provider);
  try {
    const records =
      bySymbol.size === 0
        ? []
        : await withProviderHealth(ctx, { route, source, dataset: "short_interest" }, () =>
            provider.getShortInterest({ symbols: [...bySymbol.keys()], from, to }),
          );
    counts.rows_fetched = records.length;
    const issues: IssueRow[] = [];
    const rows = [];
    for (const r of records) {
      for (const s of bySymbol.get(compactTicker(r.source_symbol)) ?? []) {
        if (r.issue_name && !namesAgree(r.issue_name, s.name)) {
          counts.rows_rejected += 1;
          issues.push({
            runId,
            dataset: "short_interest",
            source,
            securityId: s.security_id,
            date: r.settlement_date,
            rule: "short_interest_name_mismatch",
            severity: "warning",
            action: "skipped",
            message: `${s.ticker}: FINRA's ${r.source_symbol} is "${r.issue_name}", which does not agree with "${s.name}"`,
            payload: { symbol: r.source_symbol, issue_name: r.issue_name },
          });
          continue;
        }
        rows.push({
          security_id: s.security_id,
          settlement_date: r.settlement_date,
          symbol: r.source_symbol,
          issue_name: r.issue_name,
          market_class: r.market_class,
          short_interest: String(r.short_interest),
          previous_short_interest:
            r.previous_short_interest === null ? null : String(r.previous_short_interest),
          avg_daily_volume: r.avg_daily_volume === null ? null : String(r.avg_daily_volume),
          days_to_cover: r.days_to_cover === null ? null : String(r.days_to_cover),
          revised: r.revised,
          split_adjusted: r.split_adjusted,
          source,
          fetched_at: r.fetched_at,
        });
      }
    }
    if (rows.length > 0) {
      const result = await ctx.db
        .insertInto("market.short_interest")
        .values(rows)
        .onConflict((oc) =>
          oc.columns(["security_id", "settlement_date"]).doUpdateSet((eb) => ({
            symbol: eb.ref("excluded.symbol"),
            issue_name: eb.ref("excluded.issue_name"),
            market_class: eb.ref("excluded.market_class"),
            short_interest: eb.ref("excluded.short_interest"),
            previous_short_interest: eb.ref("excluded.previous_short_interest"),
            avg_daily_volume: eb.ref("excluded.avg_daily_volume"),
            days_to_cover: eb.ref("excluded.days_to_cover"),
            revised: eb.ref("excluded.revised"),
            split_adjusted: eb.ref("excluded.split_adjusted"),
            fetched_at: eb.ref("excluded.fetched_at"),
          })),
        )
        .executeTakeFirst();
      counts.rows_inserted = Number(result.numInsertedOrUpdatedRows ?? 0);
    }
    await recordIssues(ctx.db, issues);
    await finishRun(ctx.db, runId, {
      status: "succeeded",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      at: ctx.clock(),
    });
    const dates = [...new Set(rows.map((r) => r.settlement_date))].sort();
    return {
      configured: true as const,
      from,
      to,
      symbols: bySymbol.size,
      stored: rows.length,
      settlementDates: dates,
      rejected: issues.map((i) => i.message),
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
