import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marketDateOf } from "@market/calendar";
import { SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import {
  openZip,
  readFails,
  readForm13f,
  type FailsRow,
} from "@market/market-data/adapters/sec-datasets";
import { matchCusips, type CusipSeen } from "@market/ownership";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { statusDelta, statusSnapshot } from "../http-stats";
import { JOBS, jobId } from "../queues";
import { recordIssues } from "../repo/quality";
import { emptyCounts, finishRun, startRun } from "../repo/runs";
import {
  pruneForm13f,
  securityCusips,
  storeForm13fDataSet,
  upsertSecurityCusips,
} from "../repo/thirteenf";
import { resolveSource, withProviderHealth } from "../routing";

/**
 * Institutional holdings from SEC's quarterly Form 13F data sets (Phase 2 step H2, ADR-032).
 * CUSIPs come from the fails-to-deliver files; each data set is downloaded whole (about 100 MB),
 * read from disk, and only our securities' share holdings are kept.
 */
export const FTD_FILES = 6;
export const FORM13F_QUARTERS = 8;
/** Data sets read automatically: the newest and the one before (for changes in position). */
export const FORM13F_SETS = 2;
const CUSIPS_STALE_DAYS = 7;

/** The quarter end `quarters - 1` quarters before the latest quarter end on or before `now`. */
export function retentionStart(now: Date, quarters = FORM13F_QUARTERS): string {
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3); // quarter in progress, 0-3
  // The latest quarter end is the end of the previous quarter.
  const index = y * 4 + q - 1 - (quarters - 1);
  const year = Math.floor(index / 4);
  const month = (index % 4) * 3 + 3;
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

async function sec(ctx: WorkerContext) {
  const resolved = await resolveSource(ctx, "institutional_holdings");
  if (!(resolved.provider instanceof SecEdgarProvider)) {
    throw new Error(`13F data comes from SEC EDGAR, not ${resolved.source}`);
  }
  return { ...resolved, provider: resolved.provider };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "market-sec-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RefreshInput = z.object({ files: z.number().int().min(1).max(24).default(FTD_FILES) });

/**
 * Reads the newest fails-to-deliver files and stores the CUSIPs of our securities. A ticker
 * whose issue name does not agree with ours is recorded as a data-quality issue, not matched.
 */
export async function refreshCusips(ctx: WorkerContext, raw: unknown) {
  const { files: count } = RefreshInput.parse(raw ?? {});
  const { route, source, provider } = await sec(ctx);
  const runId = await startRun(ctx.db, {
    jobName: JOBS.refreshCusips,
    jobId: ctx.jobId,
    dataset: "institutional_holdings",
    source,
    params: { files: count },
    at: ctx.clock(),
  });
  const counts = emptyCounts();
  const before = statusSnapshot(provider);
  try {
    const call = { route, source, dataset: "institutional_holdings" as const };
    const files = (await withProviderHealth(ctx, call, () => provider.listDataSets("ftd"))).slice(
      0,
      count,
    );
    if (files.length === 0) throw new Error("SEC's fails-to-deliver page lists no files");
    const rows: FailsRow[] = [];
    await withTempDir(async (dir) => {
      for (const file of files) {
        const path = join(dir, file.name);
        await withProviderHealth(ctx, call, () => provider.downloadDataSet(file, path));
        const zip = await openZip(path);
        try {
          const name = zip.names.find((n) => n.toLowerCase().endsWith(".txt"));
          if (!name) throw new Error(`${file.name} holds no text file`);
          rows.push(...(await readFails(zip.lines(name, "latin1"))));
        } finally {
          zip.close();
        }
      }
    });
    counts.rows_fetched = rows.length;

    const seen = new Map<string, CusipSeen>();
    for (const r of rows) {
      const prev = seen.get(r.cusip);
      if (!prev) {
        seen.set(r.cusip, {
          cusip: r.cusip,
          symbol: r.symbol,
          description: r.description,
          first_seen: r.settlement_date,
          last_seen: r.settlement_date,
        });
        continue;
      }
      if (r.settlement_date < prev.first_seen) prev.first_seen = r.settlement_date;
      if (r.settlement_date >= prev.last_seen) {
        prev.last_seen = r.settlement_date;
        prev.symbol = r.symbol;
        prev.description = r.description;
      }
    }
    // Real securities only: synthetic test listings never get a real identifier.
    const securities = await ctx.db
      .selectFrom("market.securities as s")
      .select(["s.security_id", "s.ticker", "s.name"])
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
    const { matched, rejected } = matchCusips([...seen.values()], securities);
    counts.rows_inserted = await upsertSecurityCusips(ctx.db, matched, ctx.clock());
    counts.rows_rejected = rejected.length;
    await recordIssues(
      ctx.db,
      rejected.map((r) => ({
        runId,
        dataset: "institutional_holdings",
        source,
        securityId: r.security_id,
        date: r.last_seen,
        rule: "cusip_name_mismatch",
        severity: "warning" as const,
        action: "skipped" as const,
        message: `${r.ticker}: SEC lists CUSIP ${r.cusip} for ${r.symbol} as "${r.description}", which does not agree with "${r.name}"`,
        payload: { cusip: r.cusip, symbol: r.symbol, description: r.description },
      })),
    );
    await finishRun(ctx.db, runId, {
      status: "succeeded",
      counts,
      httpStatusCounts: statusDelta(provider, before),
      at: ctx.clock(),
    });
    return {
      files: files.map((f) => f.name),
      cusipsSeen: seen.size,
      matched: matched.length,
      rejected: rejected.map((r) => `${r.ticker}: ${r.description}`),
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

const IngestInput = z.object({
  /** Data set file names; default: the newest `latest` not yet read. */
  names: z.array(z.string().regex(/^\w+-\w+_form13f\.zip$/)).optional(),
  latest: z.number().int().min(1).max(12).default(FORM13F_SETS),
  /** Read sets again even if already stored. */
  force: z.boolean().default(false),
});

/** Reads Form 13F data sets, oldest first, after refreshing CUSIPs when they are stale. */
export async function ingestForm13f(ctx: WorkerContext, raw: unknown) {
  const input = IngestInput.parse(raw ?? {});
  const { route, source, provider } = await sec(ctx);
  const call = { route, source, dataset: "institutional_holdings" as const };
  const listed = await withProviderHealth(ctx, call, () => provider.listDataSets("form13f"));
  const stored = new Set(
    (await ctx.db.selectFrom("market.form13f_data_sets").select("name").execute()).map(
      (r) => r.name,
    ),
  );
  if (input.names) {
    const unknown = input.names.filter((n) => !listed.some((f) => f.name === n));
    if (unknown.length) throw new Error(`SEC does not list ${unknown.join(", ")}`);
  }
  // Named sets are read even if stored; otherwise the newest `latest` not yet read. Oldest first.
  const files = (
    input.names
      ? listed.filter((f) => input.names!.includes(f.name))
      : listed.slice(0, input.latest).filter((f) => input.force || !stored.has(f.name))
  ).reverse();
  if (files.length === 0) return { read: [], upToDate: true };

  const fresh = await ctx.db
    .selectFrom("market.security_cusips")
    .select((eb) => eb.fn.max("updated_at").as("at"))
    .executeTakeFirst();
  const staleBefore = new Date(ctx.clock().getTime() - CUSIPS_STALE_DAYS * 86_400_000);
  const cusipRefresh =
    !fresh?.at || new Date(fresh.at) < staleBefore ? await refreshCusips(ctx, {}) : null;
  const cusips = await securityCusips(ctx.db);
  if (cusips.size === 0) {
    throw new Error("None of our securities has a CUSIP from SEC's fails-to-deliver files yet");
  }

  const fromPeriod = retentionStart(ctx.clock());
  const read = [];
  for (const file of files) {
    const runId = await startRun(ctx.db, {
      jobName: JOBS.ingestForm13f,
      jobId: ctx.jobId,
      dataset: "institutional_holdings",
      source,
      params: { name: file.name, fromPeriod },
      at: ctx.clock(),
    });
    const counts = emptyCounts();
    const before = statusSnapshot(provider);
    try {
      const data = await withTempDir(async (dir) => {
        const path = join(dir, file.name);
        await withProviderHealth(ctx, call, () => provider.downloadDataSet(file, path));
        const zip = await openZip(path);
        try {
          return await readForm13f((t) => zip.lines(t), {
            cusips: new Set(cusips.keys()),
            fromPeriod,
          });
        } finally {
          zip.close();
        }
      });
      counts.rows_fetched = data.infotableRows;
      const result = await storeForm13fDataSet(ctx.db, file, data, cusips, ctx.clock());
      counts.rows_inserted = result.holdings;
      const pruned = await pruneForm13f(ctx.db, fromPeriod);
      await finishRun(ctx.db, runId, {
        status: "succeeded",
        counts,
        httpStatusCounts: statusDelta(provider, before),
        at: ctx.clock(),
      });
      read.push({
        name: file.name,
        ...result,
        infotableRows: data.infotableRows,
        rowCountMismatches: data.rowCountMismatches.length,
        prunedFilings: pruned,
      });
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
  return { read, fromPeriod, cusipRefresh, upToDate: false };
}

/** Nightly: queues a read when SEC lists a data set we have not read (one listing request). */
export async function schedule13f(ctx: WorkerContext) {
  const { route, source, provider } = await sec(ctx);
  const listed = await withProviderHealth(
    ctx,
    { route, source, dataset: "institutional_holdings" },
    () => provider.listDataSets("form13f"),
  );
  const stored = new Set(
    (await ctx.db.selectFrom("market.form13f_data_sets").select("name").execute()).map(
      (r) => r.name,
    ),
  );
  const missing = listed
    .slice(0, FORM13F_SETS)
    .filter((f) => !stored.has(f.name))
    .map((f) => f.name);
  if (missing.length > 0) {
    await ctx.dispatch.dispatch({
      name: JOBS.ingestForm13f,
      data: { names: missing },
      jobId: jobId(
        JOBS.ingestForm13f,
        marketDateOf(ctx.clock()),
        ...missing.map((n) => n.slice(0, 19)),
      ),
    });
  }
  return { listed: listed.length, missing };
}
