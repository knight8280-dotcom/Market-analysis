import type { FundamentalFact } from "@market/market-data";
import { buildStatements } from "@market/market-data/statements";
import {
  padCik,
  SecEdgarProvider,
  type TickerMapEntry,
} from "@market/market-data/adapters/sec-edgar";
import { marketDateOf } from "@market/calendar";
import { sql } from "@market/db";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { statusDelta, statusSnapshot } from "../http-stats";
import { FRESHNESS_SLOS } from "../freshness";
import { JOBS, jobId } from "../queues";
import { insertFacts, insertFilings } from "../repo/edgar";
import { queueAlertEvaluation } from "./alerts";
import { queueInsiderFilings, RECENT_INSIDER_DAYS } from "./insiders";
import { recordIssues, type IssueRow } from "../repo/quality";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import { applyEdgarEntity, securitiesMissingCik, setCik } from "../repo/securities";
import { replaceStatements, statementFacts } from "../repo/statements";
import { resolveSource, withProviderHealth } from "../routing";

export const CikInput = z.object({ cik: z.string().regex(/^\d{1,10}$/) });

/**
 * companyfacts for one registrant (spec §2.3). A fact reported twice in the same filing is kept
 * once; two different values for the same key are both left out and reported, because we
 * cannot tell which is right.
 */
export async function ingestFundamentals(ctx: WorkerContext, raw: unknown) {
  const { cik } = CikInput.parse(raw);
  const { route, source, provider } = await resolveSource(ctx, "fundamentals");
  const runId = await startRun(ctx.db, {
    jobName: JOBS.ingestFundamentals,
    jobId: ctx.jobId,
    dataset: "fundamentals",
    source,
    params: { cik },
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  const before = statusSnapshot(provider);
  try {
    const facts = await withProviderHealth(ctx, { route, source, dataset: "fundamentals" }, () =>
      provider.getFundamentals({ cik }),
    );
    counts.rows_fetched = facts.length;
    const byKey = new Map<string, FundamentalFact[]>();
    for (const f of facts) {
      const key = [
        f.accession_no,
        f.taxonomy,
        f.concept,
        f.unit,
        f.period_start ?? "",
        f.period_end,
      ].join("|");
      byKey.set(key, [...(byKey.get(key) ?? []), f]);
    }
    const keep: FundamentalFact[] = [];
    const issues: IssueRow[] = [];
    for (const list of byKey.values()) {
      const first = list[0]!;
      if (list.every((f) => f.value === first.value)) {
        keep.push(first);
        counts.rows_unchanged += list.length - 1;
      } else {
        counts.rows_rejected += list.length;
        issues.push({
          runId,
          dataset: "fundamentals",
          source,
          securityId: null,
          date: first.period_end,
          rule: "conflicting_fact_values",
          severity: "error",
          action: "rejected",
          message: `${first.taxonomy}:${first.concept} (${first.unit}) has ${list.length} different values in ${first.accession_no}`,
          payload: {
            cik: first.cik,
            accession_no: first.accession_no,
            values: list.map((f) => f.value),
          },
        });
      }
    }
    counts.rows_inserted = await insertFacts(ctx.db, keep);
    counts.rows_unchanged += keep.length - counts.rows_inserted;
    await recordIssues(ctx.db, issues);
    // New facts change the statements built from them.
    if (counts.rows_inserted > 0) {
      await ctx.dispatch.dispatch({
        name: JOBS.buildStatements,
        data: { cik },
        jobId: jobId(JOBS.buildStatements, padCik(cik), runId),
      });
    }
    await finishRun(ctx.db, runId, {
      status: "succeeded",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      at: ctx.clock(),
    });
    return {
      runId,
      cik,
      ...counts,
      httpStatusCounts: Object.fromEntries(statusDelta(provider, before)),
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

/** Recent filing metadata for one registrant. Filings are immutable once accepted. */
export async function ingestFilings(ctx: WorkerContext, raw: unknown) {
  const { cik } = CikInput.parse(raw);
  const { route, source, provider } = await resolveSource(ctx, "filings");
  const runId = await startRun(ctx.db, {
    jobName: JOBS.ingestFilings,
    jobId: ctx.jobId,
    dataset: "filings",
    source,
    params: { cik },
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  const before = statusSnapshot(provider);
  try {
    // The submissions payload also carries the registrant's SIC code, used for sectors.
    const { entity, filings } = await withProviderHealth(
      ctx,
      { route, source, dataset: "filings" },
      async () =>
        provider instanceof SecEdgarProvider
          ? provider.getSubmissions({ cik })
          : { entity: null, filings: await provider.getFilings({ cik }) },
    );
    if (entity) await applyEdgarEntity(ctx.db, entity, ctx.clock());
    counts.rows_fetched = filings.length;
    const inserted = await insertFilings(ctx.db, filings);
    counts.rows_inserted = inserted.length;
    counts.rows_unchanged = filings.length - inserted.length;
    if (inserted.length > 0) {
      // New-filing alerts on this registrant are checked now (Phase 2 step E2).
      const securities = await ctx.db
        .selectFrom("market.securities")
        .select("security_id")
        .where("cik", "=", padCik(cik))
        .execute();
      await queueAlertEvaluation(ctx, {
        trigger: "filings",
        runId,
        securityIds: securities.map((s) => s.security_id),
        kinds: ["new_filing"],
      });
    }
    // New Form 4s are read from their XML (Phase 2 step H1); older ones are left to the sweep.
    const recent = ctx.clock().getTime() - RECENT_INSIDER_DAYS * 86_400_000;
    await queueInsiderFilings(
      ctx,
      inserted.filter(
        (f) => (f.form_type === "4" || f.form_type === "4/A") && f.filed_at.getTime() >= recent,
      ),
    );
    // New periodic reports carry new XBRL facts: refresh companyfacts (fundamentals SLO: 24h).
    const periodic = inserted
      .filter((f) => (FRESHNESS_SLOS.fundamentals.forms as readonly string[]).includes(f.form_type))
      .sort((a, b) => a.filed_at.getTime() - b.filed_at.getTime());
    const latest = periodic.at(-1);
    if (latest) {
      await ctx.dispatch.dispatch({
        name: JOBS.ingestFundamentals,
        data: { cik },
        jobId: jobId(JOBS.ingestFundamentals, padCik(cik), latest.accession_no),
      });
    }
    await finishRun(ctx.db, runId, {
      status: "succeeded",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      at: ctx.clock(),
    });
    return { runId, cik, ...counts };
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

/**
 * Rebuilds a registrant's financial statements from its stored facts (Phase 1 step E). Pure
 * computation over our own data: no provider call.
 */
export async function buildStatementsJob(ctx: WorkerContext, raw: unknown) {
  const cik = padCik(CikInput.parse(raw).cik);
  const runId = await startRun(ctx.db, {
    jobName: JOBS.buildStatements,
    jobId: ctx.jobId,
    dataset: "fundamentals",
    source: "sec_edgar",
    params: { cik },
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  try {
    const facts = await statementFacts(ctx.db, cik);
    counts.rows_fetched = facts.length;
    const rows = buildStatements(facts);
    counts.rows_inserted = await replaceStatements(ctx.db, cik, rows, "sec_edgar", ctx.clock());
    await finishRun(ctx.db, runId, { status: "succeeded", counts, at: ctx.clock() });
    return {
      runId,
      cik,
      facts: facts.length,
      statements: rows.length,
      restated: rows.filter((r) => r.restated && r.basis === "latest").length,
    };
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

/** SEC writes share classes with "-" (BRK-B); vendors also use "." or "/". */
export function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/[./]/g, "-");
}

/**
 * Attaches SEC CIKs to equities that lack one, matched by ticker through SEC's
 * company_tickers_exchange.json, then queues a filings refresh for each registrant (which also
 * sets its SIC code, industry and sector). Tickers SEC does not list are reported, not guessed.
 */
export async function attachEdgarIds(ctx: WorkerContext) {
  const date = marketDateOf(ctx.clock());
  const missing = await securitiesMissingCik(ctx.db);
  if (missing.length === 0) return { date, candidates: 0, attached: 0, unmatched: [] };
  const { route, source, provider } = await resolveSource(ctx, "filings");
  if (!(provider instanceof SecEdgarProvider)) {
    throw new Error(`attach-edgar-ids needs SEC EDGAR as the filings source, not ${source}`);
  }
  const entries = await withProviderHealth(ctx, { route, source, dataset: "filings" }, () =>
    provider.getTickerMap(),
  );
  const byTicker = new Map<string, TickerMapEntry>();
  for (const e of entries) {
    const key = normalizeTicker(e.ticker);
    if (!byTicker.has(key)) byTicker.set(key, e);
  }
  const ciks = new Set<string>();
  const unmatched: string[] = [];
  for (const s of missing) {
    const hit = byTicker.get(normalizeTicker(s.ticker));
    if (!hit) {
      unmatched.push(s.ticker);
      continue;
    }
    await setCik(ctx.db, s.security_id, hit.cik, ctx.clock());
    ciks.add(hit.cik);
  }
  for (const cik of ciks) {
    await ctx.dispatch.dispatch({
      name: JOBS.ingestFilings,
      data: { cik },
      jobId: jobId(JOBS.ingestFilings, date, cik),
    });
  }
  if (unmatched.length > 0) ctx.log.warn({ unmatched }, "tickers not in SEC's ticker map");
  return {
    date,
    candidates: missing.length,
    attached: missing.length - unmatched.length,
    unmatched,
  };
}

/**
 * Daily off-peak sweep: attach CIKs to new equities, then refresh filing metadata for every
 * active security with a CIK.
 */
export async function scheduleEdgar(ctx: WorkerContext) {
  const date = marketDateOf(ctx.clock());
  if ((await securitiesMissingCik(ctx.db)).length > 0) {
    await ctx.dispatch.dispatch({
      name: JOBS.attachEdgarIds,
      data: {},
      jobId: jobId(JOBS.attachEdgarIds, date),
    });
  }
  const rows = await sql<{ cik: string }>`
    select distinct cik from market.securities where cik is not null and is_active order by cik
  `.execute(ctx.db);
  for (const { cik } of rows.rows) {
    await ctx.dispatch.dispatch({
      name: JOBS.ingestFilings,
      data: { cik },
      jobId: jobId(JOBS.ingestFilings, date, cik),
    });
  }
  return { date, ciks: rows.rows.length };
}
