import { codeVersion } from "@market/backtest/snapshot";
import { latestClosedSession } from "@market/calendar";
import { loadWorkerEnv } from "@market/config";
import { createDb, createPool } from "@market/db";
import { ProviderId } from "@market/market-data";
import { padCik, SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import {
  checkAgainstReport,
  findStatementReport,
  parseFilingSummary,
  parseStatementReport,
} from "@market/market-data/edgar-report";
import { STATEMENTS, type LineValue } from "@market/market-data/statements";
import { TiingoProvider } from "@market/market-data/adapters/tiingo";
import { Redis } from "ioredis";
import type { JobRequest, WorkerContext } from "./context";
import { InlineDispatcher } from "./dispatch";
import { gitSha, inProcessRunner } from "./backtest/runner";
import { dispatchQueuedBacktests } from "./jobs/backtest";
import { DEFAULT_MACRO_SERIES } from "./jobs/ingest-macro";
import { runJob } from "./jobs/index";
import { createLogger } from "./log";
import { alertDeliveryFromEnv } from "./mail";
import { buildProviders, routingFromEnv } from "./providers";
import { JOBS, jobId } from "./queues";
import { mappingsFor } from "./repo/securities";
import { loadUniverse } from "./universe";

/**
 * Operator CLI: runs job handlers in-process (no queue) for backfills, one-off ingests, the live
 * EDGAR acceptance run and monitor checks. Usage: pnpm worker <command> [--flags].
 *
 *   bootstrap [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--source tiingo]
 *   verify-tiingo [--symbol SPY]
 *   ingest-securities [--source synthetic]
 *   attach-edgar-ids
 *   backfill --from YYYY-MM-DD --to YYYY-MM-DD [--source synthetic] [--symbols A,B]
 *   eod --date YYYY-MM-DD [--source synthetic]
 *   reconcile --through YYYY-MM-DD [--days 5]
 *   recompute-adjustments
 *   edgar --tickers AAPL,MSFT | --ciks 320193,789019 [--facts-only]
 *   statements [--ciks 320193,789019]   (default: every registrant with facts)
 *   check-statements [--ciks ...]        (default: 10 large filers; live SEC requests)
 *   insiders [--days 730] [--tickers AAPL,MSFT] [--limit 500]   (Form 4s already listed by `edgar`)
 *   cusips [--files 6]                   (CUSIPs from SEC's fails-to-deliver files)
 *   short-interest [--from YYYY-MM-DD --to YYYY-MM-DD]   (needs FINRA_API_CLIENT_ID and _SECRET)
 *   13f [--latest 2] [--names 01jun2026-31aug2026_form13f.zip] [--force]   (about 100 MB each)
 *   screener
 *   earnings [--from YYYY-MM-DD --to YYYY-MM-DD]   (needs FINNHUB_API_KEY)
 *   releases [--from YYYY-MM-DD --to YYYY-MM-DD]   (needs FRED_ENABLED)
 *   alerts [--through YYYY-MM-DD]        (emails need RESEND_API_KEY and ALERT_EMAIL_TO)
 *   backtests                            (runs every queued backtest, one at a time)
 *   backtest --run 12                    (runs or re-runs one; prints its outcome)
 *   macro [--series DGS10,UNRATE]
 *   monitor [--at 2026-09-29T22:31:00Z]
 *   partitions
 *   routing
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const list = (v: string | undefined) =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
/** Ten large filers across sectors for the statement check (plan step E4). */
const CHECK_CIKS = [
  "0000320193", // Apple
  "0000789019", // Microsoft
  "0001045810", // NVIDIA
  "0000019617", // JPMorgan Chase
  "0000093410", // Chevron
  "0000104169", // Walmart
  "0000200406", // Johnson & Johnson
  "0000021344", // Coca-Cola
  "0000080424", // Procter & Gamble
  "0000354950", // Home Depot
];

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

/** The same calendar date `years` earlier (29 February rolls to 1 March). */
function yearsBefore(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y - years, m - 1, d)).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const env = loadWorkerEnv();
  const log = createLogger(env.LOG_LEVEL);
  const pool = createPool(env.DATABASE_URL, { max: 4, applicationName: "worker-cli" });
  const db = createDb(pool);
  // Quota-limited vendors share Redis rate limiters with the running worker.
  const limiterRedis =
    env.EDGAR_ENABLED || env.TIINGO_API_KEY || env.FINNHUB_API_KEY
      ? new Redis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
      : undefined;
  const at = flag("at");
  const clock = at ? () => new Date(at) : () => new Date();
  const dispatcher = new InlineDispatcher();
  const universe = loadUniverse(env.UNIVERSE_FILE);
  const ctx: WorkerContext = {
    appEnv: env.APP_ENV,
    db,
    providers: buildProviders(env, { limiterRedis, now: clock, universe }),
    routes: routingFromEnv(env),
    clock,
    log,
    events: { emit: (event) => log.info({ event }, "event") },
    dispatch: dispatcher,
    universe,
    alertDelivery: alertDeliveryFromEnv(env),
    backtests: inProcessRunner(db, { codeVersion: codeVersion(gitSha()) }),
  };
  const source = flag("source") ? ProviderId.parse(flag("source")) : undefined;
  const failures: { job: string; error: string }[] = [];
  const drain = () =>
    dispatcher.drain(
      (job: JobRequest) => runJob({ ...ctx, jobId: job.jobId }, job.name, job.data),
      (job, err) =>
        failures.push({ job: job.jobId, error: err instanceof Error ? err.message : String(err) }),
    );
  const started = Date.now();

  /** Queues and runs one EOD job per mapped symbol of `source`, then sums their run records. */
  const backfill = async (from: string, to: string, src: ProviderId) => {
    const symbols =
      list(flag("symbols")) ??
      (
        await db
          .selectFrom("market.provider_symbols")
          .select("source_symbol")
          .distinct()
          .where("source", "=", src)
          .orderBy("source_symbol")
          .execute()
      ).map((r) => r.source_symbol);
    for (const symbol of symbols) {
      if ((await mappingsFor(db, src, symbol)).length === 0) continue;
      await dispatcher.dispatch({
        name: JOBS.ingestEod,
        data: { symbol, start: from, end: to, source: src },
        jobId: jobId(JOBS.ingestEod, "backfill", from, to, symbol),
      });
    }
    const jobs = await drain();
    const rows = await db
      .selectFrom("ops.data_ingestion_runs")
      .select((eb) => [
        eb.fn.sum<string>("rows_fetched").as("fetched"),
        eb.fn.sum<string>("rows_inserted").as("inserted"),
        eb.fn.sum<string>("rows_updated").as("updated"),
        eb.fn.sum<string>("rows_unchanged").as("unchanged"),
        eb.fn.sum<string>("rows_rejected").as("rejected"),
        eb.fn.sum<string>("rows_flagged").as("flagged"),
      ])
      .where("job_name", "=", JOBS.ingestEod)
      .where("started_at", ">=", new Date(started))
      .executeTakeFirst();
    return { from, to, source: src, symbols: symbols.length, jobs, rows };
  };

  try {
    switch (command) {
      case "ingest-securities":
        print(await runJob(ctx, JOBS.ingestSecurities, { source }));
        break;

      case "attach-edgar-ids":
        print(await runJob(ctx, JOBS.attachEdgarIds, {}));
        print(await drain());
        break;

      case "backfill": {
        const from = flag("from");
        const to = flag("to");
        if (!from || !to) throw new Error("backfill needs --from and --to");
        const sec = (await runJob(ctx, JOBS.ingestSecurities, { source })) as {
          source: ProviderId;
        };
        print({
          ...(await backfill(from, to, sec.source)),
          seconds: (Date.now() - started) / 1000,
        });
        break;
      }

      // One-time setup (plan step A6): the universe's securities, their SEC ids and sectors,
      // filings and fundamentals, then ten years of prices. Safe to re-run: every step is
      // idempotent. On Tiingo's free tier the price step is paced by the shared quota limiter.
      case "bootstrap": {
        const to = flag("to") ?? latestClosedSession(clock()).date;
        const from = flag("from") ?? yearsBefore(to, 10);
        const securities = (await runJob(ctx, JOBS.ingestSecurities, { source })) as {
          source: ProviderId;
        };
        const edgar = ctx.providers.has("sec_edgar")
          ? { attach: await runJob(ctx, JOBS.attachEdgarIds, {}), jobs: await drain() }
          : "skipped: set EDGAR_ENABLED=true, APP_NAME and SEC_CONTACT_EMAIL";
        const prices = await backfill(from, to, securities.source);
        print({ securities, edgar, prices, seconds: (Date.now() - started) / 1000 });
        break;
      }

      // Plan step A4: parse live Tiingo responses through the adapter's schemas. Prints field
      // names and counts only; vendor responses are never written to disk or committed.
      case "verify-tiingo": {
        const tiingo = ctx.providers.get("tiingo");
        if (!(tiingo instanceof TiingoProvider))
          throw new Error("Set TIINGO_API_KEY to verify Tiingo");
        const symbol = flag("symbol") ?? "SPY";
        const to = latestClosedSession(clock()).date;
        const range = { symbol, start: yearsBefore(to, 1), end: to };
        const [security] = await tiingo.getSecurities({ symbols: [symbol] });
        const bars = await tiingo.getDailyBars(range);
        const actions = await tiingo.getCorporateActions(range);
        print({
          symbol,
          security: security
            ? { fields: Object.keys(security).sort(), listed_at: security.listed_at }
            : null,
          bars: {
            count: bars.length,
            first: bars[0]?.date ?? null,
            last: bars.at(-1)?.date ?? null,
            fields: Object.keys(bars[0] ?? {}).sort(),
            license_tier: bars[0]?.license_tier ?? null,
          },
          corporateActions: {
            count: actions.length,
            types: [...new Set(actions.map((a) => a.type))],
          },
          httpStatusCounts: Object.fromEntries(tiingo.http.statusCounts),
        });
        break;
      }

      case "eod": {
        const date = flag("date") ?? latestClosedSession(clock()).date;
        print(await runJob(ctx, JOBS.scheduleEod, { date, source }));
        print(await drain());
        break;
      }

      case "reconcile": {
        const through = flag("through") ?? latestClosedSession(clock()).date;
        print(await runJob(ctx, JOBS.reconcileEod, { through, days: Number(flag("days") ?? 5) }));
        print(await drain());
        break;
      }

      case "recompute-adjustments": {
        const ids = await db
          .selectFrom("market.corporate_actions")
          .select("security_id")
          .distinct()
          .execute();
        for (const { security_id } of ids) {
          await dispatcher.dispatch({
            name: JOBS.recomputeAdjustments,
            data: { securityId: security_id },
            jobId: jobId(JOBS.recomputeAdjustments, security_id, "cli"),
          });
        }
        print(await drain());
        break;
      }

      case "edgar": {
        const edgar = ctx.providers.get("sec_edgar");
        if (!(edgar instanceof SecEdgarProvider))
          throw new Error("Set EDGAR_ENABLED=true, APP_NAME and SEC_CONTACT_EMAIL");
        let ciks = list(flag("ciks"))?.map(padCik);
        const tickers = list(flag("tickers"));
        if (tickers) {
          const map = await edgar.getTickerMap();
          ciks = tickers.map((t) => {
            const hit = map.find((e) => e.ticker.toUpperCase() === t.toUpperCase());
            if (!hit) throw new Error(`Ticker ${t} is not in SEC's company_tickers_exchange.json`);
            return hit.cik;
          });
        }
        if (!ciks?.length) throw new Error("edgar needs --tickers or --ciks");
        const unique = [...new Set(ciks)];
        // Filings first: each registrant with new 10-K/10-Q filings gets one companyfacts job.
        if (!process.argv.includes("--facts-only")) {
          for (const cik of unique) await runJob(ctx, JOBS.ingestFilings, { cik });
          await drain();
        }
        // Registrants without a queued refresh (no new periodic filings) get one explicitly.
        const done = new Set(
          (
            await db
              .selectFrom("ops.data_ingestion_runs")
              .select("params")
              .where("job_name", "=", JOBS.ingestFundamentals)
              .where("started_at", ">=", new Date(started))
              .execute()
          ).map((r) => padCik(String((r.params as { cik?: string }).cik ?? ""))),
        );
        for (const cik of unique) {
          if (!done.has(cik)) await runJob(ctx, JOBS.ingestFundamentals, { cik });
        }
        const runs = await db
          .selectFrom("ops.data_ingestion_runs")
          .select([
            "dataset",
            "status",
            "params",
            "rows_fetched",
            "rows_inserted",
            "rows_rejected",
            "error",
          ])
          .where("dataset", "in", ["fundamentals", "filings"])
          .where("started_at", ">=", new Date(started))
          .orderBy("run_id")
          .execute();
        const summarize = (dataset: string) => {
          const rs = runs.filter((r) => r.dataset === dataset);
          return {
            runs: rs.length,
            succeeded: rs.filter((r) => r.status === "succeeded").length,
            failed: rs
              .filter((r) => r.status === "failed")
              .map((r) => ({ params: r.params, error: r.error })),
            rowsFetched: rs.reduce((n, r) => n + r.rows_fetched, 0),
            rowsInserted: rs.reduce((n, r) => n + r.rows_inserted, 0),
            rowsRejected: rs.reduce((n, r) => n + r.rows_rejected, 0),
          };
        };
        print({
          companies: unique.length,
          filings: summarize("filings"),
          fundamentals: summarize("fundamentals"),
          // The acceptance criterion: no 403 or 429 from SEC during the whole run.
          httpStatusCounts: Object.fromEntries(edgar.http.statusCounts),
          seconds: (Date.now() - started) / 1000,
        });
        break;
      }

      case "statements": {
        const ciks =
          list(flag("ciks"))?.map(padCik) ??
          (
            await db
              .selectFrom("market.fundamentals_facts")
              .select("cik")
              .distinct()
              .orderBy("cik")
              .execute()
          ).map((r) => r.cik);
        const results = [];
        for (const cik of ciks) results.push(await runJob(ctx, JOBS.buildStatements, { cik }));
        print({ registrants: ciks.length, results, seconds: (Date.now() - started) / 1000 });
        break;
      }

      // Plan step E4: our latest annual statements, as first reported, against SEC's own
      // rendering of the same 10-K (the R pages), value by value.
      case "check-statements": {
        const edgar = ctx.providers.get("sec_edgar");
        if (!(edgar instanceof SecEdgarProvider))
          throw new Error("Set EDGAR_ENABLED=true, APP_NAME and SEC_CONTACT_EMAIL");
        const ciks = list(flag("ciks"))?.map(padCik) ?? CHECK_CIKS;
        const companies = [];
        for (const cik of ciks) {
          const latest = await db
            .selectFrom("market.financial_statements")
            .select(["period_end", "fiscal_year"])
            .where("cik", "=", cik)
            .where("statement", "=", "income")
            .where("frequency", "=", "annual")
            .where("basis", "=", "as_reported")
            .orderBy("period_end", "desc")
            .executeTakeFirst();
          const filing = latest
            ? await db
                .selectFrom("market.filings")
                .select("accession_no")
                .where("cik", "=", cik)
                .where("form_type", "=", "10-K")
                .where("period", "=", latest.period_end)
                .orderBy("filed_at")
                .executeTakeFirst()
            : undefined;
          if (!latest || !filing) {
            companies.push({ cik, error: "no annual statement or 10-K on file" });
            continue;
          }
          const accession = filing.accession_no;
          const reports = parseFilingSummary(
            await edgar.getArchiveDocument({ cik, accession, file: "FilingSummary.xml" }),
          );
          const statements: Record<string, unknown> = {};
          for (const def of STATEMENTS) {
            const report = findStatementReport(reports, def.kind);
            const row = await db
              .selectFrom("market.financial_statements")
              .select("line_items")
              .where("cik", "=", cik)
              .where("statement", "=", def.kind)
              .where("frequency", "=", "annual")
              .where("basis", "=", "as_reported")
              .where("period_end", "=", latest.period_end)
              .executeTakeFirst();
            if (!report || !row) {
              statements[def.kind] = {
                error: !report ? "statement page not found" : "no statement",
              };
              continue;
            }
            const page = parseStatementReport(
              await edgar.getArchiveDocument({ cik, accession, file: report.file }),
            );
            const results = checkAgainstReport(
              row.line_items as unknown as Record<string, LineValue>,
              def.lines,
              page,
              latest.period_end,
            );
            statements[def.kind] = {
              page: `${report.file} ${report.shortName}`,
              compared: results.filter((r) => r.status !== "not_presented").length,
              matched: results.filter((r) => r.status === "match").length,
              matchedNegated: results.filter((r) => r.status === "match_negated").length,
              mismatches: results.filter((r) => r.status === "mismatch"),
              notPresented: results.filter((r) => r.status === "not_presented").map((r) => r.line),
            };
          }
          companies.push({ cik, fiscalYear: latest.fiscal_year, accession, statements });
        }
        print({ companies, httpStatusCounts: Object.fromEntries(edgar.http.statusCounts) });
        break;
      }

      case "insiders": {
        // Reads stored Form 4 filings that have not been read yet (one SEC request each).
        const tickers = list(flag("tickers"));
        const ciks = tickers
          ? (
              await db
                .selectFrom("market.securities")
                .select("cik")
                .where(
                  "ticker",
                  "in",
                  tickers.map((t) => t.toUpperCase()),
                )
                .where("cik", "is not", null)
                .execute()
            ).map((r) => r.cik!)
          : undefined;
        if (tickers && !ciks?.length) throw new Error("None of those tickers has a CIK yet");
        const sweep = await runJob(ctx, JOBS.sweepInsiders, {
          days: Number(flag("days") ?? 730),
          ...(ciks ? { ciks } : {}),
          ...(flag("limit") ? { limit: Number(flag("limit")) } : {}),
        });
        const jobs = await drain();
        const read = await db
          .selectFrom("market.insider_filings")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .executeTakeFirst();
        const unreadable = await db
          .selectFrom("market.insider_filing_errors")
          .select(["accession_no", "error"])
          .where("failed_at", ">=", new Date(started))
          .execute();
        const edgar = ctx.providers.get("sec_edgar");
        print({
          sweep,
          jobs,
          filingsStored: Number(read?.n ?? 0),
          unreadable,
          failures,
          httpStatusCounts:
            edgar instanceof SecEdgarProvider ? Object.fromEntries(edgar.http.statusCounts) : {},
          seconds: (Date.now() - started) / 1000,
        });
        break;
      }

      case "short-interest":
        print(
          await runJob(ctx, JOBS.ingestShortInterest, {
            ...(flag("from") ? { from: flag("from") } : {}),
            ...(flag("to") ? { to: flag("to") } : {}),
          }),
        );
        break;

      case "cusips":
        print(await runJob(ctx, JOBS.refreshCusips, { files: Number(flag("files") ?? 6) }));
        break;

      case "13f": {
        const result = await runJob(ctx, JOBS.ingestForm13f, {
          ...(flag("latest") ? { latest: Number(flag("latest")) } : {}),
          ...(flag("names") ? { names: list(flag("names")) } : {}),
          force: process.argv.includes("--force"),
        });
        const edgar = ctx.providers.get("sec_edgar");
        print({
          ...(result as object),
          httpStatusCounts:
            edgar instanceof SecEdgarProvider ? Object.fromEntries(edgar.http.statusCounts) : {},
          seconds: (Date.now() - started) / 1000,
        });
        break;
      }

      case "screener":
        print(await runJob(ctx, JOBS.refreshScreener, {}));
        break;

      case "alerts":
        print(
          await runJob(ctx, JOBS.evaluateAlerts, {
            trigger: "manual",
            ...(flag("through") ? { through: flag("through") } : {}),
          }),
        );
        break;

      case "backtests": {
        const queued = await dispatchQueuedBacktests(ctx);
        print({ ...queued, ...(await drain()) });
        break;
      }

      case "backtest": {
        const runId = flag("run");
        if (!runId || !/^[0-9]+$/.test(runId)) throw new Error("backtest needs --run <run id>");
        // Re-running a finished run puts it back in the queue first (same request, fresh data).
        await db
          .updateTable("backtest_runs")
          .set({ status: "queued", error: null, started_at: null, finished_at: null })
          .where("run_id", "=", runId)
          .where("status", "in", ["succeeded", "failed", "cancelled"])
          .execute();
        print(await runJob(ctx, JOBS.runBacktest, { runId }));
        break;
      }

      case "earnings":
      case "releases": {
        const window = {
          ...(flag("from") ? { from: flag("from") } : {}),
          ...(flag("to") ? { to: flag("to") } : {}),
        };
        print(
          await runJob(
            ctx,
            command === "earnings" ? JOBS.ingestEarnings : JOBS.ingestReleases,
            window,
          ),
        );
        break;
      }

      case "macro": {
        for (const seriesId of list(flag("series")) ?? DEFAULT_MACRO_SERIES) {
          print(await runJob(ctx, JOBS.ingestMacro, { seriesId }));
        }
        break;
      }

      case "monitor":
        print(await runJob(ctx, JOBS.stalenessMonitor, {}));
        print(await drain());
        break;

      case "partitions":
        print(await runJob(ctx, JOBS.ensurePartitions, {}));
        break;

      case "routing":
        print(await db.selectFrom("ops.dataset_routing").selectAll().execute());
        break;

      default:
        throw new Error(
          `Unknown command "${command ?? ""}". See the header of apps/worker/src/cli.ts.`,
        );
    }
    if (failures.length > 0) {
      print({ failures: failures.slice(0, 20), total: failures.length });
      process.exitCode = 1;
    }
  } finally {
    limiterRedis?.disconnect();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
