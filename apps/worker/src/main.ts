import { loadWorkerEnv } from "@market/config";
import { createDb, createPool } from "@market/db";
import { Redis } from "ioredis";
import { threadRunner } from "./backtest/runner";
import type { EventSink } from "./context";
import { dispatchQueuedBacktests } from "./jobs/backtest";
import { DEFAULT_MACRO_SERIES } from "./jobs/ingest-macro";
import { createLogger } from "./log";
import { aiFromEnv } from "./ai";
import { alertDeliveryFromEnv } from "./mail";
import { buildProviders, routingFromEnv } from "./providers";
import { QUEUES } from "./queues";
import { startRuntime } from "./runtime";
import { DEFAULT_SCHEDULE, dueJobs } from "./scheduler";
import { loadUniverse } from "./universe";

/**
 * Long-running worker (spec §3.1): BullMQ workers for every queue, a 30-second scheduler tick
 * driven by the market calendar, and a 3-second poll for backtests the owner queued. Shuts down
 * gracefully on SIGTERM/SIGINT.
 */
async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const log = createLogger(env.LOG_LEVEL);
  const pool = createPool(env.DATABASE_URL, { max: 10, applicationName: "worker" });
  const limiterRedis = new Redis(env.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  const publisher = new Redis(env.REDIS_URL);
  const events: EventSink = {
    async emit(event) {
      log.info({ event }, "event");
      // Cache invalidation and live updates subscribe to this channel (Phase 1).
      await publisher.publish("market-events", JSON.stringify(event));
    },
  };
  const universe = loadUniverse(env.UNIVERSE_FILE);
  const providers = buildProviders(env, { limiterRedis, universe });
  const db = createDb(pool);
  const runtime = startRuntime(
    {
      appEnv: env.APP_ENV,
      db,
      providers,
      routes: routingFromEnv(env),
      clock: () => new Date(),
      log,
      events,
      universe,
      alertDelivery: alertDeliveryFromEnv(env),
      ai: aiFromEnv(env),
      backtests: threadRunner({ db, databaseUrl: env.DATABASE_URL, log }),
    },
    { connection: () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }) },
  );

  const schedule = {
    ...DEFAULT_SCHEDULE,
    edgarEnabled: providers.has("sec_edgar"),
    earningsEnabled: providers.has("finnhub"),
    releasesEnabled: providers.has("fred"),
    shortInterestEnabled: providers.has("finra"),
    newsEnabled: providers.has("finnhub"),
    sentimentEnabled: Boolean(env.ANTHROPIC_API_KEY),
    macroSeries: providers.has("fred") ? DEFAULT_MACRO_SERIES : [],
  };
  const tick = async () => {
    for (const job of dueJobs(new Date(), schedule)) await runtime.dispatcher.dispatch(job);
  };
  await tick();
  const timer = setInterval(() => {
    tick().catch((err: unknown) => log.error({ err }, "scheduler tick failed"));
  }, 30_000);
  const backtestCtx = { db, clock: () => new Date(), dispatch: runtime.dispatcher };
  let polling = false;
  const backtestPoll = setInterval(() => {
    if (polling) return;
    polling = true;
    dispatchQueuedBacktests(backtestCtx)
      .catch((err: unknown) => log.error({ err }, "backtest poll failed"))
      .finally(() => (polling = false));
  }, 3_000);
  log.info({ queues: Object.values(QUEUES), providers: [...providers.keys()] }, "worker started");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    clearInterval(timer);
    clearInterval(backtestPoll);
    await runtime.close();
    limiterRedis.disconnect();
    publisher.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `worker failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
