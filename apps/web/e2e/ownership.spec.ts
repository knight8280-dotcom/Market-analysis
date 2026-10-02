import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

/**
 * Ownership tab (Phase 2 step H4) on the seeded TEST_FIN: made-up Form 4s, two quarters of 13F
 * positions and FINRA-shaped short interest (e2e/seed.ts). Every figure here follows from the
 * seed; none is real.
 */
test.describe.configure({ mode: "serial" });

test("insiders, 13F holders and short interest, each with its source and date", async ({
  page,
}) => {
  await signIn(page, "/stocks/TEST_FIN");
  await page.getByRole("link", { name: "Ownership" }).click();
  await expect(page).toHaveURL(/\/stocks\/TEST_FIN\/ownership$/);
  await expect(page.getByRole("link", { name: "Ownership" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // Form 4: originals only in the totals; the amendment repeats a purchase and is left out.
  const insiders = page.getByRole("region", { name: "Insider transactions (Form 4)" });
  await expect(insiders).toContainText(
    "Purchases (P): 3,500 shares by 3 insiders (3 lines), $144,000 at the filed prices.",
  );
  await expect(insiders).toContainText(
    "Sales (S): 300 shares by 1 insider (1 line), $12,900 at the filed prices.",
  );
  await expect(insiders).toContainText("1 line from amendments (4/A) left out of these totals");
  await expect(insiders).toContainText(
    "TEST INSIDER ONE, TEST INSIDER TWO, TEST INSIDER THREE (4 filings)",
  );
  const table = page.getByRole("region", { name: "TEST_FIN insider transactions" });
  await expect(table.getByRole("row")).toHaveCount(7);
  const sale = table.getByRole("row").filter({ hasText: "Sale" });
  await expect(sale).toContainText("TEST INSIDER TWO");
  await expect(sale).toContainText("Chief Executive Officer");
  await expect(sale).toContainText("10b5-1");
  await expect(sale).toContainText("−300");
  await expect(sale).toContainText("$43.00");
  const indirect = table.getByRole("row").filter({ hasText: "TEST INSIDER THREE" });
  await expect(indirect).toContainText("Indirect: By TEST Holdings LLC");
  await expect(table.getByRole("row").filter({ hasText: "Derivative" })).toContainText(
    "Stock Option (right to buy)",
  );
  await expect(table.getByRole("link", { name: "Form 4/A" })).toHaveAttribute(
    "href",
    "https://example.invalid/test-fin/form4/0000000042-26-000205",
  );
  await insiders.getByText("Transaction codes (SEC Form 4 instructions)").click();
  await expect(
    insiders.getByText("Open market or private purchase of non-derivative or derivative security"),
  ).toBeVisible();
  await expect(insiders).toContainText("not a signal or a recommendation");
  await expect(insiders.getByText(/^As filed, .* · Source: SEC EDGAR$/)).toBeVisible();

  // 13F: the latest quarter, compared with the one before.
  const holders = page.getByRole("region", { name: "Institutional holders (13F)" });
  await expect(holders).toContainText(
    "As of quarter end Jun 30, 2025, filed Aug 12, 2025 to Aug 14, 2025; 13F data is reported up to 45 days after quarter end.",
  );
  const positions = page.getByRole("region", { name: "Largest 13F positions on Jun 30, 2025" });
  const capital = positions.getByRole("row").filter({ hasText: "TEST Capital Management LP" });
  await expect(capital).toContainText("150,000");
  await expect(capital).toContainText("+50,000");
  await expect(capital).toContainText("+50.00%");
  await expect(capital.getByRole("link", { name: "0000000911-25-000002" })).toHaveAttribute(
    "href",
    "https://www.sec.gov/Archives/edgar/data/911/000000091125000002/",
  );
  await expect(
    positions.getByRole("row").filter({ hasText: "TEST Index Advisors LLC" }),
  ).toContainText("No change");
  await expect(
    positions.getByRole("row").filter({ hasText: "TEST Growth Partners" }),
  ).toContainText("New");
  await expect(
    page
      .getByRole("region", { name: "Positions no longer listed" })
      .getByRole("row")
      .filter({ hasText: "TEST Former Holder Inc" }),
  ).toContainText("60,000");
  await expect(holders).toContainText("+7.32%");
  // CUSIPs only join SEC's files; they are never shown (ADR-032).
  await expect(page.getByText("TESTFIN01")).toHaveCount(0);

  // Short interest: settlement dates and FINRA's attribution.
  const shorts = page.getByRole("region", { name: "Short interest", exact: true });
  await expect(shorts.getByText("Settlement date Sep 15, 2026 · Source: FINRA")).toBeVisible();
  const latest = shorts.getByRole("row").filter({ hasText: "Sep 15, 2026" });
  await expect(latest).toContainText("1,200,000");
  await expect(latest).toContainText("+20.00%");
  await expect(latest).toContainText("3.00");
  await expect(shorts.getByRole("row").filter({ hasText: "Aug 29, 2026" })).toContainText(
    "Revised",
  );
  await expect(shorts.getByRole("row").filter({ hasText: "Aug 15, 2026" })).toContainText("—");
  await expectAccessible(page);

  // An earlier quarter, with nothing loaded before it to compare with.
  await holders.getByRole("link", { name: "Mar 31, 2025" }).click();
  await expect(holders).toContainText("As of quarter end Mar 31, 2025");
  await expect(holders).toContainText("The quarter before is not loaded");
  await expect(
    page
      .getByRole("region", { name: "Largest 13F positions on Mar 31, 2025" })
      .getByRole("row")
      .filter({ hasText: "TEST Former Holder Inc" }),
  ).toContainText("60,000");
});

test("insider-purchase alerts are offered from the tab and need an SEC registrant", async ({
  page,
}) => {
  await signIn(page, "/stocks/TEST_FIN/ownership");
  await page.getByRole("link", { name: "Alert on insider purchases" }).click();
  await expect(page).toHaveURL(/\/alerts\?ticker=TEST_FIN&kind=insider_purchase/);
  await expect(page.getByLabel("Condition")).toHaveValue("insider_purchase");
  await page.getByLabel("At least (USD, at the filed prices)").fill("$100,000");
  await page.getByRole("button", { name: "Create alert" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Alert created." })).toBeVisible();
  const created = new URL(page.url()).searchParams.get("created");
  const row = page.getByTestId(`alert-${created}`);
  await expect(row).toContainText("An insider buys at least $100,000 on the open market (Form 4)");
  await expectAccessible(page);
  await row.getByRole("button", { name: /^Delete TEST_FIN alert/ }).click();
  await expect(row).toHaveCount(0);

  // TEST_DIV is not an SEC registrant: there are no Form 4s to match.
  await page.getByLabel("Ticker", { exact: true }).fill("TEST_DIV");
  await page.getByLabel("Condition").selectOption("insider_purchase");
  await page.getByRole("button", { name: "Create alert" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "That security has no SEC CIK" }),
  ).toBeVisible();
});

test("the ownership switch hides the tab, its page and the alert kind", async ({ page }) => {
  await signIn(page, "/settings");
  const row = page.getByTestId("flag-ownership");
  const reset = row.getByRole("button", { name: "Use default" });
  if (await reset.count()) await reset.click();
  await row.getByRole("button", { name: "Turn off Ownership" }).click();
  await expect(row).toHaveAttribute("data-enabled", "false");
  try {
    const res = await page.goto("/stocks/TEST_FIN/ownership");
    expect(res?.status()).toBe(404);
    await page.goto("/stocks/TEST_FIN");
    await expect(page.getByRole("link", { name: "Ownership" })).toHaveCount(0);
    await page.goto("/alerts?ticker=TEST_FIN&kind=insider_purchase");
    await expect(page.getByLabel("Condition")).toHaveValue("price_above");
    await expect(
      page.getByLabel("Condition").locator('option[value="insider_purchase"]'),
    ).toHaveCount(0);
  } finally {
    await page.goto("/settings");
    await page.getByTestId("flag-ownership").getByRole("button", { name: "Use default" }).click();
    await expect(page.getByTestId("flag-ownership")).toHaveAttribute("data-enabled", "true");
  }
});
