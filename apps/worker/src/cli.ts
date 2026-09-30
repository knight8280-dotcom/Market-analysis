import { latestClosedSession } from "@market/calendar";
import { loadWorkerEnv } from "@market/config";
import { createDb, createPool } from "@market/db";
import { ProviderId } from "@market/market-data";
import { padCik, SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import { Redis } from "ioredis";
import type { JobRequest, WorkerContext } from "./context";
import { InlineDispatcher } from "./dispatch";
import { DEFAULT_MACRO_SERIES } from "./jobs/ingest-macro";
import { runJob } from "./jobs/index";
import { createLogger } from "./log";
import { buildProviders, routingFromEnv } from "./providers";
import { JOBS, jobId } from "./queues";
import { mappingsFor } from "./repo/securities";

/**
 * Operator CLI: runs job handlers in-process (no queue) for backfills, one-off ingests, the live
 * EDGAR acceptance run and monitor checks. Usage: pnpm worker <command> [--flags].
 *
 *   ingest-securities [--source synthetic]
 *   backfill --from YYYY-MM-DD --to YYYY-MM-DD [--source synthetic] [--symbols A,B]
 *   eod --date YYYY-MM-DD [--source synthetic]
 *   reconcile --through YYYY-MM-DD [--days 5]
 *   recompute-adjustments
 *   edgar --tickers AAPL,MSFT | --ciks 320193,789019 [--facts-only]
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
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function main(): Promise<void> {
  const command = process.argv[2];
  const env = loadWorkerEnv();
  const log = createLogger(env.LOG_LEVEL);
  const pool = createPool(env.DATABASE_URL, { max: 4, applicationName: "worker-cli" });
  const db = createDb(pool);
  const limiterRedis = env.EDGAR_ENABLED
    ? new Redis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
    : undefined;
  const at = flag("at");
  const clock = at ? () => new Date(at) : () => new Date();
  const dispatcher = new InlineDispatcher();
  const ctx: WorkerContext = {
    appEnv: env.APP_ENV,
    db,
    providers: buildProviders(env, { limiterRedis, now: clock }),
    routes: routingFromEnv(env),
    clock,
    log,
    events: { emit: (event) => log.info({ event }, "event") },
    dispatch: dispatcher,
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

  try {
    switch (command) {
      case "ingest-securities":
        print(await runJob(ctx, JOBS.ingestSecurities, { source }));
        break;

      case "backfill": {
        const from = flag("from");
        const to = flag("to");
        if (!from || !to) throw new Error("backfill needs --from and --to");
        const sec = (await runJob(ctx, JOBS.ingestSecurities, { source })) as {
          source: ProviderId;
        };
        const symbols =
          list(flag("symbols")) ??
          (
            await db
              .selectFrom("market.provider_symbols")
              .select("source_symbol")
              .distinct()
              .where("source", "=", sec.source)
              .orderBy("source_symbol")
              .execute()
          ).map((r) => r.source_symbol);
        for (const symbol of symbols) {
          if ((await mappingsFor(db, sec.source, symbol)).length === 0) continue;
          await dispatcher.dispatch({
            name: JOBS.ingestEod,
            data: { symbol, start: from, end: to, source: sec.source },
            jobId: jobId(JOBS.ingestEod, "backfill", from, to, symbol),
          });
        }
        const result = await drain();
        const runs = await db
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
        print({
          symbols: symbols.length,
          jobs: result,
          rows: runs,
          seconds: (Date.now() - started) / 1000,
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
        const perCompany: unknown[] = [];
        for (const cik of [...new Set(ciks)]) {
          if (!process.argv.includes("--facts-only"))
            await runJob(ctx, JOBS.ingestFilings, { cik });
          perCompany.push(await runJob(ctx, JOBS.ingestFundamentals, { cik }));
        }
        await drain();
        print({
          companies: perCompany.length,
          perCompany,
          // The acceptance criterion: no 403 or 429 from SEC during the whole run.
          httpStatusCounts: Object.fromEntries(edgar.http.statusCounts),
          seconds: (Date.now() - started) / 1000,
        });
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
