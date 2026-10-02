import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

/**
 * News tab (Phase 2 step I1) on the seeded TEST_FIN: a press release with a wire copy, a news
 * story, an exhibit without a headline and a story older than the tab's 90 days (e2e/seed.ts;
 * all made up).
 */
test.describe.configure({ mode: "serial" });

test("stories newest first, with source, time and links out; copies folded in", async ({
  page,
}) => {
  await signIn(page, "/stocks/TEST_FIN");
  await page.getByRole("link", { name: "News", exact: true }).click();
  await expect(page).toHaveURL(/\/stocks\/TEST_FIN\/news$/);
  const list = page.getByRole("list", { name: "TEST_FIN news" });
  const items = list.getByRole("listitem");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("TEST_FIN opens a made-up research center");
  await expect(items.nth(0)).toContainText("Example Daily");
  await expect(items.nth(0)).toContainText("via Finnhub");

  const press = items.nth(1);
  await expect(press).toContainText("Press release");
  await expect(press).toContainText("SEC EDGAR, Form 8-K");
  await expect(press).toContainText("today reported made-up results for testing");
  const headline = press.getByRole("link", {
    name: /TEST_FIN Synthetic Financials Corp Reports Fourth Quarter Results/,
  });
  await expect(headline).toHaveAttribute("href", "https://example.invalid/test-fin/8-k/ex99-1.htm");
  await expect(headline).toHaveAttribute("target", "_blank");
  await expect(headline).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(press.getByRole("link", { name: "Example Wire" })).toHaveAttribute(
    "href",
    "https://wire.example.invalid/test-fin-results",
  );

  await expect(items.nth(2)).toContainText("No headline in the filing; this says what was filed.");
  await expect(list).not.toContainText("An old TEST_FIN story");
  await expect(page.getByText(/^As filed, .* · Source: SEC EDGAR$/)).toBeVisible();
  await expect(page.getByText(/^As of .* · Source: Finnhub$/)).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: "Press releases" }).click();
  await expect(page).toHaveURL(/\?source=press$/);
  await expect(items).toHaveCount(2);
  await page.getByRole("link", { name: "News", exact: true }).last().click();
  await expect(page).toHaveURL(/\?source=news$/);
  // The wire copy stays with its press release.
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("research center");
});

test("a ticker without news says so", async ({ page }) => {
  await signIn(page, "/stocks/TEST_DIV/news");
  await expect(page.getByText("No news in the last 90 days")).toBeVisible();
  await expectAccessible(page);
});

test("the news switch hides the tab and its page", async ({ page }) => {
  await signIn(page, "/settings");
  const row = page.getByTestId("flag-news");
  const reset = row.getByRole("button", { name: "Use default" });
  if (await reset.count()) await reset.click();
  await row.getByRole("button", { name: "Turn off News" }).click();
  await expect(row).toHaveAttribute("data-enabled", "false");
  try {
    const res = await page.goto("/stocks/TEST_FIN/news");
    expect(res?.status()).toBe(404);
    await page.goto("/stocks/TEST_FIN");
    await expect(page.getByRole("link", { name: "News", exact: true })).toHaveCount(0);
  } finally {
    await page.goto("/settings");
    await page.getByTestId("flag-news").getByRole("button", { name: "Use default" }).click();
    await expect(page.getByTestId("flag-news")).toHaveAttribute("data-enabled", "true");
  }
});
