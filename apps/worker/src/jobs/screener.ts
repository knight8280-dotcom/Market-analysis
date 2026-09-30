import { sql, type MarketScreenerSnapshot } from "@market/db";
import { ProviderId } from "@market/market-data";
import {
  computeSnapshot,
  trailingTwelveMonths,
  type AdjustedBar,
  type QuarterFigures,
  type SnapshotFundamentals,
} from "@market/screener";
import type { Insertable } from "kysely";
import type { WorkerContext } from "../context";
import { JOBS } from "../queues";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import { routeFor } from "../routing";

const DAY = 86_400_000;
const back = (iso: string, days: number) =>
  new Date(Date.parse(iso) - days * DAY).toISOString().slice(0, 10);

/**
 * Rebuilds market.screener_snapshot from stored bars, corporate actions and statements (Phase 1
 * step F1). Runs after the end-of-day deadline; no provider call.
 */
export async function refreshScreener(ctx: WorkerContext) {
  const route = await routeFor(ctx, "daily_bars");
  const source = ProviderId.parse(route.active ?? route.primary);
  const runId = await startRun(ctx.db, {
    jobName: JOBS.refreshScreener,
    jobId: ctx.jobId,
    dataset: "screener",
    source,
    params: {},
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  try {
    const latest = await ctx.db
      .selectFrom("market.prices_daily")
      .select((eb) => eb.fn.max("date").as("date"))
      .where("source", "=", source)
      .executeTakeFirst();
    const asOf = latest?.date ?? null;
    if (!asOf) {
      await finishRun(ctx.db, runId, { status: "succeeded", counts, at: ctx.clock() });
      return { runId, source, asOf: null, securities: 0 };
    }

    // Securities with a bar in the last 30 days, with their latest raw close.
    const securities = await sql<{
      security_id: string;
      ticker: string;
      name: string;
      asset_class: string;
      exchange_mic: string | null;
      sector: string | null;
      industry: string | null;
      cik: string | null;
      date: string;
      close: string;
    }>`
      select distinct on (s.security_id) s.security_id, s.ticker, s.name, s.asset_class,
        s.exchange_mic, s.sector, s.industry, s.cik, p.date, p.close
      from market.securities s
      join market.prices_daily p on p.security_id = s.security_id and p.source = ${source}
      where s.is_active and p.date >= ${back(asOf, 30)}::date
      order by s.security_id, p.date desc
    `.execute(ctx.db);

    const bars = new Map<string, AdjustedBar[]>();
    const rows = await sql<{
      security_id: string;
      date: string;
      close: number;
      high: number;
      low: number;
      volume: number;
    }>`
      select security_id, date, close, high, low, volume
      from market.prices_daily_adjusted
      where source = ${source} and date >= ${back(asOf, 400)}::date
      order by security_id, date
    `.execute(ctx.db);
    counts.rows_fetched = rows.rows.length;
    for (const r of rows.rows) {
      const list = bars.get(r.security_id) ?? [];
      list.push({ date: r.date, close: r.close, high: r.high, low: r.low, volume: r.volume });
      bars.set(r.security_id, list);
    }

    const dividends = new Map(
      (
        await sql<{ security_id: string; total: number }>`
          select ca.security_id, sum(ca.cash_amount::float8 * coalesce(f.split_factor, 1)) as total
          from market.corporate_actions ca
          left join lateral (
            select af.split_factor from market.adjustment_factors af
            where af.security_id = ca.security_id and af.ex_date > ca.ex_date
            order by af.ex_date limit 1
          ) f on true
          where ca.source = ${source} and ca.type = 'cash_dividend'
            and ca.ex_date > ${back(asOf, 365)}::date
          group by ca.security_id
        `.execute(ctx.db)
      ).rows.map((r) => [r.security_id, r.total]),
    );

    const fundamentals = await loadFundamentals(
      ctx,
      [...new Set(securities.rows.map((s) => s.cik).filter((c): c is string => c !== null))],
      asOf,
    );

    const values: Insertable<MarketScreenerSnapshot>[] = [];
    for (const s of securities.rows) {
      const series = bars.get(s.security_id);
      if (!series?.length) continue;
      const snap = computeSnapshot(
        series,
        s.cik ? (fundamentals.get(s.cik) ?? null) : null,
        dividends.get(s.security_id) ?? null,
        Number(s.close),
      );
      values.push({
        security_id: s.security_id,
        ticker: s.ticker,
        name: s.name,
        asset_class: s.asset_class,
        exchange_mic: s.exchange_mic,
        sector: s.sector,
        industry: s.industry,
        source,
        close: s.close,
        ...snap,
        refreshed_at: ctx.clock(),
      });
    }

    await ctx.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("market.screener_snapshot").execute();
      for (let i = 0; i < values.length; i += 500) {
        await trx
          .insertInto("market.screener_snapshot")
          .values(values.slice(i, i + 500))
          .execute();
      }
    });
    counts.rows_inserted = values.length;
    await finishRun(ctx.db, runId, { status: "succeeded", counts, at: ctx.clock() });
    return { runId, source, asOf, securities: values.length };
  } catch (err) {
    await finishRun(ctx.db, runId, {
      status: "failed",
      counts,
      error: err instanceof Error ? err.message : String(err),
      at: ctx.clock(),
    });
    throw err;
  }
}

async function loadFundamentals(
  ctx: WorkerContext,
  ciks: string[],
  asOf: string,
): Promise<Map<string, SnapshotFundamentals>> {
  const out = new Map<string, SnapshotFundamentals>();
  if (ciks.length === 0) return out;
  const statements = await ctx.db
    .selectFrom("market.financial_statements")
    .select(["cik", "statement", "frequency", "period_end", "line_items"])
    .where("cik", "in", ciks)
    .where("basis", "=", "latest")
    .where((eb) =>
      eb.or([
        eb.and([eb("statement", "=", "income"), eb("period_end", ">", back(asOf, 800))]),
        eb("statement", "=", "balance"),
      ]),
    )
    .orderBy("period_end", "desc")
    .execute();
  const shares = await sql<{ cik: string; value: string; period_end: string }>`
    select distinct on (cik) cik, value::text as value, period_end
    from market.fundamentals_facts
    where cik = any(${ciks}::text[]) and unit = 'shares'
      and ((taxonomy = 'dei' and concept = 'EntityCommonStockSharesOutstanding')
        or (taxonomy = 'us-gaap' and concept = 'CommonStockSharesOutstanding'))
    order by cik, period_end desc, filed_at desc
  `.execute(ctx.db);
  const sharesByCik = new Map(shares.rows.map((r) => [r.cik, Number(r.value)]));

  type Items = Record<string, { value: string } | undefined>;
  for (const cik of ciks) {
    const rows = statements.filter((r) => r.cik === cik);
    const figures = (r: (typeof rows)[number]): QuarterFigures => {
      const items = r.line_items as unknown as Items;
      return {
        periodEnd: r.period_end,
        revenue: items.revenue?.value ?? null,
        netIncome: items.netIncome?.value ?? null,
      };
    };
    const quarters = rows
      .filter((r) => r.statement === "income" && r.frequency === "quarterly")
      .map(figures);
    const annualRow = rows.find((r) => r.statement === "income" && r.frequency === "annual");
    const ttm = trailingTwelveMonths(quarters, annualRow ? figures(annualRow) : null, asOf);
    const balance = rows.find((r) => r.statement === "balance");
    const equity = balance
      ? ((balance.line_items as unknown as Items).equity?.value ?? null)
      : null;
    out.set(cik, {
      sharesOutstanding: sharesByCik.get(cik) ?? null,
      revenueTtm: ttm.revenue,
      netIncomeTtm: ttm.netIncome,
      equity,
      asOf: ttm.asOf,
    });
  }
  return out;
}
