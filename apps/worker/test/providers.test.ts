import { loadWorkerEnv } from "@market/config";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { buildProviders } from "../src/providers";

const BASE = {
  APP_ENV: "local",
  DATABASE_URL: "postgres://u:p@localhost:5432/market",
  REDIS_URL: "redis://localhost:6379",
  DATA_PROVIDER_PRIMARY: "synthetic",
};
// The providers never touch Redis at construction; the limiter uses it per request.
const redis = {} as Redis;

describe("buildProviders", () => {
  it("builds only the synthetic provider when no vendor is configured", () => {
    expect([...buildProviders(loadWorkerEnv(BASE)).keys()]).toEqual(["synthetic"]);
  });

  it("adds Tiingo with the key, sharing the Redis quota limiter", () => {
    const env = loadWorkerEnv({ ...BASE, TIINGO_API_KEY: "test-key-not-real" });
    expect(() => buildProviders(env)).toThrow(/Tiingo needs Redis/);
    expect([...buildProviders(env, { limiterRedis: redis }).keys()]).toEqual([
      "synthetic",
      "tiingo",
    ]);
  });

  it("never builds the synthetic provider in production", () => {
    const env = loadWorkerEnv({
      ...BASE,
      APP_ENV: "production",
      DATA_PROVIDER_PRIMARY: "tiingo",
      TIINGO_API_KEY: "test-key-not-real",
    });
    expect([...buildProviders(env, { limiterRedis: redis }).keys()]).toEqual(["tiingo"]);
  });

  it("adds SEC EDGAR only with a declared contact", () => {
    const env = loadWorkerEnv({
      ...BASE,
      EDGAR_ENABLED: "true",
      APP_NAME: "Example Analytics",
      SEC_CONTACT_EMAIL: "admin@example.com",
    });
    expect(buildProviders(env, { limiterRedis: redis }).has("sec_edgar")).toBe(true);
    expect(() => loadWorkerEnv({ ...BASE, EDGAR_ENABLED: "true" })).toThrow(/APP_NAME/);
  });
});
