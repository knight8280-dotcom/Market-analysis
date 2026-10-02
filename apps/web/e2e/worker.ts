import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDb, createPool, sql } from "@market/db";

/** Shared by the alert and journey specs: the worker CLI, a Resend stand-in and test data. */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

export interface CapturedEmail {
  auth: string | undefined;
  body: { from: string; to: string[]; subject: string; text: string };
}

/** A local HTTP server that accepts Resend's POST /emails and keeps what it receives. */
export async function startCaptureServer() {
  const emails: CapturedEmail[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      emails.push({
        auth: req.headers.authorization,
        body: JSON.parse(data) as CapturedEmail["body"],
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `captured-${emails.length}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    emails,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

/**
 * Runs `pnpm worker alerts` against the E2E database, emailing through `resendUrl`; links in the
 * emails point at `appUrl` (the app under test).
 */
export async function runAlertsJob(resendUrl: string, appUrl?: string): Promise<string> {
  const { stdout } = await promisify(execFile)(
    "pnpm",
    ["--silent", "--filter", "@market/worker", "run", "cli", "alerts"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        APP_ENV: "test",
        DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
        DATA_PROVIDER_PRIMARY: "synthetic",
        RESEND_API_KEY: "re_e2e_capture",
        RESEND_API_URL: resendUrl,
        ALERT_EMAIL_TO: "owner@e2e.invalid",
        // Re-running the suite on one database the same day would reach the default cap of 20
        // emails; the cap itself is covered by the worker's integration tests.
        ALERT_DAILY_CAP: "1000",
        ...(appUrl ? { APP_BASE_URL: appUrl } : {}),
        LOG_LEVEL: "warn",
      },
      timeout: 60_000,
    },
  );
  return stdout;
}

/** Runs every queued backtest once with `pnpm worker backtests`, as the worker's poll would. */
export async function runBacktestsJob(): Promise<string> {
  const { stdout } = await promisify(execFile)(
    "pnpm",
    ["--silent", "--filter", "@market/worker", "run", "cli", "backtests"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        APP_ENV: "test",
        DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
        DATA_PROVIDER_PRIMARY: "synthetic",
        LOG_LEVEL: "warn",
      },
      timeout: 120_000,
    },
  );
  return stdout;
}

/**
 * A price level strictly between a ticker's last two closes (the earlier one in the later one's
 * split basis), so a crossing alert at that level fires on the latest bar.
 */
export async function crossingLevel(ticker: string): Promise<{
  kind: "price_above" | "price_below";
  level: number;
  /** How the alert email writes the level. */
  money: string;
}> {
  const pool = createPool(DATABASE_URL, { max: 1, applicationName: "e2e" });
  try {
    const rows = await sql<{ close: number; factor: number | null }>`
      select p.close::float8 as close,
        (select af.split_factor from market.adjustment_factors af
         where af.security_id = p.security_id and af.ex_date > p.date
         order by af.ex_date limit 1) as factor
      from market.prices_daily p join market.securities s using (security_id)
      where s.ticker = ${ticker} and p.source = 'synthetic'
      order by p.date desc limit 2
    `.execute(createDb(pool));
    const [latest, previous] = rows.rows;
    const close = latest!.close;
    const prev = (previous!.close * (previous!.factor ?? 1)) / (latest!.factor ?? 1);
    if (close === prev) throw new Error(`${ticker}'s last two closes are equal; pick another`);
    const level = Math.round(((prev + close) / 2) * 10_000) / 10_000;
    return {
      kind: close > prev ? "price_above" : "price_below",
      level,
      money: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(level),
    };
  } finally {
    await pool.end();
  }
}
