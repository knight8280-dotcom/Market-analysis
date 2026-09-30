import type { WorkerEnv } from "@market/config";
import {
  buildRoutingTable,
  type MarketDataProvider,
  type ProviderId,
  type RoutingTable,
} from "@market/market-data";
import { FredProvider } from "@market/market-data/adapters/fred";
import { SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import { SyntheticProvider } from "@market/market-data/adapters/synthetic";
import { TiingoProvider } from "@market/market-data/adapters/tiingo";
import { RedisSlidingWindowLimiter, SEC_RATE_LIMIT } from "@market/market-data/rate-limit";
import type { Redis } from "ioredis";

/**
 * Builds the providers this process may call, from validated env. The synthetic provider exists
 * only outside production (the env schema also refuses to route to it in production).
 */
export function buildProviders(
  env: WorkerEnv,
  deps: { limiterRedis?: Redis; now?: () => Date } = {},
): Map<ProviderId, MarketDataProvider> {
  const providers = new Map<ProviderId, MarketDataProvider>();
  if (env.APP_ENV !== "production")
    providers.set("synthetic", new SyntheticProvider({ now: deps.now }));
  if (env.TIINGO_API_KEY)
    providers.set("tiingo", new TiingoProvider({ apiKey: env.TIINGO_API_KEY, now: deps.now }));
  if (env.EDGAR_ENABLED && env.APP_NAME && env.SEC_CONTACT_EMAIL) {
    if (!deps.limiterRedis) throw new Error("EDGAR needs Redis for the shared SEC rate limiter");
    providers.set(
      "sec_edgar",
      new SecEdgarProvider({
        appName: env.APP_NAME,
        contactEmail: env.SEC_CONTACT_EMAIL,
        rateLimiter: new RedisSlidingWindowLimiter(deps.limiterRedis, SEC_RATE_LIMIT),
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
