import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

const HEADER = "date,type,ticker,quantity,price,amount,fees,notes";
// Inside the synthetic data CI loads (2025).
const LEDGER = [
  HEADER,
  "2025-01-02,deposit,,,,20000,,Opening deposit",
  "2025-01-03,buy,TEST_DIV,100,32.66,,1.00,",
  "2025-01-06,buy,TEST_SPLIT4,20,50.00,,1.00,",
  "2025-05-01,dividend,TEST_DIV,,,14.00,,Quarterly dividend",
  "2025-06-02,sell,TEST_DIV,40,29.97,,1.00,",
].join("\n");

test("portfolio: rejected imports change nothing; a CSV import shows holdings and returns", async ({
  page,
}) => {
  const name = `E2E portfolio ${Date.now()}`;
  await signIn(page, "/portfolio");
  await page.getByLabel("Portfolio name").fill(name);
  await page.getByLabel("Benchmark ticker").fill("TEST_SPLIT4");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("link", { name: new RegExp(name) })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const paste = page.getByLabel("Or paste CSV");
  const importButton = page.getByRole("button", { name: "Import", exact: true });
  const problems = page.getByRole("list", { name: "Import problems" });

  await paste.fill(`${HEADER}\n2025-01-03,buy,NOPE_NOT_REAL,1,10,,,\n2025-13-01,deposit,,,,5,,`);
  await importButton.click();
  await expect(page.getByRole("alert").filter({ hasText: "Nothing imported" })).toBeVisible();
  await expect(problems).toContainText('Line 3: date "2025-13-01" is not a YYYY-MM-DD date.');

  await paste.fill(`${HEADER}\n2025-01-03,buy,NOPE_NOT_REAL,1,10,,,`);
  await importButton.click();
  await expect(problems).toContainText("Line 2: No security with ticker NOPE_NOT_REAL is loaded.");

  await paste.fill(
    `${HEADER}\n2025-01-03,buy,TEST_DIV,10,30,,,\n2025-02-03,sell,TEST_DIV,11,31,,,`,
  );
  await importButton.click();
  await expect(problems).toContainText(
    "Line 3: Sells 11 TEST_DIV on 2025-02-03, but only 10 held then.",
  );
  await expect(page.getByText("No transactions yet.")).toBeVisible();

  await paste.fill("");
  await page.getByLabel("CSV file (up to 1 MB)").setInputFiles({
    name: "ledger.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(LEDGER),
  });
  await importButton.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Imported 5 transactions." }),
  ).toBeVisible();

  await expect(page.getByTestId("holding-TEST_DIV")).toContainText("60");
  await expect(page.getByTestId("stat-dividends")).toContainText("$14.00");
  await expect(page.getByTestId("stat-twr")).toContainText(/[+−]?[\d,]+\.\d{2}%/);
  await expect(page.getByTestId("stat-xirr")).toContainText("%");
  await expect(page.getByTestId("stat-benchmark")).toContainText("TEST_SPLIT4, same period");
  await expect(page.getByText("Net money in").locator("..")).toContainText("$20,000.00");
  await expect(page.getByRole("img", { name: /^Cumulative return\. Portfolio/ })).toBeVisible();

  // Risk (Phase 2 step C2): measures with their method one focus away, and the holdings' links.
  await expect(page.getByTestId("risk-volatility")).toContainText("%");
  await expect(page.getByTestId("risk-top10")).toContainText("100.0%");
  await expect(page.getByTestId("risk-hhi")).toContainText("equal holdings");
  await expect(page.getByTestId("risk-pnl")).toContainText("$");
  // Reach the method with the keyboard, as a keyboard user would (Tab onto the button).
  await page.getByRole("button", { name: "How volatility is measured" }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tooltip")).toContainText(
    "Sample standard deviation of daily time-weighted returns",
  );
  await page.keyboard.press("Escape");
  const matrix = page.getByRole("table", { name: "Correlation of daily returns between holdings" });
  // Largest holding first, so the order depends on prices; both are there.
  await expect(matrix.getByRole("columnheader")).toHaveCount(3);
  await expect(matrix.getByRole("columnheader", { name: "TEST_DIV" })).toBeVisible();
  await expect(matrix.getByRole("columnheader", { name: "TEST_SPLIT4" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Allocation by asset class" })).toContainText(
    "Stocks",
  );
  await expectAccessible(page);

  // Manual entry uses the same rules.
  await page.getByLabel("Type").selectOption("fee");
  await page.getByLabel("Amount (USD)").fill("5");
  await page.getByLabel("Notes (optional)").fill("Account fee");
  await page.getByRole("button", { name: "Add transaction" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Transaction added." })).toBeVisible();
  await expect(page.getByRole("region", { name: "Transactions" })).toContainText("Account fee");

  await page.getByRole("button", { name: "Delete portfolio" }).click();
  await expect(page.getByRole("link", { name: new RegExp(name) })).toHaveCount(0);
});
