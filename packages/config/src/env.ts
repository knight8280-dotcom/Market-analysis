import { z } from "zod";

/**
 * Typed, validated environment configuration (spec §0 rule 5).
 *
 * Every process reads secrets only through `loadWorkerEnv` / `loadWebEnv`. Validation errors name
 * the offending variable but never echo its value.
 */

export const APP_ENVS = ["local", "test", "preview", "staging", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** Market-data providers the worker can route prices to in Phase 0. */
export const MARKET_DATA_PROVIDERS = ["tiingo", "synthetic"] as const;
export type MarketDataProviderName = (typeof MARKET_DATA_PROVIDERS)[number];

/** Variables whose values must never appear in logs, errors or client bundles. */
export const SECRET_ENV_KEYS = [
  "DATABASE_URL",
  "REDIS_URL",
  "FRED_API_KEY",
  "TIINGO_API_KEY",
  "FINNHUB_API_KEY",
  "FINRA_API_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "WEB_PUSH_PRIVATE_KEY",
  "RESEND_API_KEY",
  "OWNER_PASSWORD_HASH",
  "SESSION_SECRET",
] as const;

const booleanFlag = z
  .enum(["true", "false", "1", "0"], { error: 'must be "true", "false", "1" or "0"' })
  .transform((v) => v === "true" || v === "1");

const postgresUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\/.+/.test(v), "must be a postgres:// or postgresql:// URL");

const redisUrl = z
  .string()
  .refine((v) => /^rediss?:\/\/.+/.test(v), "must be a redis:// or rediss:// URL");

const baseShape = {
  APP_ENV: z.enum(APP_ENVS),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  DATABASE_URL: postgresUrl,
};

/**
 * Web Push (Phase 2 step J2, ADR-038): a VAPID key pair from `pnpm push:keys` and a contact
 * address for the push services. All three or none; without them push is simply off.
 */
const webPushShape = {
  /** Given to browsers when they turn push on: a 65-byte P-256 point, base64url. */
  WEB_PUSH_PUBLIC_KEY: z
    .string()
    .regex(/^B[A-Za-z0-9_-]{86}$/, "must be a public key printed by `pnpm push:keys`")
    .optional(),
  /** Signs every push message. */
  WEB_PUSH_PRIVATE_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, "must be a private key printed by `pnpm push:keys`")
    .optional(),
  /** A mailto: or https: address the push services may use to reach you (Apple requires one). */
  WEB_PUSH_CONTACT: z
    .string()
    .regex(
      /^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/\S+)$/,
      "must be a mailto: or https: address",
    )
    .optional(),
  /** Tests only: lets a stand-in push service on 127.0.0.1 take subscriptions and messages. */
  WEB_PUSH_ALLOW_LOOPBACK: booleanFlag.default(false),
};

function checkWebPush(
  env: {
    APP_ENV: AppEnv;
    WEB_PUSH_PUBLIC_KEY?: string;
    WEB_PUSH_PRIVATE_KEY?: string;
    WEB_PUSH_CONTACT?: string;
    WEB_PUSH_ALLOW_LOOPBACK: boolean;
  },
  ctx: z.RefinementCtx,
) {
  const keys = ["WEB_PUSH_PUBLIC_KEY", "WEB_PUSH_PRIVATE_KEY", "WEB_PUSH_CONTACT"] as const;
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0 && missing.length < keys.length) {
    ctx.addIssue({
      code: "custom",
      path: [missing[0]!],
      message: "WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY and WEB_PUSH_CONTACT go together",
    });
  }
  if (env.WEB_PUSH_ALLOW_LOOPBACK && env.APP_ENV !== "test") {
    ctx.addIssue({
      code: "custom",
      path: ["WEB_PUSH_ALLOW_LOOPBACK"],
      message: "is only allowed when APP_ENV=test",
    });
  }
}

export const workerEnvSchema = z
  .object({
    ...baseShape,
    REDIS_URL: redisUrl,
    /** Brand name used in the SEC User-Agent (`[BRAND_NAME] admin@[DOMAIN]`). */
    APP_NAME: z.string().trim().min(1).optional(),
    SEC_CONTACT_EMAIL: z.email().optional(),
    EDGAR_ENABLED: booleanFlag.default(false),
    FRED_API_KEY: z.string().min(1).optional(),
    FRED_ENABLED: booleanFlag.default(false),
    DATA_PROVIDER_PRIMARY: z.enum(MARKET_DATA_PROVIDERS),
    DATA_PROVIDER_FALLBACK: z.enum([...MARKET_DATA_PROVIDERS, "none"]).default("none"),
    TIINGO_API_KEY: z.string().min(1).optional(),
    /** Tiingo quotas; defaults are the free tier's (50/hour, 1,000/day). */
    TIINGO_HOURLY_LIMIT: z.coerce.number().int().positive().optional(),
    TIINGO_DAILY_LIMIT: z.coerce.number().int().positive().optional(),
    /** Symbols to ingest (default: config/universe.json). */
    UNIVERSE_FILE: z.string().min(1).optional(),
    FINNHUB_API_KEY: z.string().min(1).optional(),
    /** FINRA Query API "Public" credential (free; short interest). Both or neither. */
    FINRA_API_CLIENT_ID: z.string().min(1).optional(),
    FINRA_API_CLIENT_SECRET: z.string().min(1).optional(),
    /** The owner's Anthropic API key (AI features, Phase 2 step I2 on); optional. */
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    /** Spending cap across all AI requests in a calendar month (UTC), in US dollars. */
    AI_MONTHLY_BUDGET_USD: z.coerce.number().min(0).max(1000).default(10),
    /** Model for news sentiment: a small, inexpensive one is enough. */
    AI_SENTIMENT_MODEL: z.string().min(1).default("claude-haiku-4-5-20251001"),
    RESEND_API_KEY: z.string().min(1).optional(),
    /** Where alert emails go: the owner's address (personal use only). */
    ALERT_EMAIL_TO: z.email().optional(),
    ALERT_EMAIL_FROM: z.string().min(3).default("Market Analysis <onboarding@resend.dev>"),
    /** Emails per day across all alerts; further events are recorded as suppressed. */
    ALERT_DAILY_CAP: z.coerce.number().int().min(0).max(1000).default(20),
    /** Resend's API; tests point this at a local capture server. */
    RESEND_API_URL: z.url().default("https://api.resend.com"),
    /** Where links in alert emails point: the address the owner opens the app at. */
    APP_BASE_URL: z
      .url({ protocol: /^https?$/ })
      .default("http://localhost:3000")
      .transform((u) => u.replace(/\/+$/, "")),
    ...webPushShape,
  })
  .superRefine((env, ctx) => {
    checkWebPush(env, ctx);
    const providers = [env.DATA_PROVIDER_PRIMARY, env.DATA_PROVIDER_FALLBACK];

    // MUST-NOT #2: sample data must never be able to pass for real data in production.
    if (env.APP_ENV === "production" && providers.includes("synthetic")) {
      ctx.addIssue({
        code: "custom",
        path: [
          env.DATA_PROVIDER_PRIMARY === "synthetic"
            ? "DATA_PROVIDER_PRIMARY"
            : "DATA_PROVIDER_FALLBACK",
        ],
        message: "the synthetic provider is not allowed when APP_ENV=production",
      });
    }
    if (env.DATA_PROVIDER_FALLBACK === env.DATA_PROVIDER_PRIMARY) {
      ctx.addIssue({
        code: "custom",
        path: ["DATA_PROVIDER_FALLBACK"],
        message: "must differ from DATA_PROVIDER_PRIMARY",
      });
    }
    if (providers.includes("tiingo") && !env.TIINGO_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["TIINGO_API_KEY"],
        message: "is required when tiingo is the primary or fallback provider",
      });
    }
    // SEC fair-access policy requires a declared User-Agent with a real contact.
    if (env.EDGAR_ENABLED && (!env.APP_NAME || !env.SEC_CONTACT_EMAIL)) {
      ctx.addIssue({
        code: "custom",
        path: [!env.APP_NAME ? "APP_NAME" : "SEC_CONTACT_EMAIL"],
        message: "APP_NAME and SEC_CONTACT_EMAIL are required when EDGAR_ENABLED=true",
      });
    }
    if (Boolean(env.FINRA_API_CLIENT_ID) !== Boolean(env.FINRA_API_CLIENT_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: [env.FINRA_API_CLIENT_ID ? "FINRA_API_CLIENT_SECRET" : "FINRA_API_CLIENT_ID"],
        message: "FINRA_API_CLIENT_ID and FINRA_API_CLIENT_SECRET go together",
      });
    }
    if (env.FRED_ENABLED && !env.FRED_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["FRED_API_KEY"],
        message: "is required when FRED_ENABLED=true",
      });
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * `scrypt:<log2 N>:<r>:<p>:<salt>:<hash>` (base64url), printed by `pnpm web:hash-password`.
 * Colons, not "$": Next's .env loader expands "$NAME" and would corrupt a "$"-separated hash.
 */
export const PASSWORD_HASH_PATTERN =
  /^scrypt:\d{2}:\d{1,2}:\d{1,2}:[A-Za-z0-9_-]{22,}:[A-Za-z0-9_-]{43,}$/;

export const webEnvSchema = z
  .object({
    ...baseShape,
    /** The owner's login password, hashed; the password itself is never stored. */
    OWNER_PASSWORD_HASH: z
      .string()
      .regex(PASSWORD_HASH_PATTERN, "must be a hash printed by `pnpm web:hash-password`"),
    /** Signs session cookies. Changing it signs the owner out everywhere. */
    SESSION_SECRET: z
      .string()
      .min(32, "must be at least 32 characters (for example `openssl rand -base64 32`)"),
    /** Optional: live watchlist updates subscribe to the worker's market-events channel. */
    REDIS_URL: redisUrl.optional(),
    /** Host names the app answers to besides localhost, comma-separated (DNS-rebinding guard). */
    WEB_ALLOWED_HOSTS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? "")
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean),
      ),
    /** The web app stores subscriptions and sends the "test notification" itself. */
    ...webPushShape,
  })
  .superRefine(checkWebPush);

export type WebEnv = z.infer<typeof webEnvSchema>;

export class EnvValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "EnvValidationError";
    this.problems = problems;
  }
}

type EnvSource = Record<string, string | undefined>;

/** Blank values (`FOO=` in a .env file) count as unset. */
function normalize(source: EnvSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") out[key] = value;
  }
  return out;
}

function loadEnv<S extends z.ZodType>(schema: S, source: EnvSource): z.infer<S> {
  const normalized = normalize(source);
  const result = schema.safeParse(normalized);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.map(String).join(".") || "(root)";
    const missing = issue.code !== "custom" && normalized[key] === undefined;
    const message = missing ? "is required" : issue.message;
    return redactSecrets(`${key} ${message}`, normalized);
  });
  throw new EnvValidationError(problems);
}

export function loadWorkerEnv(source: EnvSource = process.env): WorkerEnv {
  return loadEnv(workerEnvSchema, source);
}

export function loadWebEnv(source: EnvSource = process.env): WebEnv {
  return loadEnv(webEnvSchema, source);
}

/** Replaces any secret env value found in `text` with `[REDACTED:<KEY>]`. */
export function redactSecrets(text: string, source: EnvSource = process.env): string {
  let out = text;
  for (const key of SECRET_ENV_KEYS) {
    const value = source[key];
    // Very short values would redact innocent substrings; real secrets are longer.
    if (value && value.length >= 6) out = out.split(value).join(`[REDACTED:${key}]`);
  }
  return out;
}

export function isProduction(appEnv: AppEnv): boolean {
  return appEnv === "production";
}
