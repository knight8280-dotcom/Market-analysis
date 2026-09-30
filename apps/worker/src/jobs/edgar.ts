import type { FundamentalFact } from "@market/market-data";
import { padCik } from "@market/market-data/adapters/sec-edgar";
import { marketDateOf } from "@market/calendar";
import { sql } from "@market/db";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { statusDelta, statusSnapshot } from "../http-stats";
import { FRESHNESS_SLOS } from "../freshness";
import { JOBS, jobId } from "../queues";
import { insertFacts, insertFilings } from "../repo/edgar";
import { recordIssues, type IssueRow } from "../repo/quality";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
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
    const filings = await withProviderHealth(ctx, { route, source, dataset: "filings" }, () =>
      provider.getFilings({ cik }),
    );
    counts.rows_fetched = filings.length;
    const inserted = await insertFilings(ctx.db, filings);
    counts.rows_inserted = inserted.length;
    counts.rows_unchanged = filings.length - inserted.length;
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

/** Daily off-peak sweep: refresh filing metadata for every active security with a CIK. */
export async function scheduleEdgar(ctx: WorkerContext) {
  const date = marketDateOf(ctx.clock());
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
