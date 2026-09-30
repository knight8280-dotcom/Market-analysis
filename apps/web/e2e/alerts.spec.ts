import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDb, createPool, sql } from "@market/db";
import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

/** The last two closes of a ticker, the earlier one in the later one's split basis. */
async function lastTwoCloses(ticker: string): Promise<{ prev: number; close: number }> {
  const pool = createPool(DATABASE_URL, { max: 1, applicationName: "e2e-alerts" });
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
    return {
      close: latest!.close,
      prev: (previous!.close * (previous!.factor ?? 1)) / (latest!.factor ?? 1),
    };
  } finally {
    await pool.end();
  }
}

test("create, pause and delete an alert; validation is explained", async ({ page }) => {
  await signIn(page, "/stocks/TEST_DIV");
  await page.getByRole("link", { name: "Alert", exact: true }).click();
  await expect(page).toHaveURL(/\/alerts\?ticker=TEST_DIV/);
  await expect(page.getByLabel("Ticker")).toHaveValue("TEST_DIV");

  await page.getByLabel("Condition").selectOption("pct_move");
  await page.getByLabel("Move (%)").fill("250");
  await page.getByRole("button", { name: "Create alert" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Check the condition" })).toBeVisible();

  await page.getByLabel("Ticker").fill("TEST_DIV");
  await page.getByLabel("Condition").selectOption("pct_move");
  await page.getByLabel("Move (%)").fill("7.5");
  await page.getByLabel("Direction").selectOption("down");
  await page.getByRole("button", { name: "Create alert" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Alert created." })).toBeVisible();
  const created = new URL(page.url()).searchParams.get("created");
  const row = page.getByTestId(`alert-${created}`);
  await expect(row).toContainText("Moves 7.5% or more in a day (down)");
  await expect(row).toContainText("TEST_DIV");
  await expect(row).toContainText("Active");
  await expectAccessible(page);

  await row.getByRole("button", { name: /^Pause TEST_DIV alert/ }).click();
  await expect(row).toContainText("Paused");
  await row.getByRole("button", { name: /^Resume TEST_DIV alert/ }).click();
  await expect(row).toContainText("Active");
  await row.getByRole("button", { name: /^Delete TEST_DIV alert/ }).click();
  await expect(row).toHaveCount(0);
});

test.describe("an alert fires and is emailed", () => {
  let server: Server;
  let emails: { auth: string | undefined; body: { to: string[]; subject: string; text: string } }[];

  test.beforeAll(async () => {
    emails = [];
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString()));
      req.on("end", () => {
        emails.push({
          auth: req.headers.authorization,
          body: JSON.parse(data) as (typeof emails)[number]["body"],
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: `captured-${emails.length}` }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  test.afterAll(() => {
    server.close();
  });

  test("worker evaluates, the capture server receives the email, the page lists it", async ({
    page,
  }) => {
    // A level between the last two closes, so the latest close crosses it.
    const { prev, close } = await lastTwoCloses("TEST_SPLIT4");
    expect(close).not.toBe(prev);
    const level = Math.round(((prev + close) / 2) * 10_000) / 10_000;
    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(level);
    const kind = close > prev ? "price_above" : "price_below";

    await signIn(page, "/alerts");
    await page.getByLabel("Ticker").fill("TEST_SPLIT4");
    await page.getByLabel("Condition").selectOption(kind);
    await page.getByLabel("Price (USD)").fill(String(level));
    await page.getByRole("button", { name: "Create alert" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Alert created." })).toBeVisible();

    const port = (server.address() as AddressInfo).port;
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
          RESEND_API_URL: `http://127.0.0.1:${port}`,
          ALERT_EMAIL_TO: "owner@e2e.invalid",
          LOG_LEVEL: "warn",
        },
        timeout: 60_000,
      },
    );
    expect(stdout).toContain('"fired"');

    const word = kind === "price_above" ? "above" : "below";
    const subject = `[SAMPLE DATA] TEST_SPLIT4 closed ${word} ${money}`;
    const email = emails.find((e) => e.body.subject === subject);
    expect(
      email,
      `captured subjects: ${emails.map((e) => e.body.subject).join(" | ")}`,
    ).toBeTruthy();
    expect(email!.auth).toBe("Bearer re_e2e_capture");
    expect(email!.body.to).toEqual(["owner@e2e.invalid"]);
    expect(email!.body.text).toContain("not investment advice");

    await page.reload();
    const event = page.getByRole("row").filter({ hasText: subject.replace("[SAMPLE DATA] ", "") });
    await expect(event.first()).toContainText("Emailed");
    await expectAccessible(page);
  });
});
