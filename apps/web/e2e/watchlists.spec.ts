import { expect, test } from "@playwright/test";
import { Redis } from "ioredis";
import { expectAccessible, signIn } from "./helpers";

test("create a watchlist, add, reorder, get a live update, remove and delete", async ({ page }) => {
  const name = `E2E list ${Date.now()}`;
  await signIn(page, "/watchlists");
  await page.getByLabel(/Watchlist name/).fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("link", { name: new RegExp(name) })).toHaveAttribute(
    "aria-current",
    "page",
  );

  for (const ticker of ["TEST_DIV", "TEST_SPLIT4"]) {
    await page.getByLabel("Ticker to add").fill(ticker);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByTestId(`row-${ticker}`)).toBeVisible();
  }
  await page.getByLabel("Ticker to add").fill("NOPE_NOT_REAL");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("No security with that ticker is loaded.")).toBeVisible();

  const tickers = () =>
    page
      .locator("[data-testid^=row-]")
      .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")));
  expect(await tickers()).toEqual(["row-TEST_DIV", "row-TEST_SPLIT4"]);
  await page.getByRole("button", { name: "Move TEST_SPLIT4 up" }).click();
  await expect.poll(tickers).toEqual(["row-TEST_SPLIT4", "row-TEST_DIV"]);
  await expectAccessible(page);

  // Live: the worker publishes bars_updated; the page shows the fresh quote.
  await expect(page.getByTestId("live-status")).toHaveText(/^Live/);
  const securityId = await page.getByTestId("row-TEST_DIV").getAttribute("data-security-id");
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  try {
    await redis.publish(
      "market-events",
      JSON.stringify({ type: "bars_updated", securityId, date: "2026-09-29", source: "synthetic" }),
    );
  } finally {
    redis.disconnect();
  }
  await expect(page.getByText(/^TEST_DIV updated: \$/)).toBeAttached();

  await page.getByRole("button", { name: "Remove TEST_DIV" }).click();
  await expect(page.getByTestId("row-TEST_DIV")).toHaveCount(0);
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("link", { name: new RegExp(name) })).toHaveCount(0);
});

test("the ticker page adds to and removes from a watchlist", async ({ page }) => {
  const name = `E2E ticker list ${Date.now()}`;
  await signIn(page, "/watchlists");
  await page.getByLabel(/Watchlist name/).fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await page.goto("/stocks/TEST_DIV");
  await page.locator("summary", { hasText: /^Watchlists/ }).click();
  await page.getByRole("button", { name: `Add to ${name}` }).click();
  await expect(page).toHaveURL(/\/stocks\/TEST_DIV(\?|$)/);
  // The menu comes back closed with the security in the list (TEST_DIV may already be in other
  // lists, so the count alone does not show the add has finished).
  const remove = page.getByRole("button", { name: `Remove from ${name}`, includeHidden: true });
  await expect(remove).toBeAttached();
  await page.locator("summary", { hasText: /^Watchlists \(\d+\)/ }).click();
  await expect(remove).toBeVisible();

  await page.goto("/watchlists");
  await page.getByRole("link", { name: new RegExp(name) }).click();
  await expect(page.getByTestId("row-TEST_DIV")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
});
