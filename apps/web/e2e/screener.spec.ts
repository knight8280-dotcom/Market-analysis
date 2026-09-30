import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

test.beforeEach(async ({ page }) => {
  await signIn(page, "/screener");
  await expect(page.getByRole("heading", { name: "Screener", level: 1 })).toBeVisible();
});

test("a preset lists labelled matches", async ({ page }) => {
  await page.getByRole("link", { name: "RSI below 30" }).click();
  await expect(page).toHaveURL(/preset=rsi-below-30/);
  await expect(page.getByRole("heading", { name: /\d[\d,]* match(es)?/ })).toBeVisible();
  await expect(page.getByText(/End-of-day, as of .* · Source: /).first()).toBeVisible();
  await expectAccessible(page);
});

test("the builder runs a custom screen and headers sort it", async ({ page }) => {
  // Replace any conditions with a single "Price above 100".
  for (const remove of await page.getByRole("button", { name: /Remove condition/ }).all()) {
    await remove.click();
  }
  await page.getByRole("button", { name: "Add condition" }).click();
  await page.getByLabel("Condition 1 field").selectOption("close");
  await page.getByLabel("Condition 1 operator").selectOption("gt");
  await page.getByLabel("Condition 1 value").fill("100");
  await page.getByRole("button", { name: "Run screen" }).click();
  await expect(page).toHaveURL(/\/screener\?s=/);
  const results = page.getByRole("region", { name: "Screen results" });
  const firstPrice = results.locator("tbody tr").first().locator("td").nth(3);
  expect(Number((await firstPrice.innerText()).replace(/[$,]/g, ""))).toBeGreaterThan(100);

  await results.getByRole("link", { name: /^Price/ }).click();
  await expect(results.getByRole("columnheader", { name: /Price/ })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await results.getByRole("link", { name: /^Price/ }).click();
  await expect(results.getByRole("columnheader", { name: /Price/ })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
});

test("screens can be saved and deleted", async ({ page }) => {
  const name = `E2E screen ${Date.now()}`;
  await page.getByRole("link", { name: "Up 5%+ today" }).click();
  await page.getByLabel("Screen name").fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/saved=\d+/);
  await expect(page.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(page.getByRole("link", { name })).toHaveCount(0);
});

test("an invalid condition is explained, not run", async ({ page }) => {
  await page.getByRole("button", { name: "Add condition" }).click();
  const last = (await page.getByLabel(/Condition \d+ value/).all()).at(-1)!;
  await last.fill("");
  await page.getByRole("button", { name: "Run screen" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Condition \d+:/ })).toBeVisible();
});
