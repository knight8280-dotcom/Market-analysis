import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";
import { crossingLevel, runAlertsJob, startCaptureServer } from "./worker";

/**
 * Phase 2 group E in the browser: the new alert types, then an alert that fires reaching the
 * bell and the notifications page, where it is snoozed, dismissed or deleted (spec §5.14), and
 * the email's link to manage it. The specs share one database, so counts are never assumed.
 */
test.describe.configure({ mode: "serial" });

/** Submits the form and returns the new alert's id (the page's URL names it). */
async function create(page: Page): Promise<string> {
  const before = new URL(page.url()).searchParams.get("created");
  await page.getByRole("button", { name: "Create alert" }).click();
  await page.waitForURL((url) => {
    const created = url.searchParams.get("created");
    return created !== null && created !== before;
  });
  await expect(page.getByRole("status").filter({ hasText: "Alert created." })).toBeVisible();
  return new URL(page.url()).searchParams.get("created")!;
}

test("the new alert types: RSI, moving averages, volume, filings and screens", async ({ page }) => {
  // A saved screen to watch.
  const screen = `E2E watched ${Date.now()}`;
  await signIn(page, "/screener");
  await page.getByRole("link", { name: "Up 5%+ today" }).click();
  await page.getByLabel("Screen name").fill(screen);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/saved=\d+/);

  await page.goto("/alerts?ticker=TEST_DIV");
  await page.getByLabel("Condition").selectOption("rsi_below");
  await expect(page.getByLabel("RSI level", { exact: true })).toHaveValue("30");
  await expect(page.getByLabel("RSI sessions", { exact: true })).toHaveValue("14");
  const rsi = await create(page);
  await expect(page.getByTestId(`alert-${rsi}`)).toContainText("RSI(14) crosses below 30");

  // An impossible pair of averages is explained, not saved.
  await page.getByLabel("Ticker", { exact: true }).fill("TEST_DIV");
  await page.getByLabel("Condition").selectOption("sma_cross");
  await page.getByLabel("Fast average (sessions; 1 = the close)").fill("200");
  await page.getByLabel("Slow average (sessions)").fill("50");
  await page.getByRole("button", { name: "Create alert" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Check the condition." })).toContainText(
    "the fast one fewer than the slow one",
  );
  // The form comes back on the same condition.
  await expect(page.getByLabel("Condition")).toHaveValue("sma_cross");
  await page.getByLabel("Fast average (sessions; 1 = the close)").fill("1");
  await page.getByLabel("Cross direction").selectOption("below");
  const sma = await create(page);
  await expect(page.getByTestId(`alert-${sma}`)).toContainText(
    "Close crosses below its 200-day average",
  );

  await page.getByLabel("Ticker", { exact: true }).fill("TEST_DIV");
  await page.getByLabel("Condition").selectOption("volume_spike");
  await page.getByLabel("Multiple of the average").fill("3");
  const volume = await create(page);
  await expect(page.getByTestId(`alert-${volume}`)).toContainText(
    "Volume at least 3× its 20-day average",
  );

  await page.getByLabel("Ticker", { exact: true }).fill("TEST_FIN");
  await page.getByLabel("Condition").selectOption("new_filing");
  await page.getByLabel("Form 4 insider transaction").check();
  await page.getByLabel("10-K annual report").uncheck();
  await page.getByLabel("Other forms (comma-separated)").fill("6-k");
  await expectAccessible(page);
  const filing = await create(page);
  await expect(page.getByTestId(`alert-${filing}`)).toContainText(
    "New filing: 10-Q, 8-K, Form 4, 6-K (amendments too)",
  );

  await page.getByLabel("Condition").selectOption("screen_membership");
  await expect(page.getByLabel("Ticker", { exact: true })).toHaveCount(0);
  await page.getByLabel("Saved screen").selectOption({ label: screen });
  await page.getByLabel("Tell me when a security").selectOption("enters");
  const watching = await create(page);
  const row = page.getByTestId(`alert-${watching}`);
  await expect(row).toContainText(`Screen: ${screen}`);
  await expect(row).toContainText(`A security enters “${screen}”`);
  await expectAccessible(page);

  // Each alert has its own page.
  await row.getByRole("link", { name: /^Manage .* alert:/ }).click();
  await expect(page).toHaveURL(new RegExp(`/alerts/${watching}$`));
  await expect(page.getByTestId("alert-condition")).toHaveText(`A security enters “${screen}”`);
  await expect(page.getByText("Nothing has fired yet.")).toBeVisible();
  await expectAccessible(page);

  // Clean up, so later runs of the alert job are not affected by these alerts.
  for (const id of [rsi, sma, volume, filing, watching]) {
    await page.goto(`/alerts/${id}`);
    await page.getByRole("button", { name: /^Delete .* alert:/ }).click();
    await expect(page).toHaveURL(/\/alerts$/);
  }
});

test("an alert that fires reaches the bell and the notifications page, which can snooze, dismiss and delete", async ({
  page,
  baseURL,
}) => {
  const capture = await startCaptureServer();
  try {
    const { kind, level, money } = await crossingLevel("TEST_SPLIT4");
    // Start with nothing unread: showing the page marks what is there read.
    await signIn(page, "/notifications");
    await expect(page.getByTestId("notification-bell")).toHaveAccessibleName("Notifications");

    await page.goto("/alerts");
    await page.getByLabel("Ticker", { exact: true }).fill("TEST_SPLIT4");
    await page.getByLabel("Condition").selectOption(kind);
    await page.getByLabel("Price (USD)").fill(String(level));
    await page.getByLabel("Cooldown (hours)").fill("0");
    const crossing = await create(page);
    await page.getByLabel("Ticker", { exact: true }).fill("TEST_SPLIT4");
    await page.getByLabel("Condition").selectOption("pct_move");
    await page.getByLabel("Move (%)").fill("0.01");
    const move = await create(page);

    expect(await runAlertsJob(capture.url, baseURL)).toContain('"fired"');
    const word = kind === "price_above" ? "above" : "below";
    const subject = `TEST_SPLIT4 closed ${word} ${money}`;
    const email = capture.emails.find((e) => e.body.subject === `[SAMPLE DATA] ${subject}`);
    expect(email, capture.emails.map((e) => e.body.subject).join(" | ")).toBeTruthy();
    const manage = `${baseURL}/alerts/${crossing}`;
    expect(email!.body.text).toContain(`Manage this alert (snooze, pause or delete): ${manage}`);
    expect(email!.body.text).toContain(`All notifications: ${baseURL}/notifications`);

    await page.goto("/alerts");
    const bell = page.getByTestId("notification-bell");
    await expect(bell).toHaveAccessibleName(/^Notifications, \d+ unread$/);
    await bell.click();
    await expect(page).toHaveURL(/\/notifications$/);
    // Earlier runs may have left notifications with the same wording; the new ones say so.
    const fresh = (text: string | RegExp) =>
      page
        .getByRole("listitem")
        .filter({ hasText: text })
        .filter({ has: page.getByText("New", { exact: true }) })
        .getAttribute("data-testid");
    const item = page.getByTestId((await fresh(subject))!);
    const moved = page.getByTestId((await fresh(/TEST_SPLIT4 (rose|fell)/))!);
    await expect(item).toContainText("End-of-day data as of");
    await expect(item).toContainText("SAMPLE DATA");
    await expect(item.getByRole("link", { name: subject, exact: true })).toHaveAttribute(
      "href",
      "/stocks/TEST_SPLIT4",
    );
    await expectAccessible(page);
    // Shown, so read: the bell clears without a reload.
    await expect(bell).toHaveAccessibleName("Notifications");

    // Snooze from the notification, then end the snooze.
    await item.getByRole("combobox", { name: /^Snooze length for/ }).selectOption("168");
    await item.getByRole("button", { name: /^Snooze alert of/ }).click();
    await expect(item).toContainText("Snoozed until");
    await item.getByRole("button", { name: /^End the snooze/ }).click();
    await expect(item).not.toContainText("Snoozed until");

    // Dismissing removes the notification only; the alert and its history stay.
    await item.getByRole("button", { name: /^Dismiss/ }).click();
    await expect(item).toHaveCount(0);

    // Deleting from the notification removes the alert, and the notification with it.
    await moved.getByRole("button", { name: /^Delete alert of/ }).click();
    await expect(page).toHaveURL(/\/notifications$/);
    expect((await page.goto(`/alerts/${move}`))?.status()).toBe(404);

    // The email's link opens the alert, with what it fired.
    await page.goto(manage);
    await expect(page.getByTestId("alert-condition")).toHaveText(/^Closes (above|below) \$/);
    await expect(page.getByRole("table", { name: "Events of this alert" })).toContainText(subject);
    await expectAccessible(page);
    await page.getByRole("button", { name: /^Delete TEST_SPLIT4 alert:/ }).click();
    await expect(page).toHaveURL(/\/alerts$/);
    await expect(page.getByTestId(`alert-${crossing}`)).toHaveCount(0);
  } finally {
    capture.close();
  }
});

test("the switches hide notifications and the new alert types", async ({ page }) => {
  await signIn(page, "/settings");
  const toggle = async (key: string, label: string, on: boolean) => {
    const row = page.getByTestId(`flag-${key}`);
    const reset = row.getByRole("button", { name: "Use default" });
    if (await reset.count()) await reset.click();
    if (!on) await row.getByRole("button", { name: `Turn off ${label}` }).click();
    await expect(row).toHaveAttribute("data-enabled", String(on));
  };
  await toggle("notifications", "Notifications", false);
  await toggle("alert_types", "More alert types", false);
  try {
    await page.goto("/alerts");
    await expect(page.getByTestId("notification-bell")).toHaveCount(0);
    await expect(page.getByRole("option", { name: "RSI crosses below a level" })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Closes above a price" })).toHaveCount(1);
    expect((await page.goto("/notifications"))?.status()).toBe(404);
    expect((await page.request.get("/api/notifications/unread")).status()).toBe(404);
  } finally {
    await page.goto("/settings");
    await toggle("notifications", "Notifications", true);
    await toggle("alert_types", "More alert types", true);
  }
  await page.goto("/alerts");
  await expect(page.getByTestId("notification-bell")).toBeVisible();
});
