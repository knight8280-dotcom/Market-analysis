import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

test("calendar tabs, empty states and .ics download", async ({ page }) => {
  await signIn(page, "/calendar");
  await expect(page.getByRole("heading", { name: "Calendar", level: 1 })).toBeVisible();

  // The seed's 8-K Item 2.02 for TEST_FIN appears as a past report date.
  const earnings = page.getByRole("region", { name: "Earnings" });
  const row = earnings.getByRole("row").filter({ hasText: "TEST_FIN" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("SEC 8-K Item 2.02");
  await expectAccessible(page);

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download .ics" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("market-analysis-earnings.ics");
  const ics = await (await file.createReadStream()).toArray();
  const text = Buffer.concat(ics).toString("utf8");
  expect(text).toMatch(/^BEGIN:VCALENDAR\r\n/);
  expect(text).toContain("SUMMARY:TEST_FIN earnings");

  // No FRED data in the test database: the economic tab explains what to configure.
  await page.getByRole("link", { name: "Economic releases" }).click();
  await expect(page.getByRole("link", { name: "Economic releases" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText("No releases in this window")).toBeVisible();
  await expect(page.getByText(/FRED_API_KEY/)).toBeVisible();

  await page.getByRole("link", { name: "Dividends and splits" }).click();
  await expect(page.getByRole("heading", { name: "Dividends and splits" })).toBeVisible();
  await expectAccessible(page);
});

test("the .ics endpoint needs the owner's session", async ({ request }) => {
  const res = await request.get("/api/calendar?tab=earnings", { maxRedirects: 0 });
  expect([302, 307, 401]).toContain(res.status());
});
