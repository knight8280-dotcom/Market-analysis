import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

test("settings: a feature can be switched and returned to its default", async ({ page }) => {
  await signIn(page, "/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  const row = page.getByTestId("flag-backtests");
  await expect(row).toContainText("Backtests");
  await expectAccessible(page);

  // Start from the default, whatever it is at this point in the project.
  const reset = row.getByRole("button", { name: "Use default" });
  if (await reset.count()) await reset.click();
  await expect(row).toContainText("Default");
  const initiallyOn = (await row.getAttribute("data-enabled")) === "true";

  await row.getByRole("button", { name: /^Turn (on|off) Backtests$/ }).click();
  await expect(row).toHaveAttribute("data-enabled", String(!initiallyOn));
  await expect(row).toContainText(/Changed .*; default (on|off)/);
  await page.reload();
  await expect(row).toHaveAttribute("data-enabled", String(!initiallyOn));

  await row.getByRole("button", { name: "Use default" }).click();
  await expect(row).toContainText("Default");
  await expect(row.getByRole("button", { name: "Use default" })).toHaveCount(0);
});
