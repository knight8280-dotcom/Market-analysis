import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

// TEST_SPLIT4 has a full synthetic history (about 2,500 sessions over 10 years in CI's data).
const TICKER = "TEST_SPLIT4";

test.beforeEach(async ({ page }) => {
  await signIn(page, `/stocks/${TICKER}?tf=MAX`);
  await expect(page).toHaveURL(new RegExp(`/stocks/${TICKER}`));
});

test("renders the full history within the budget, labelled and attributed", async ({ page }) => {
  const chart = page.getByTestId("price-chart");
  await expect(chart).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
  const ms = Number(await chart.getAttribute("data-render-ms"));
  expect(ms).toBeLessThan(300);
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.getByText(/Adjusted for splits and dividends/)).toBeVisible();
  await expect(page.getByRole("link", { name: /TradingView Lightweight Charts/ })).toHaveAttribute(
    "href",
    "https://www.tradingview.com/",
  );
  await expectAccessible(page);
});

test("timeframes, keyboard shortcuts and settings round-trip through the URL", async ({ page }) => {
  await expect(page.getByTestId("price-chart")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "3M", exact: true }).click();
  await expect(page).toHaveURL(/tf=3M/);
  await page.keyboard.press("]");
  await expect(page).toHaveURL(/tf=6M/);
  await page.keyboard.press("[");
  await page.keyboard.press("[");
  await expect(page).toHaveURL(/tf=1M/);
  await page.getByLabel("Adjusted").uncheck();
  await expect(page.getByText(/As traded \(not adjusted\)/)).toBeVisible();
  await expect(page).toHaveURL(/adj=0/);
});

test("many indicators compute in a worker and render in their own panes", async ({ page }) => {
  await page.goto(`/stocks/${TICKER}?tf=1Y&ind=sma20,sma50,bb20,rsi14,macd,stoch,adx14`);
  const chart = page.getByTestId("price-chart");
  await expect(chart).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
  // Price pane plus four oscillator panes.
  await expect(chart).toHaveCSS("height", `${380 + 4 * 130}px`);
  await page.getByText(/^Indicators \(7\)$/).click();
  await page.getByLabel("RSI 14").uncheck();
  await expect(chart).toHaveCSS("height", `${380 + 3 * 130}px`);
});

test("the data table gives the chart's numbers without the canvas", async ({ page }) => {
  await page.goto(`/stocks/${TICKER}?tf=1M`);
  await page.getByRole("button", { name: /Show data table/ }).click();
  const rows = page.getByRole("table", { name: /daily bars for 1M/ }).locator("tbody tr");
  // About 21 sessions in a month.
  expect(await rows.count()).toBeGreaterThan(15);
  await expectAccessible(page);
});
