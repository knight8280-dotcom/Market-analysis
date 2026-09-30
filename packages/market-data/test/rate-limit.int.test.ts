import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { RateLimiterUnavailableError } from "../src/errors";
import { HttpClient } from "../src/http";
import { RedisSlidingWindowLimiter } from "../src/rate-limit/sliding-window";
import { json, startServer } from "./helpers/server";

const redisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const connections: Redis[] = [];
function connect(url = redisUrl): Redis {
  const r = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  r.on("error", () => {});
  connections.push(r);
  return r;
}
afterAll(() => {
  for (const r of connections) r.disconnect();
});

async function ready(r: Redis): Promise<void> {
  if (r.status !== "ready") await new Promise((resolve) => r.once("ready", resolve));
}

describe("RedisSlidingWindowLimiter", () => {
  it("never grants more than 8 slots in any 1s window across 3 processes", async () => {
    const key = `test:ratelimit:${randomUUID()}`;
    const limiters = [connect(), connect(), connect()];
    await Promise.all(limiters.map(ready));
    const grants: number[] = [];
    const deadline = Date.now() + 5000;
    await Promise.all(
      limiters.map(async (redis) => {
        const limiter = new RedisSlidingWindowLimiter(redis, { key, limit: 8, windowMs: 1000 });
        while (Date.now() < deadline) grants.push(await limiter.acquire());
      }),
    );
    grants.sort((a, b) => a - b);
    // Any 9 consecutive grants (by Redis server time) span at least one full window.
    for (let i = 8; i < grants.length; i += 1) {
      expect(grants[i]! - grants[i - 8]!).toBeGreaterThanOrEqual(1000);
    }
    // And the limiter is not starving callers: roughly 8/s for ~5s.
    expect(grants.length).toBeGreaterThanOrEqual(40);
    expect(grants.length).toBeLessThanOrEqual(56);
  });

  it("works on a connection that is still opening (fresh process)", async () => {
    const fresh = connect();
    expect(fresh.status).not.toBe("ready");
    const limiter = new RedisSlidingWindowLimiter(fresh, {
      key: `test:fresh:${randomUUID()}`,
      limit: 8,
      windowMs: 1000,
    });
    await expect(limiter.acquire()).resolves.toBeGreaterThan(0);
  });

  it("fails closed when Redis is unreachable, so no request is sent", async () => {
    const dead = connect("redis://127.0.0.1:1");
    const limiter = new RedisSlidingWindowLimiter(dead, {
      key: "test:dead",
      limit: 8,
      windowMs: 1000,
    });
    await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimiterUnavailableError);

    const server = await startServer((_req, res) => json(res, 200, {}));
    try {
      const http = new HttpClient({
        provider: "sec_edgar",
        allowedHosts: [server.host],
        rateLimiter: limiter,
      });
      await expect(http.getJson(server.url("/x"))).rejects.toBeInstanceOf(
        RateLimiterUnavailableError,
      );
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
