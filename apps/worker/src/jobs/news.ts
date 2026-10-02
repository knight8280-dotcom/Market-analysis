import { addDays, marketDateOf } from "@market/calendar";
import { FinnhubProvider } from "@market/market-data/adapters/finnhub";
import { padCik, SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import { compactTicker } from "@market/ownership";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { statusDelta, statusSnapshot } from "../http-stats";
import { JOBS, jobId } from "../queues";
import { pendingPressReleases, pruneNews, storeNewsItem } from "../repo/news";
import { recordIssues, type IssueRow } from "../repo/quality";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import { resolveSource, withProviderHealth } from "../routing";

/**
 * News (Phase 2 step I1, spec §5.12, ADR-035): Finnhub company news for our listings, and the
 * press releases companies file with SEC as Exhibit 99 to Form 8-K. Bump the reader version when
 * reading press releases changes, so sweeps read stored 8-Ks again.
 */
export const PRESS_READER_VERSION = 1;
/** A filings refresh reads press releases filed this recently; older ones are a sweep. */
export const RECENT_PRESS_DAYS = 30;
/** How far back the first Finnhub run asks for each company. */
export const FIRST_NEWS_DAYS = 30;
/** Later runs ask again from two days before the latest article, for items published late. */
const OVERLAP_DAYS = 2;
export const NEWS_RETENTION_DAYS = 400;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NewsInput = z.object({
  tickers: z.array(z.string().min(1).max(15)).optional(),
  from: Day.optional(),
  to: Day.optional(),
});

/** Finnhub writes class shares with a dot (BRK.B), as do most feeds. */
const finnhubSymbol = (ticker: string) => ticker.replace(/[-/]/g, ".");

export async function ingestNews(ctx: WorkerContext, raw: unknown) {
  const input = NewsInput.parse(raw ?? {});
  if (!ctx.providers.has("finnhub")) {
    return { configured: false as const, note: "Set FINNHUB_API_KEY" };
  }
  const { route, source, provider } = await resolveSource(ctx, "news");
  if (!(provider instanceof FinnhubProvider)) {
    throw new Error(`Company news comes from Finnhub, not ${source}`);
  }
  const today = marketDateOf(ctx.clock());

  // Real company listings (Finnhub's company news covers North American companies).
  const listings = await ctx.db
    .selectFrom("market.securities as s")
    .select(["s.security_id", "s.ticker", "s.asset_class"])
    .where("s.is_active", "=", true)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("market.provider_symbols as ps")
          .select("ps.security_id")
          .whereRef("ps.security_id", "=", "s.security_id")
          .where("ps.source", "<>", "synthetic"),
      ),
    )
    .orderBy("s.ticker")
    .execute();
  const byTicker = new Map(listings.map((l) => [compactTicker(l.ticker), l.security_id]));
  const wanted = input.tickers?.map((t) => t.toUpperCase());
  const companies = listings.filter(
    (l) =>
      (l.asset_class === "equity" || l.asset_class === "adr") &&
      (!wanted || wanted.includes(l.ticker)),
  );
  const latest = new Map(
    (
      await ctx.db
        .selectFrom("market.news_tickers as t")
        .innerJoin("market.news_articles as a", "a.article_id", "t.article_id")
        .select((eb) => ["t.security_id", eb.fn.max("a.published_at").as("latest")])
        .where("a.source", "=", "finnhub")
        .groupBy("t.security_id")
        .execute()
    ).map((r) => [r.security_id, r.latest]),
  );

  const runId = await startRun(ctx.db, {
    jobName: JOBS.ingestNews,
    jobId: ctx.jobId,
    dataset: "news",
    source,
    params: { companies: companies.length, from: input.from ?? null, to: input.to ?? null },
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  const before = statusSnapshot(provider);
  const outcomes = { stored: 0, copy: 0, known: 0 };
  const issues: IssueRow[] = [];
  try {
    for (const c of companies) {
      const last = latest.get(c.security_id);
      const from =
        input.from ??
        (last ? addDays(marketDateOf(last), -OVERLAP_DAYS) : addDays(today, -FIRST_NEWS_DAYS));
      const symbol = finnhubSymbol(c.ticker);
      const page = await withProviderHealth(ctx, { route, source, dataset: "news" }, () =>
        provider.getNews({ symbol, from, to: input.to ?? today }),
      );
      counts.rows_fetched += page.items.length + page.skipped.length;
      counts.rows_rejected += page.skipped.length;
      for (const s of page.skipped) {
        issues.push({
          runId,
          dataset: "news",
          source,
          securityId: c.security_id,
          date: null,
          rule: "news_item_skipped",
          severity: "info",
          action: "skipped",
          message: `${c.ticker}: Finnhub article ${s.id} left out (${s.reason})`,
          payload: { id: s.id, reason: s.reason },
        });
      }
      for (const item of page.items) {
        const tagged = new Set([c.security_id]);
        for (const sym of item.symbols) {
          const id = byTicker.get(compactTicker(sym));
          if (id) tagged.add(id);
        }
        const result = await storeNewsItem(ctx.db, item, [...tagged]);
        if (result) outcomes[result.outcome] += 1;
      }
    }
    counts.rows_inserted = outcomes.stored + outcomes.copy;
    counts.rows_unchanged = outcomes.known;
    await recordIssues(ctx.db, issues);
    await finishRun(ctx.db, runId, {
      status: "succeeded",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      at: ctx.clock(),
    });
    return {
      configured: true as const,
      companies: companies.length,
      stored: outcomes.stored,
      copies: outcomes.copy,
      alreadyStored: outcomes.known,
      skipped: issues.length,
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

const PressInput = z.object({
  cik: z.string().regex(/^\d{1,10}$/),
  accession_no: z.string().regex(/^\d{10}-\d{2}-\d{6}$/),
});

/** One 8-K: reads its Exhibit 99 press release, if it has one (two SEC requests). */
export async function ingestPressRelease(ctx: WorkerContext, raw: unknown) {
  const input = PressInput.parse(raw);
  const cik = padCik(input.cik);
  const accession_no = input.accession_no;
  const filing = await ctx.db
    .selectFrom("market.filings")
    .select(["form_type", "filed_at", "items"])
    .where("accession_no", "=", accession_no)
    .where("cik", "=", cik)
    .executeTakeFirst();
  if (!filing) throw new Error(`Filing ${accession_no} is not stored for CIK ${cik}`);
  if (filing.form_type !== "8-K") return { accession_no, status: "not_8k" as const };
  const done = await ctx.db
    .selectFrom("market.press_release_checks")
    .select("reader_version")
    .where("accession_no", "=", accession_no)
    .executeTakeFirst();
  if (done && done.reader_version >= PRESS_READER_VERSION) {
    return { accession_no, status: "already_read" as const };
  }

  const securities = await ctx.db
    .selectFrom("market.securities")
    .select(["security_id", "name"])
    .where("cik", "=", cik)
    .orderBy("security_id")
    .execute();
  const { route, source, provider } = await resolveSource(ctx, "filings");
  if (!(provider instanceof SecEdgarProvider)) {
    throw new Error(`Press releases come from SEC EDGAR, not ${source}`);
  }
  const item = await withProviderHealth(ctx, { route, source, dataset: "filings" }, () =>
    provider.getPressRelease({
      cik,
      accession: accession_no,
      company: securities[0]?.name ?? `CIK ${Number(cik)}`,
      items: filing.items,
      filedAt: filing.filed_at,
    }),
  );
  const stored = item
    ? await storeNewsItem(
        ctx.db,
        item,
        securities.map((s) => s.security_id),
      )
    : null;
  const outcome = stored ? (stored.outcome === "copy" ? "copy" : "stored") : "none";
  await ctx.db
    .insertInto("market.press_release_checks")
    .values({
      accession_no,
      cik,
      outcome,
      article_id: stored?.articleId ?? null,
      reader_version: PRESS_READER_VERSION,
      checked_at: ctx.clock(),
    })
    .onConflict((oc) =>
      oc.column("accession_no").doUpdateSet((eb) => ({
        outcome: eb.ref("excluded.outcome"),
        article_id: eb.ref("excluded.article_id"),
        reader_version: eb.ref("excluded.reader_version"),
        checked_at: eb.ref("excluded.checked_at"),
      })),
    )
    .execute();
  return {
    accession_no,
    status: outcome,
    headline: item?.headline ?? null,
    described: item?.described ?? null,
  };
}

/** Queues one read per 8-K; the job id makes a re-queue a no-op until the reader changes. */
export async function queuePressReleases(
  ctx: WorkerContext,
  filings: readonly { cik: string; accession_no: string }[],
): Promise<number> {
  for (const f of filings) {
    await ctx.dispatch.dispatch({
      name: JOBS.ingestPressRelease,
      data: { cik: padCik(f.cik), accession_no: f.accession_no },
      jobId: jobId(JOBS.ingestPressRelease, f.accession_no, `v${PRESS_READER_VERSION}`),
    });
  }
  return filings.length;
}

const SweepInput = z.object({
  days: z.number().int().min(1).max(3650).default(RECENT_PRESS_DAYS),
  ciks: z.array(z.string().regex(/^\d{1,10}$/)).optional(),
  limit: z.number().int().positive().optional(),
});

/**
 * Queues every stored 8-K with exhibits filed in the last `days` that has not been read (the
 * nightly sweep, and `pnpm worker press-releases --days 365` for history).
 */
export async function sweepPressReleases(ctx: WorkerContext, raw: unknown) {
  const { days, ciks, limit } = SweepInput.parse(raw ?? {});
  const since = new Date(ctx.clock().getTime() - days * 86_400_000);
  const pending = await pendingPressReleases(ctx.db, {
    since,
    readerVersion: PRESS_READER_VERSION,
    ciks: ciks?.map(padCik),
    limit,
  });
  return { since: since.toISOString(), queued: await queuePressReleases(ctx, pending) };
}

/** Deletes news older than the retention period (about 13 months). */
export async function pruneNewsJob(ctx: WorkerContext) {
  const before = new Date(ctx.clock().getTime() - NEWS_RETENTION_DAYS * 86_400_000);
  return { before: before.toISOString(), deleted: await pruneNews(ctx.db, before) };
}
