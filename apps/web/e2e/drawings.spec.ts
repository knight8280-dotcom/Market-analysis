import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

/**
 * Chart drawings (Phase 2 step F1): drawn with the mouse or added from the keyboard, still there
 * after a reload, kept to the price basis they were drawn on, deleted again.
 */
test.describe.configure({ mode: "serial" });

const chart = (page: Page) => page.getByTestId("price-chart");

async function openList(page: Page) {
  const summary = page.locator("summary", { hasText: /^Drawings \(\d+\)$/ });
  const details = page.locator("details", { has: summary });
  if ((await details.getAttribute("open")) === null) await summary.click();
}

/** Clicks the price pane at fractions of its width and of the top 300 pixels. */
async function clickChart(page: Page, fx: number, fy: number) {
  const box = (await chart(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * fx, box.y + 300 * fy);
}

test("draw with the mouse and the keyboard; drawings stay after a reload", async ({ page }) => {
  await signIn(page, "/stocks/TEST_DIV?adj=1");
  await expect(chart(page)).toHaveAttribute("data-ready", "true");

  // Start clean: earlier runs share this database.
  await openList(page);
  const deletes = page.getByRole("list", { name: "Drawings on this chart" }).getByRole("button");
  while ((await deletes.count()) > 0) {
    const before = await deletes.count();
    await deletes.first().click();
    await expect(deletes).toHaveCount(before - 1);
  }
  await expect(chart(page)).toHaveAttribute("data-drawings", "0");

  const tools = page.getByRole("group", { name: "Drawing tools" });
  const status = page.getByTestId("drawing-status");
  await tools.getByRole("button", { name: "Trend line" }).click();
  await expect(status).toHaveText("Trend line: click the first point on the chart.");
  await clickChart(page, 0.3, 0.3);
  await expect(status).toHaveText("Trend line: click the second point.");
  await clickChart(page, 0.7, 0.6);
  await expect(status).toHaveText("Trend line added.");
  await expect(chart(page)).toHaveAttribute("data-drawings", "1");
  await expect(tools.getByRole("button", { name: "Trend line" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // Escape puts the pen down.
  await tools.getByRole("button", { name: "Rectangle" }).click();
  await page.keyboard.press("Escape");
  await expect(tools.getByRole("button", { name: "Rectangle" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // A text label asks for its words.
  await tools.getByRole("button", { name: "Text" }).click();
  await clickChart(page, 0.5, 0.2);
  await page.getByLabel("Text for the label").fill("Breakout");
  await page.getByRole("button", { name: "Save text" }).click();
  await expect(status).toHaveText("Text added.");

  // From the keyboard: a horizontal line at a typed price.
  const list = page.getByRole("list", { name: "Drawings on this chart" });
  await page.getByLabel("Kind").selectOption("horizontal");
  await page.getByLabel("Price", { exact: true }).fill("25");
  await page.getByLabel("Label (optional)").fill("Support");
  await page.getByRole("button", { name: "Add drawing" }).click();
  await expect(list).toContainText("Horizontal line at 25.00 (“Support”)");
  await expect(list).toContainText(/Trend line from \w{3} \d+, \d{4} at [\d.,]+ to/);
  await expect(list).toContainText(/Text “Breakout” on/);
  await expect(chart(page)).toHaveAttribute("data-drawings", "3");

  // A bad entry is explained, not saved.
  await page.getByLabel("Kind").selectOption("rectangle");
  await page.getByLabel("To price").fill("-3");
  await page.getByRole("button", { name: "Add drawing" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Point 2" })).toContainText(
    "enter a price above zero",
  );
  await expectAccessible(page);

  await page.reload();
  await expect(chart(page)).toHaveAttribute("data-ready", "true");
  await expect(chart(page)).toHaveAttribute("data-drawings", "3");
  await openList(page);
  await expect(list.getByRole("listitem")).toHaveCount(3);

  // Drawings belong to the price basis they were drawn on.
  await page.getByLabel("Adjusted").uncheck();
  await expect(chart(page)).toHaveAttribute("data-drawings", "0");
  await expect(page.getByText("3 drawings were made on the adjusted chart")).toBeVisible();
  await page.getByLabel("Adjusted").check();
  await expect(chart(page)).toHaveAttribute("data-drawings", "3");

  for (let n = 3; n > 0; n -= 1) {
    await list
      .getByRole("button", { name: /^Delete / })
      .first()
      .click();
    await expect(list.getByRole("listitem")).toHaveCount(n - 1);
  }
  await expect(page.getByText("None on this chart.")).toBeVisible();
});

test("the drawings switch hides the tools", async ({ page }) => {
  await signIn(page, "/settings");
  const row = page.getByTestId("flag-drawings");
  const reset = row.getByRole("button", { name: "Use default" });
  if (await reset.count()) await reset.click();
  await row.getByRole("button", { name: "Turn off Chart drawings" }).click();
  await expect(row).toHaveAttribute("data-enabled", "false");
  try {
    await page.goto("/stocks/TEST_DIV");
    await expect(chart(page)).toHaveAttribute("data-ready", "true");
    await expect(page.getByRole("group", { name: "Drawing tools" })).toHaveCount(0);
  } finally {
    await page.goto("/settings");
    await page.getByTestId("flag-drawings").getByRole("button", { name: "Use default" }).click();
    await expect(page.getByTestId("flag-drawings")).toHaveAttribute("data-enabled", "true");
  }
});
