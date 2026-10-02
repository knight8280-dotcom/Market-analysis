import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";
import { runBacktestsJob } from "./worker";

/**
 * Backtests (Phase 2 step B8): build a strategy, queue it, let the worker run it, read the
 * report with its disclosure and assumptions, re-run it on the same data, sweep a parameter,
 * and hide the whole feature with its flag.
 */
test.describe.configure({ mode: "serial" });

const TICKERS = "TEST_DIV, TEST_SPLIT4, TEST_DELIST";

async function fillCommon(page: Page, name: string) {
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Universe").selectOption("tickers");
  await page.getByLabel("Tickers").fill(TICKERS);
  await page.getByLabel("Start", { exact: true }).fill("2019-01-02");
  await page.getByLabel("End", { exact: true }).fill("2022-12-30");
}

async function runQueued(page: Page) {
  await expect(page.getByTestId("run-status")).toHaveText(/Queued|Running/);
  await runBacktestsJob();
  await expect(page.getByTestId("run-status")).toHaveText("Finished", { timeout: 30_000 });
}

test("a strategy runs in the worker and its report shows results with their assumptions", async ({
  page,
}) => {
  await signIn(page, "/backtests");
  await expect(page.getByRole("heading", { name: "Backtests", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Backtests" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "New backtest" }).first().click();
  await expect(page.getByRole("heading", { name: "New backtest" })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Trend: 50-day above 200-day average" }).click();
  await fillCommon(page, "E2E trend");
  // A bad value is caught before anything is queued.
  await page.getByLabel("Max positions").fill("abc");
  await page.getByRole("button", { name: "Run backtest" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Fix these first" })).toContainText(
    "Max positions",
  );
  await expect(page).toHaveURL(/\/backtests\/new/);
  await page.getByLabel("Max positions").fill("2");
  await expect(page.getByRole("region", { name: "Rules in words" })).toContainText(
    "SMA(50) > SMA(200)",
  );
  await page.getByRole("button", { name: "Run backtest" }).click();
  await page.waitForURL(/\/backtests\/\d+$/);
  await runQueued(page);

  // §12: the disclosure with this run's costs sits above the results.
  const disclosure = page.getByRole("note", { name: "Hypothetical results disclosure" });
  await expect(disclosure).toContainText(
    "commissions $1.00 per trade, slippage 5.0 bps, fills at the next session's open",
  );
  await expect(page.getByRole("region", { name: "Summary" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Cumulative return/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Strategy and benchmark measures" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Monthly returns" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Trade log" })).toBeVisible();
  await expect(page.getByLabel("Run assumptions")).toContainText("next session's open");
  await expect(page.getByTestId("snapshot-id")).toHaveText(/^[0-9a-f]{64}$/);
  await expectAccessible(page);
  const fingerprint = await page.getByTestId("snapshot-id").textContent();

  // Re-running the same request on the same data says so.
  await page.getByRole("button", { name: "Run again" }).click();
  await page.waitForURL(/\/backtests\/\d+$/);
  await runQueued(page);
  await expect(page.getByTestId("snapshot-id")).toHaveText(fingerprint!);
  await expect(page.getByLabel("Earlier runs of the same request")).toContainText(
    "same request on the same data",
  );
});

test("a parameter sweep shows every combination and flags the best as hindsight", async ({
  page,
}) => {
  await signIn(page, "/backtests/new");
  await page.getByRole("button", { name: "Sweep: price above an n-day average" }).click();
  await fillCommon(page, "E2E sweep");
  await page.getByLabel("Values for $n").fill("20, 50");
  await expect(page.getByText("2 combinations")).toBeVisible();
  await page.getByRole("button", { name: "Run analysis" }).click();
  await page.waitForURL(/\/backtests\/\d+$/);
  await runQueued(page);
  // Ranked by Sharpe ratio when T-bill rates are stored, else by CAGR (the builder's default).
  await expect(
    page.getByText(/Best of 2 parameter combinations by (Sharpe ratio|CAGR)/),
  ).toBeVisible();
  const grid = page.getByRole("table", { name: /^(Sharpe ratio|CAGR) for each value of n$/ });
  await expect(grid.getByRole("columnheader")).toHaveText(["n", "20", "50"]);
  await expect(grid.getByText("(best)")).toHaveCount(1);
  await expectAccessible(page);
});

test("the backtests switch hides the feature", async ({ page }) => {
  await signIn(page, "/settings");
  const row = page.getByTestId("flag-backtests");
  const reset = row.getByRole("button", { name: "Use default" });
  if (await reset.count()) await reset.click();
  await row.getByRole("button", { name: "Turn off Backtests" }).click();
  await expect(row).toHaveAttribute("data-enabled", "false");
  try {
    const res = await page.goto("/backtests");
    expect(res?.status()).toBe(404);
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Backtests" }),
    ).toHaveCount(0);
  } finally {
    await page.goto("/settings");
    await page.getByTestId("flag-backtests").getByRole("button", { name: "Use default" }).click();
    await expect(page.getByTestId("flag-backtests")).toHaveAttribute("data-enabled", "true");
  }
});
