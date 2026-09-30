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
  const web = {
    APP_ENV: "local",
    DATABASE_URL: "postgres://localhost/market",
    ADMIN_BASIC_AUTH_USER: "ops",
    ADMIN_BASIC_AUTH_PASSWORD: "a-long-enough-password",
  };

  it("parses a valid config", () => {
    expect(loadWebEnv(web).ADMIN_BASIC_AUTH_USER).toBe("ops");
  });

  it("requires a strong admin password", () => {
    const problems = problemsOf(() => loadWebEnv({ ...web, ADMIN_BASIC_AUTH_PASSWORD: "short" }));
    expect(problems).toContain("ADMIN_BASIC_AUTH_PASSWORD must be at least 16 characters");
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
