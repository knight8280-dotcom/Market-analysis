import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

/**
 * The customizable dashboard (Phase 2 step F2): widgets moved from the keyboard (focus stays on
 * the button), resized, hidden, shown and dragged; the layout is saved and can be reset.
 */
test.describe.configure({ mode: "serial" });

const DEFAULT = [
  "indices",
  "watchlists",
  "alerts",
  "gainers",
  "losers",
  "portfolio",
  "calendar",
  "screen",
];
const order = (page: Page) =>
  page.locator("[data-widget]").evaluateAll((els) => els.map((e) => e.getAttribute("data-widget")));

test("arrange the dashboard from the keyboard and by dragging; the layout is kept", async ({
  page,
}) => {
  await signIn(page, "/");
  await page.getByRole("link", { name: "Customize" }).click();
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect.poll(() => order(page)).toEqual(DEFAULT);
  await expect(page.getByRole("button", { name: "Move Index ETFs up" })).toBeDisabled();
  await expectAccessible(page);

  // From the keyboard: focus stays on the button while the widget moves.
  const up = page.getByRole("button", { name: "Move Top losers up" });
  await up.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => order(page))
    .toEqual([
      "indices",
      "watchlists",
      "alerts",
      "losers",
      "gainers",
      "portfolio",
      "calendar",
      "screen",
    ]);
  await expect(up).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => order(page))
    .toEqual([
      "indices",
      "watchlists",
      "losers",
      "alerts",
      "gainers",
      "portfolio",
      "calendar",
      "screen",
    ]);
  await expect(up).toBeFocused();
  await expect(page.getByTestId("dashboard-status")).toHaveText("Top losers moved up.");

  await page.getByRole("button", { name: "Make Recent alerts full width" }).click();
  await expect(page.locator("#widget-alerts")).toHaveAttribute("data-size", "full");
  await page.getByRole("button", { name: "Hide Coming up" }).click();
  await expect(page.locator("#widget-calendar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show Coming up" })).toBeFocused();

  // With a mouse: drag Portfolios by its handle onto Top gainers, beside it (a drag needs both
  // on screen; the page does not scroll while dragging).
  const handle = page.getByTestId("drag-portfolio");
  await handle.scrollIntoViewIfNeeded();
  await handle.dragTo(page.locator("#widget-gainers"));
  const arranged = ["indices", "watchlists", "losers", "alerts", "portfolio", "gainers", "screen"];
  await expect.poll(() => order(page)).toEqual(arranged);
  await expect(page.getByTestId("dashboard-status")).toHaveText("Portfolios moved.");

  // Saved: without editing, the same layout and no controls.
  await page.getByRole("link", { name: "Done" }).click();
  await expect(page.getByRole("link", { name: "Customize" })).toBeVisible();
  await expect.poll(() => order(page)).toEqual(arranged);
  await expect(page.locator("#widget-alerts")).toHaveAttribute("data-size", "full");
  await expect(page.getByRole("group", { name: /^Arrange / })).toHaveCount(0);
  await expectAccessible(page);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(arranged);

  // Back to the standard layout.
  await page.getByRole("link", { name: "Customize" }).click();
  await page.getByRole("button", { name: "Show Coming up" }).click();
  await expect(page.locator("#widget-calendar")).toHaveCount(1);
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect.poll(() => order(page)).toEqual(DEFAULT);
});

test("the dashboard switch brings back the standard layout", async ({ page }) => {
  await signIn(page, "/");
  await page.getByRole("link", { name: "Customize" }).click();
  await page.getByRole("button", { name: "Hide Top gainers" }).click();
  await expect(page.locator("#widget-gainers")).toHaveCount(0);

  await page.goto("/settings");
  const row = page.getByTestId("flag-dashboard");
  const reset = row.getByRole("button", { name: "Use default" });
  if (await reset.count()) await reset.click();
  await row.getByRole("button", { name: "Turn off Customizable dashboard" }).click();
  await expect(row).toHaveAttribute("data-enabled", "false");
  try {
    await page.goto("/");
    await expect.poll(() => order(page)).toEqual(DEFAULT);
    await expect(page.getByRole("link", { name: "Customize" })).toHaveCount(0);
    await page.goto("/?edit=1");
    await expect(page.getByRole("group", { name: /^Arrange / })).toHaveCount(0);
  } finally {
    await page.goto("/settings");
    await page.getByTestId("flag-dashboard").getByRole("button", { name: "Use default" }).click();
    await expect(page.getByTestId("flag-dashboard")).toHaveAttribute("data-enabled", "true");
  }
  await page.goto("/?edit=1");
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect.poll(() => order(page)).toEqual(DEFAULT);
});
