import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { RateLimiterUnavailableError } from "../errors";

/**
 * A distributed sliding-window-log rate limiter in Redis, shared by every worker process.
 *
 * For SEC EDGAR (spec §2.3: at most 10 requests/second across ALL workers, target 8) it
 * guarantees that no `windowMs` window ever holds more than `limit` grants. A token bucket would
 * allow up to 2x the rate across a window boundary, so it is not used. Timestamps come from
 * Redis `TIME`, so clocks on different hosts do not matter.
 *
 * Pass a Redis connection created with `enableOfflineQueue: false` and a low
 * `maxRetriesPerRequest`, so an outage fails fast instead of queueing: the limiter then throws
 * RateLimiterUnavailableError and no request is sent (fail closed).
 */

const SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
if redis.call('ZCARD', key) < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window * 2)
  return {1, now, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, now, tonumber(oldest[2]) + window - now}
`;

export interface SlidingWindowOptions {
  key: string;
  limit: number;
  windowMs: number;
  /** Give up after waiting this long in total (default 60s). */
  maxWaitMs?: number;
  /** How long to wait for a connection that is still opening (default 2s). */
  connectTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class RedisSlidingWindowLimiter {
  private readonly redis: Redis;
  private readonly opts: Required<SlidingWindowOptions>;

  constructor(redis: Redis, opts: SlidingWindowOptions) {
    if (!(opts.limit >= 1) || !(opts.windowMs >= 1)) {
      throw new RangeError("limit and windowMs must be positive");
    }
    this.redis = redis;
    this.opts = {
      maxWaitMs: 60_000,
      connectTimeoutMs: 2_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...opts,
    };
  }

  /**
   * With the offline queue disabled, a command sent while the connection is still opening fails
   * at once. Wait briefly for "ready" so a freshly started process is not treated as an outage.
   */
  private async ensureReady(): Promise<void> {
    const status = this.redis.status;
    if (status === "ready") return;
    if (status === "end" || status === "close") {
      throw new RateLimiterUnavailableError(
        `Rate limiter ${this.opts.key}: Redis connection is closed`,
      );
    }
    if (status === "wait") void this.redis.connect().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.redis.off("ready", onReady);
        reject(new RateLimiterUnavailableError(`Rate limiter ${this.opts.key}: Redis not ready`));
      }, this.opts.connectTimeoutMs);
      this.redis.once("ready", onReady);
    });
  }

  /** Resolves with the Redis server time (ms) at which the slot was granted. */
  async acquire(): Promise<number> {
    await this.ensureReady();
    let waited = 0;
    for (;;) {
      let result: unknown;
      try {
        result = await this.redis.eval(
          SCRIPT,
          1,
          this.opts.key,
          this.opts.limit,
          this.opts.windowMs,
          randomUUID(),
        );
      } catch (err) {
        throw new RateLimiterUnavailableError(`Rate limiter ${this.opts.key} is unavailable`, err);
      }
      const [granted, now, waitMs] = result as [number, number, number];
      if (granted === 1) return now;
      if (waited >= this.opts.maxWaitMs) {
        throw new RateLimiterUnavailableError(
          `Rate limiter ${this.opts.key}: no slot within ${this.opts.maxWaitMs} ms`,
        );
      }
      const pause = Math.max(1, waitMs);
      waited += pause;
      await this.opts.sleep(pause);
    }
  }
}

/** SEC fair-access policy: 10 requests/second maximum; we target 8. */
export const SEC_RATE_LIMIT = { key: "ratelimit:sec-edgar", limit: 8, windowMs: 1000 } as const;

/** Takes a slot from every limiter in order (e.g. an hourly and a daily quota). */
export class CompositeLimiter {
  constructor(private readonly limiters: readonly { acquire(): Promise<unknown> }[]) {}

  async acquire(): Promise<void> {
    for (const limiter of this.limiters) await limiter.acquire();
  }
}

/**
 * Tiingo quotas per plan. Free-tier numbers are from the project brief (50 requests/hour,
 * 1,000/day); override them with TIINGO_HOURLY_LIMIT / TIINGO_DAILY_LIMIT for a paid plan.
 */
export function tiingoRateLimits(opts: { hourly?: number; daily?: number } = {}) {
  return [
    { key: "ratelimit:tiingo:hour", limit: opts.hourly ?? 50, windowMs: 3_600_000 },
    { key: "ratelimit:tiingo:day", limit: opts.daily ?? 1_000, windowMs: 86_400_000 },
  ] as const;
}
