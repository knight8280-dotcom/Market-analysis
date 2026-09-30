import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";
import { crossingLevel, runAlertsJob, startCaptureServer } from "./worker";

test("create, pause and delete an alert; validation is explained", async ({ page }) => {
  await signIn(page, "/stocks/TEST_DIV");
  await page.getByRole("link", { name: "Alert", exact: true }).click();
  await expect(page).toHaveURL(/\/alerts\?ticker=TEST_DIV/);
  await expect(page.getByLabel("Ticker", { exact: true })).toHaveValue("TEST_DIV");

  await page.getByLabel("Condition").selectOption("pct_move");
  await page.getByLabel("Move (%)").fill("250");
  await page.getByRole("button", { name: "Create alert" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Check the condition" })).toBeVisible();

  await page.getByLabel("Ticker", { exact: true }).fill("TEST_DIV");
  await page.getByLabel("Condition").selectOption("pct_move");
  await page.getByLabel("Move (%)").fill("7.5");
  await page.getByLabel("Direction").selectOption("down");
  await page.getByRole("button", { name: "Create alert" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Alert created." })).toBeVisible();
  const created = new URL(page.url()).searchParams.get("created");
  const row = page.getByTestId(`alert-${created}`);
  await expect(row).toContainText("Moves 7.5% or more in a day (down)");
  await expect(row).toContainText("TEST_DIV");
  await expect(row).toContainText("Active");
  await expectAccessible(page);

  await row.getByRole("button", { name: /^Pause TEST_DIV alert/ }).click();
  await expect(row).toContainText("Paused");
  await row.getByRole("button", { name: /^Resume TEST_DIV alert/ }).click();
  await expect(row).toContainText("Active");
  await row.getByRole("button", { name: /^Delete TEST_DIV alert/ }).click();
  await expect(row).toHaveCount(0);
});

test("an alert fires: the worker evaluates, the capture server gets the email, the page lists it", async ({
  page,
}) => {
  const capture = await startCaptureServer();
  try {
    const { kind, level, money } = await crossingLevel("TEST_SPLIT4");
    await signIn(page, "/alerts");
    await page.getByLabel("Ticker", { exact: true }).fill("TEST_SPLIT4");
    await page.getByLabel("Condition").selectOption(kind);
    await page.getByLabel("Price (USD)").fill(String(level));
    await page.getByRole("button", { name: "Create alert" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Alert created." })).toBeVisible();

    expect(await runAlertsJob(capture.url)).toContain('"fired"');
    const word = kind === "price_above" ? "above" : "below";
    const subject = `[SAMPLE DATA] TEST_SPLIT4 closed ${word} ${money}`;
    const email = capture.emails.find((e) => e.body.subject === subject);
    expect(
      email,
      `captured subjects: ${capture.emails.map((e) => e.body.subject).join(" | ")}`,
    ).toBeTruthy();
    expect(email!.auth).toBe("Bearer re_e2e_capture");
    expect(email!.body.to).toEqual(["owner@e2e.invalid"]);
    expect(email!.body.text).toContain("not investment advice");

    await page.reload();
    const event = page.getByRole("row").filter({ hasText: subject.replace("[SAMPLE DATA] ", "") });
    await expect(event.first()).toContainText("Emailed");
    await expectAccessible(page);
  } finally {
    capture.close();
  }
});
