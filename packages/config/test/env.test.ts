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

  it("takes the app's address for email links without a trailing slash", () => {
    expect(loadWorkerEnv(worker).APP_BASE_URL).toBe("http://localhost:3000");
    expect(
      loadWorkerEnv({ ...worker, APP_BASE_URL: "https://desk.example-tailnet.ts.net/" })
        .APP_BASE_URL,
    ).toBe("https://desk.example-tailnet.ts.net");
    expect(
      problemsOf(() => loadWorkerEnv({ ...worker, APP_BASE_URL: "javascript:alert(1)" })),
    ).toHaveLength(1);
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

  it("takes FINRA's credential as a pair and treats the secret as secret", () => {
    expect(problemsOf(() => loadWorkerEnv({ ...worker, FINRA_API_CLIENT_ID: "client-1" }))).toEqual(
      [expect.stringContaining("FINRA_API_CLIENT_SECRET")],
    );
    const source = {
      ...worker,
      FINRA_API_CLIENT_ID: "client-1",
      FINRA_API_CLIENT_SECRET: "finra-secret-value-123",
    };
    expect(loadWorkerEnv(source).FINRA_API_CLIENT_ID).toBe("client-1");
    expect(redactSecrets("token finra-secret-value-123 sent", source)).not.toContain(
      "finra-secret-value-123",
    );
  });

  it("keeps AI off without a key, caps monthly spending and treats the key as secret", () => {
    const off = loadWorkerEnv(worker);
    expect(off.ANTHROPIC_API_KEY).toBeUndefined();
    expect(off.AI_MONTHLY_BUDGET_USD).toBe(10);
    expect(off.AI_SENTIMENT_MODEL).toBe("claude-haiku-4-5-20251001");
    const source = {
      ...worker,
      ANTHROPIC_API_KEY: "sk-ant-test-value-123",
      AI_MONTHLY_BUDGET_USD: "2.5",
    };
    expect(loadWorkerEnv(source).AI_MONTHLY_BUDGET_USD).toBe(2.5);
    expect(redactSecrets("key sk-ant-test-value-123 sent", source)).not.toContain(
      "sk-ant-test-value-123",
    );
    expect(
      problemsOf(() => loadWorkerEnv({ ...worker, AI_MONTHLY_BUDGET_USD: "-1" })).join("\n"),
    ).toContain("AI_MONTHLY_BUDGET_USD");
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

describe("Web Push settings", () => {
  const web = {
    APP_ENV: "local",
    DATABASE_URL: "postgres://app:db-password-123@localhost:5432/market",
    OWNER_PASSWORD_HASH: `scrypt:17:8:1:${"s".repeat(22)}:${"h".repeat(43)}`,
    SESSION_SECRET: "x".repeat(32),
  };
  const push = {
    WEB_PUSH_PUBLIC_KEY: `B${"p".repeat(86)}`,
    WEB_PUSH_PRIVATE_KEY: "k".repeat(43),
    WEB_PUSH_CONTACT: "mailto:owner@example.invalid",
  };

  it("takes all three or none, in the worker and the web app", () => {
    expect(loadWorkerEnv(worker).WEB_PUSH_PUBLIC_KEY).toBeUndefined();
    expect(loadWorkerEnv({ ...worker, ...push }).WEB_PUSH_CONTACT).toBe(push.WEB_PUSH_CONTACT);
    expect(loadWebEnv({ ...web, ...push }).WEB_PUSH_PUBLIC_KEY).toBe(push.WEB_PUSH_PUBLIC_KEY);
    for (const load of [loadWorkerEnv, loadWebEnv]) {
      const base = load === loadWorkerEnv ? worker : web;
      const problems = problemsOf(() => load({ ...base, ...push, WEB_PUSH_CONTACT: undefined }));
      expect(problems).toEqual([
        "WEB_PUSH_CONTACT WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY and WEB_PUSH_CONTACT go together",
      ]);
    }
  });

  it("checks the keys' form and the contact, never repeating the private key", () => {
    const problems = problemsOf(() =>
      loadWebEnv({
        ...web,
        WEB_PUSH_PUBLIC_KEY: "not-a-key",
        WEB_PUSH_PRIVATE_KEY: "short-private-key-value",
        WEB_PUSH_CONTACT: "owner@example.invalid",
      }),
    );
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).not.toContain("short-private-key-value");
    expect(
      loadWebEnv({ ...web, ...push, WEB_PUSH_CONTACT: "https://example.invalid/contact" })
        .WEB_PUSH_CONTACT,
    ).toBe("https://example.invalid/contact");
  });

  it("lets a stand-in push service on 127.0.0.1 in only for tests", () => {
    expect(loadWebEnv({ ...web, APP_ENV: "test", WEB_PUSH_ALLOW_LOOPBACK: "true" })).toMatchObject({
      WEB_PUSH_ALLOW_LOOPBACK: true,
    });
    expect(loadWorkerEnv(worker).WEB_PUSH_ALLOW_LOOPBACK).toBe(false);
    for (const appEnv of ["local", "production"]) {
      expect(
        problemsOf(() => loadWebEnv({ ...web, APP_ENV: appEnv, WEB_PUSH_ALLOW_LOOPBACK: "true" })),
      ).toEqual(["WEB_PUSH_ALLOW_LOOPBACK is only allowed when APP_ENV=test"]);
    }
  });
});
