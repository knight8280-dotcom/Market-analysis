import type { WorkerEnv } from "@market/config";
import {
  buildRoutingTable,
  type MarketDataProvider,
  type ProviderId,
  type RoutingTable,
} from "@market/market-data";
import { FinnhubProvider } from "@market/market-data/adapters/finnhub";
import { FredProvider } from "@market/market-data/adapters/fred";
import { SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import { SyntheticProvider } from "@market/market-data/adapters/synthetic";
import { TiingoProvider } from "@market/market-data/adapters/tiingo";
import {
  CompositeLimiter,
  RedisSlidingWindowLimiter,
  SEC_RATE_LIMIT,
  tiingoRateLimits,
} from "@market/market-data/rate-limit";
import type { Redis } from "ioredis";
import { assetClassMap, loadUniverse, type Universe } from "./universe";

/**
 * Builds the providers this process may call, from validated env. The synthetic provider exists
 * only outside production (the env schema also refuses to route to it in production).
 */
export function buildProviders(
  env: WorkerEnv,
  deps: { limiterRedis?: Redis; now?: () => Date; universe?: Universe } = {},
): Map<ProviderId, MarketDataProvider> {
  const providers = new Map<ProviderId, MarketDataProvider>();
  const needRedis = (what: string) => {
    if (!deps.limiterRedis) throw new Error(`${what} needs Redis for its shared rate limiter`);
    return deps.limiterRedis;
  };
  if (env.APP_ENV !== "production")
    providers.set("synthetic", new SyntheticProvider({ now: deps.now }));
  if (env.TIINGO_API_KEY) {
    const redis = needRedis("Tiingo");
    const universe = deps.universe ?? loadUniverse(env.UNIVERSE_FILE);
    const limits = tiingoRateLimits({
      hourly: env.TIINGO_HOURLY_LIMIT,
      daily: env.TIINGO_DAILY_LIMIT,
    });
    providers.set(
      "tiingo",
      new TiingoProvider({
        apiKey: env.TIINGO_API_KEY,
        assetClasses: assetClassMap(universe),
        // Free-tier quotas can mean waiting most of an hour for a slot; jobs just wait.
        rateLimiter: new CompositeLimiter(
          limits.map((l) => new RedisSlidingWindowLimiter(redis, { ...l, maxWaitMs: 65 * 60_000 })),
        ),
        now: deps.now,
      }),
    );
  }
  if (env.EDGAR_ENABLED && env.APP_NAME && env.SEC_CONTACT_EMAIL) {
    providers.set(
      "sec_edgar",
      new SecEdgarProvider({
        appName: env.APP_NAME,
        contactEmail: env.SEC_CONTACT_EMAIL,
        rateLimiter: new RedisSlidingWindowLimiter(needRedis("EDGAR"), SEC_RATE_LIMIT),
        now: deps.now,
      }),
    );
  }
  if (env.FINNHUB_API_KEY) {
    providers.set(
      "finnhub",
      new FinnhubProvider({
        apiKey: env.FINNHUB_API_KEY,
        // Free plan: 60 calls/minute; stay at half.
        rateLimiter: new RedisSlidingWindowLimiter(needRedis("Finnhub"), {
          key: "ratelimit:finnhub",
          limit: 30,
          windowMs: 60_000,
        }),
        now: deps.now,
      }),
    );
  }
  if (env.FRED_ENABLED && env.FRED_API_KEY) {
    providers.set("fred", new FredProvider({ apiKey: env.FRED_API_KEY, now: deps.now }));
  }
  return providers;
}

export function routingFromEnv(env: WorkerEnv): RoutingTable {
  return buildRoutingTable({
    primary: env.DATA_PROVIDER_PRIMARY,
    fallback: env.DATA_PROVIDER_FALLBACK === "none" ? null : env.DATA_PROVIDER_FALLBACK,
  });
}
