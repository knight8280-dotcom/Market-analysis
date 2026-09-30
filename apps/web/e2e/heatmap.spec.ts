import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

test("heatmap: tiles, keyboard navigation, periods and views", async ({ page }) => {
  await signIn(page, "/heatmap");
  await expect(page.getByRole("heading", { name: "Heatmap", level: 1 })).toBeVisible();
  const tiles = page.locator("[data-testid^=tile-]");
  await expect(tiles.first()).toBeVisible();
  expect(await tiles.count()).toBeGreaterThan(1);
  // Synthetic securities have no SEC shares outstanding, so tiles are sized by dollar volume.
  await expect(page.getByRole("link", { name: "Dollar volume" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectAccessible(page);

  // One tile in the tab order; arrow keys move it, Home and End jump to the ends.
  const inTabOrder = page.locator("[data-testid^=tile-][tabindex='0']");
  await expect(inTabOrder).toHaveCount(1);
  await inTabOrder.focus();
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  const first = await focused();
  await page.keyboard.press("End");
  const last = await focused();
  expect(last).not.toBe(first);
  await expect(page.getByTestId(last!)).toHaveAttribute("tabindex", "0");
  await expect(page.getByTestId(first!)).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Home");
  expect(await focused()).toBe(first);
  const moves = new Set([first]);
  for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
    await page.keyboard.press(key);
    moves.add(await focused());
  }
  expect(moves.size).toBeGreaterThan(1);

  // Every tile's name starts with its visible ticker and signed change.
  const label = await page.getByTestId(first!).getAttribute("aria-label");
  expect(label).toMatch(/^TEST_\w+ ([+−]\d+\.\d{2}%|0\.00%|—), /);

  await page.getByRole("link", { name: "1 week" }).click();
  await expect(page).toHaveURL(/period=1w/);
  await expect(page.getByRole("link", { name: "1 week" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Stocks by sector: 1 week" })).toBeVisible();

  await page.getByRole("link", { name: "ETFs" }).click();
  await expect(page.getByRole("heading", { name: "ETFs: 1 week" })).toBeVisible();

  // Enter opens the focused tile's ticker page.
  const tile = page.locator("[data-testid^=tile-][tabindex='0']");
  const ticker = (await tile.getAttribute("data-testid"))!.replace("tile-", "");
  await tile.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/stocks/${ticker}(\\?|$)`));
});
