import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";
import { crossingLevel, runAlertsJob, startCaptureServer } from "./worker";

/**
 * Phase 1 acceptance journey (plan K1): log in → watchlist → alert fires → email captured →
 * portfolio import → returns shown, with axe on every page it visits.
 */
test("owner journey: watchlist, alert emailed, portfolio returns", async ({ page }) => {
  test.setTimeout(120_000);
  const capture = await startCaptureServer();
  const tag = `Journey ${Date.now()}`;
  try {
    // A ticker whose latest bar moved, so a level between its last two closes is crossed.
    let ticker = "";
    let crossing: Awaited<ReturnType<typeof crossingLevel>> | null = null;
    for (const candidate of ["TEST_DIV", "TEST_SPLIT20", "TEST_RSPLIT"]) {
      crossing = await crossingLevel(candidate).catch(() => null);
      if (crossing) {
        ticker = candidate;
        break;
      }
    }
    expect(crossing, "no candidate ticker moved on its latest bar").not.toBeNull();

    // Log in and build a watchlist.
    await signIn(page, "/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectAccessible(page);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Watchlists" })
      .click();
    await page.getByLabel(/Watchlist name/).fill(tag);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: new RegExp(tag) })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.getByLabel("Ticker to add").fill(ticker);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const row = page.getByTestId(`row-${ticker}`);
    await expect(row).toBeVisible();
    await expectAccessible(page);

    // From the watchlist to the ticker page, and an alert from there.
    await row.getByRole("link", { name: ticker }).click();
    await expect(page.getByRole("heading", { name: ticker, level: 1 })).toBeVisible();
    await page.getByRole("link", { name: "Alert", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/alerts\\?ticker=${ticker}`));
    await expect(page.getByLabel("Ticker", { exact: true })).toHaveValue(ticker);
    await page.getByLabel("Condition").selectOption(crossing!.kind);
    await page.getByLabel("Price (USD)").fill(String(crossing!.level));
    await page.getByRole("button", { name: "Create alert" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Alert created." })).toBeVisible();
    const alertId = new URL(page.url()).searchParams.get("created");

    // The worker's end-of-day evaluation fires it and emails the owner.
    expect(await runAlertsJob(capture.url)).toContain('"fired"');
    const word = crossing!.kind === "price_above" ? "above" : "below";
    const subject = `[SAMPLE DATA] ${ticker} closed ${word} ${crossing!.money}`;
    const email = capture.emails.find((e) => e.body.subject === subject);
    expect(
      email,
      `captured: ${capture.emails.map((e) => e.body.subject).join(" | ")}`,
    ).toBeTruthy();
    expect(email!.body.to).toEqual(["owner@e2e.invalid"]);
    await page.goto("/alerts");
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: subject.replace("[SAMPLE DATA] ", "") })
        .first(),
    ).toContainText("Emailed");
    await expectAccessible(page);

    // Import a portfolio and see its returns.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Portfolio" })
      .click();
    await page.getByLabel("Portfolio name").fill(tag);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: new RegExp(tag) })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page
      .getByLabel("Or paste CSV")
      .fill(
        [
          "date,type,ticker,quantity,price,amount,fees,notes",
          "2025-01-02,deposit,,,,10000,,",
          `2025-01-03,buy,${ticker},20,100,,1.00,`,
          `2025-03-03,buy,${ticker},10,110,,1.00,`,
        ].join("\n"),
      );
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Imported 3 transactions." }),
    ).toBeVisible();
    await expect(page.getByTestId(`holding-${ticker}`)).toContainText("30");
    await expect(page.getByTestId("stat-twr")).toContainText(/\d\.\d{2}%/);
    await expect(page.getByTestId("stat-xirr")).toContainText(/\d\.\d{2}%/);
    await expect(page.getByTestId("stat-value")).toContainText("$");
    await expectAccessible(page);

    // Clean up what the journey created.
    await page.getByRole("button", { name: "Delete portfolio" }).click();
    await expect(page.getByRole("link", { name: new RegExp(tag) })).toHaveCount(0);
    await page.goto("/alerts");
    if (alertId) {
      const alertRow = page.getByTestId(`alert-${alertId}`);
      await alertRow.getByRole("button", { name: /^Delete/ }).click();
      await expect(alertRow).toHaveCount(0);
    }
    await page.goto("/watchlists");
    await page.getByRole("link", { name: new RegExp(tag) }).click();
    await expect(page.getByRole("heading", { name: tag, level: 2 })).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("link", { name: new RegExp(tag) })).toHaveCount(0);
  } finally {
    capture.close();
  }
});
