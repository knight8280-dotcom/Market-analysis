import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

/**
 * Valuation tab (Phase 2 steps D2 and D3) on the seeded TEST_FIN and its peer TEST_PEER:
 * inputs from the filings with their sources, outputs within 100 ms of an edit, the
 * sensitivity grid, saved scenarios, peers and the five-year history.
 */
test.describe.configure({ mode: "serial" });

test("the calculator starts from the filings, recomputes at once and saves scenarios", async ({
  page,
}) => {
  await signIn(page, "/stocks/TEST_FIN/valuation");
  await expect(page.getByRole("link", { name: "Valuation" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page
      .getByRole("note")
      .filter({ hasText: "This model is a calculator driven by your assumptions." }),
  ).toContainText("It is not a price target or recommendation.");
  await expect(
    page.getByText("Model output depends entirely on your inputs. It is not a price target."),
  ).toBeVisible();

  // FY2025 revenue of $1,200M from the seeded 10-K, with where it came from.
  const revenue = page.getByTestId("dcf-input-revenue0");
  await expect(revenue).toHaveValue("1200");
  await expect(
    page.getByText(/From filings: fiscal year to Dec 31, 2025, filed Feb 10, 2026/).first(),
  ).toBeVisible();
  await expect(page.getByTestId("dcf-input-ebitMargin")).toHaveValue("15");
  const perShare = page.getByTestId("dcf-per-share");
  await expect(perShare).toContainText("$");
  await expectAccessible(page);

  // Spec §5.6: changing any input updates the outputs within 100 ms (measured in the page).
  const ms = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="dcf-input-wacc"]')!;
    const out = document.querySelector('[data-testid="dcf-per-share"]')!;
    const before = out.textContent;
    // React tracks the value it last set; going through the native setter makes this a real edit.
    const valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    return new Promise<number>((resolve) => {
      const t0 = performance.now();
      const watch = new MutationObserver(() => {
        if (out.textContent !== before) {
          watch.disconnect();
          resolve(performance.now() - t0);
        }
      });
      watch.observe(out, { childList: true, characterData: true, subtree: true });
      valueProperty.set!.call(input, "10");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  test.info().annotations.push({ type: "recompute-ms", description: ms.toFixed(1) });
  expect(ms).toBeLessThan(100);

  const grid = page.getByRole("table", {
    name: "Value per share by discount rate and terminal growth",
  });
  await expect(grid.getByRole("row")).toHaveCount(6);
  await expect(grid.getByText("(your inputs)")).toHaveCount(1);

  // An impossible terminal growth is explained, not computed.
  await page.getByTestId("dcf-input-terminalGrowth").fill("12");
  await expect(page.getByRole("alert").filter({ hasText: "The model needs" })).toContainText(
    "Terminal growth",
  );
  await page.getByTestId("dcf-input-terminalGrowth").fill("2.5");
  await page.getByRole("radio", { name: "Exit multiple" }).check();
  await expect(page.getByText("Implied perpetual growth")).toBeVisible();
  await page.getByRole("radio", { name: "Perpetual growth" }).check();

  // Save, change, load back, delete.
  await page.getByLabel("Scenario name").fill("E2E base");
  await page.getByRole("button", { name: "Save these inputs" }).click();
  const saved = page.getByRole("list", { name: "Saved scenarios list" });
  await expect(saved).toContainText("E2E base");
  await page.getByTestId("dcf-input-wacc").fill("7");
  await page.getByRole("button", { name: "Load scenario E2E base" }).click();
  await expect(page.getByTestId("dcf-input-wacc")).toHaveValue("10");
  await page.getByRole("button", { name: "Delete scenario E2E base" }).click();
  await expect(page.getByText("No saved scenarios for this security yet.")).toBeVisible();
});

test("peers share the industry code, can be listed by hand, and history is charted", async ({
  page,
}) => {
  await signIn(page, "/stocks/TEST_FIN/valuation");
  const table = page.getByRole("table", { name: "Multiples of this company and its peers" });
  await expect(page.getByText(/Same SEC industry code \(SIC 7372\)/)).toBeVisible();
  await expect(table.getByTestId("peer-TEST_FIN")).toContainText(/\d+\.\d×/);
  await expect(table.getByTestId("peer-TEST_PEER")).toContainText(/\d+\.\d×/);
  await expect(table.getByTestId("median-pe")).toContainText(/\d+\.\d×/);
  for (const name of [/^P\/E at month ends/, /^P\/S at month ends/, /^EV\/EBITDA at month ends/]) {
    await expect(page.getByRole("img", { name })).toBeVisible();
  }

  // A hand-picked peer without filings shows its price and nothing made up.
  await page.getByLabel("Peer tickers (comma-separated)").fill("TEST_DIV");
  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page).toHaveURL(/peers=TEST_DIV/);
  await expect(page.getByText("Your list")).toBeVisible();
  const div = table.getByTestId("peer-TEST_DIV");
  await expect(div).toContainText("$");
  // No filed share count, so no market cap either: four cells unavailable, none estimated.
  await expect(div.getByRole("cell", { name: "—" })).toHaveCount(4);
  await expectAccessible(page);
  await page.getByRole("link", { name: "Use the industry" }).click();
  await expect(table.getByTestId("peer-TEST_PEER")).toBeVisible();
});

test("the valuation switch hides the tab and its page", async ({ page }) => {
  await signIn(page, "/settings");
  const row = page.getByTestId("flag-valuation");
  const reset = row.getByRole("button", { name: "Use default" });
  if (await reset.count()) await reset.click();
  await row.getByRole("button", { name: "Turn off Valuation" }).click();
  await expect(row).toHaveAttribute("data-enabled", "false");
  try {
    const res = await page.goto("/stocks/TEST_FIN/valuation");
    expect(res?.status()).toBe(404);
    await page.goto("/stocks/TEST_FIN");
    await expect(page.getByRole("link", { name: "Valuation" })).toHaveCount(0);
  } finally {
    await page.goto("/settings");
    await page.getByTestId("flag-valuation").getByRole("button", { name: "Use default" }).click();
    await expect(page.getByTestId("flag-valuation")).toHaveAttribute("data-enabled", "true");
  }
});
