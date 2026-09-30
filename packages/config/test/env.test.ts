import { describe, expect, it } from "vitest";
import { EnvValidationError, loadWebEnv, loadWorkerEnv, redactSecrets } from "../src/env";

const worker = {
  APP_ENV: "local",
  DATABASE_URL: "postgres://app:db-password-123@localhost:5432/market",
  REDIS_URL: "redis://localhost:6379",
  DATA_PROVIDER_PRIMARY: "synthetic",
};

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof EnvValidationError) return err.problems;
    throw err;
  }
  throw new Error("expected EnvValidationError");
}

describe("loadWorkerEnv", () => {
  it("parses a minimal local config and applies defaults", () => {
    const env = loadWorkerEnv(worker);
    expect(env.APP_ENV).toBe("local");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DATA_PROVIDER_FALLBACK).toBe("none");
    expect(env.EDGAR_ENABLED).toBe(false);
    expect(env.FRED_ENABLED).toBe(false);
  });

  it("reports every missing required variable by name", () => {
    const problems = problemsOf(() => loadWorkerEnv({}));
    expect(problems).toEqual(
      expect.arrayContaining([
        "APP_ENV is required",
        "DATABASE_URL is required",
        "REDIS_URL is required",
        "DATA_PROVIDER_PRIMARY is required",
      ]),
    );
  });

  it("treats blank values as unset", () => {
    const problems = problemsOf(() => loadWorkerEnv({ ...worker, REDIS_URL: "  " }));
    expect(problems).toContain("REDIS_URL is required");
  });

  it("rejects malformed URLs without echoing the value", () => {
    const problems = problemsOf(() =>
      loadWorkerEnv({ ...worker, DATABASE_URL: "mysql://root:hunter2-secret@db/x" }),
    );
    expect(problems.join("\n")).toContain("DATABASE_URL must be a postgres");
    expect(problems.join("\n")).not.toContain("hunter2-secret");
  });

  it("refuses the synthetic provider in production (MUST-NOT #2)", () => {
    const problems = problemsOf(() => loadWorkerEnv({ ...worker, APP_ENV: "production" }));
    expect(problems).toContain(
      "DATA_PROVIDER_PRIMARY the synthetic provider is not allowed when APP_ENV=production",
    );

    const asFallback = problemsOf(() =>
      loadWorkerEnv({
        ...worker,
        APP_ENV: "production",
        DATA_PROVIDER_PRIMARY: "tiingo",
        TIINGO_API_KEY: "key-for-test-only",
        DATA_PROVIDER_FALLBACK: "synthetic",
      }),
    );
    expect(asFallback).toContain(
      "DATA_PROVIDER_FALLBACK the synthetic provider is not allowed when APP_ENV=production",
    );
  });

  it("requires a Tiingo key when Tiingo is routed", () => {
    const problems = problemsOf(() =>
      loadWorkerEnv({ ...worker, DATA_PROVIDER_PRIMARY: "tiingo" }),
    );
    expect(problems).toContain(
      "TIINGO_API_KEY is required when tiingo is the primary or fallback provider",
    );
  });

  it("rejects a fallback equal to the primary", () => {
    const problems = problemsOf(() =>
      loadWorkerEnv({ ...worker, DATA_PROVIDER_FALLBACK: "synthetic" }),
    );
    expect(problems).toContain("DATA_PROVIDER_FALLBACK must differ from DATA_PROVIDER_PRIMARY");
  });

  it("requires a declared SEC contact when EDGAR is enabled", () => {
    const problems = problemsOf(() => loadWorkerEnv({ ...worker, EDGAR_ENABLED: "true" }));
    expect(problems.join("\n")).toContain("APP_NAME and SEC_CONTACT_EMAIL are required");

    const env = loadWorkerEnv({
      ...worker,
      EDGAR_ENABLED: "1",
      APP_NAME: "Example Analytics",
      SEC_CONTACT_EMAIL: "admin@example.com",
    });
    expect(env.EDGAR_ENABLED).toBe(true);
  });

  it("requires a FRED key when FRED is enabled", () => {
    const problems = problemsOf(() => loadWorkerEnv({ ...worker, FRED_ENABLED: "true" }));
    expect(problems).toContain("FRED_API_KEY is required when FRED_ENABLED=true");
  });

  it("rejects ambiguous boolean flags", () => {
    const problems = problemsOf(() => loadWorkerEnv({ ...worker, FRED_ENABLED: "yes" }));
    expect(problems.join("\n")).toContain("FRED_ENABLED must be");
  });
});

describe("loadWebEnv", () => {
  // Fake values in the right shape.
  const web = {
    APP_ENV: "local",
    DATABASE_URL: "postgres://localhost/market",
    OWNER_PASSWORD_HASH: `scrypt:17:8:1:${"s".repeat(22)}:${"h".repeat(43)}`,
    SESSION_SECRET: "x".repeat(32),
  };

  it("parses a valid config; extra hosts default to none", () => {
    const env = loadWebEnv(web);
    expect(env.OWNER_PASSWORD_HASH).toBe(web.OWNER_PASSWORD_HASH);
    expect(env.WEB_ALLOWED_HOSTS).toEqual([]);
    expect(loadWebEnv({ ...web, WEB_ALLOWED_HOSTS: " Box.local, " }).WEB_ALLOWED_HOSTS).toEqual([
      "box.local",
    ]);
  });

  it("requires a password hash, not a password", () => {
    const problems = problemsOf(() =>
      loadWebEnv({ ...web, OWNER_PASSWORD_HASH: "hunter2hunter2" }),
    );
    expect(problems).toContain(
      "OWNER_PASSWORD_HASH must be a hash printed by `pnpm web:hash-password`",
    );
    // A "$"-separated hash is refused: .env expansion would have corrupted it.
    expect(() =>
      loadWebEnv({ ...web, OWNER_PASSWORD_HASH: web.OWNER_PASSWORD_HASH.replaceAll(":", "$") }),
    ).toThrow();
  });

  it("requires a long session secret and never echoes it", () => {
    const problems = problemsOf(() => loadWebEnv({ ...web, SESSION_SECRET: "short-secret" }));
    expect(problems.join("\n")).toContain("SESSION_SECRET must be at least 32 characters");
    expect(problems.join("\n")).not.toContain("short-secret");
  });
});

describe("redactSecrets", () => {
  it("replaces secret values with a marker", () => {
    const text = "connect failed for postgres://app:db-password-123@localhost:5432/market";
    expect(redactSecrets(text, worker)).toBe("connect failed for [REDACTED:DATABASE_URL]");
  });

  it("leaves text without secrets untouched", () => {
    expect(redactSecrets("nothing here", worker)).toBe("nothing here");
  });
});
