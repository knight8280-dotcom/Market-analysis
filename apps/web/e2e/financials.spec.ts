import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

test("financials show restated and derived values with their source", async ({ page }) => {
  await signIn(page, "/stocks/TEST_FIN/financials");
  await expect(page.getByRole("link", { name: "Financials" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const table = page.getByRole("table", { name: /income statement, annual/ });
  const revenue = table.getByRole("row", { name: /^Revenue/ });
  // FY2024 revenue was restated from 1,000 to 1,010 in the FY2025 10-K.
  await expect(revenue).toContainText("1,010");
  await expect(revenue).toContainText("(restated)");
  await expect(page.getByText(/As filed, .* · Source: SEC EDGAR/)).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: "As first reported" }).click();
  await expect(
    page.getByRole("table", { name: /as first reported/ }).getByRole("row", { name: /^Revenue/ }),
  ).toContainText("1,000");

  await page.getByRole("link", { name: "Latest" }).click();
  await page.getByRole("link", { name: "Quarterly" }).click();
  const q = page.getByRole("table", { name: /income statement, quarterly/ });
  // Q4 = FY − 9M YTD = 1,200 − 870.
  await expect(q.getByRole("row", { name: /^Revenue/ })).toContainText("330");
  await expect(q.getByRole("row", { name: /^Revenue/ })).toContainText("derived: FY − 9M YTD");
});

test("securities without SEC filings explain why there are no financials", async ({ page }) => {
  await signIn(page, "/stocks/TEST_DIV/financials");
  await expect(page.getByText("No SEC filings for this security")).toBeVisible();
});
