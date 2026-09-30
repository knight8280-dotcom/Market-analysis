import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";
import { API_ROUTES, PAGE_ROUTES } from "./routes";

test("pages and APIs require the owner's session", async ({ page, request }) => {
  for (const url of Object.values(PAGE_ROUTES)) {
    const res = await request.get(url, { maxRedirects: 0 });
    expect(res.status(), url).toBe(307);
    expect(res.headers().location, url).toMatch(/^\/login(\?next=|$)/);
  }
  for (const url of Object.values(API_ROUTES)) {
    const res = await request.get(url, { maxRedirects: 0 });
    expect(res.status(), url).toBe(401);
    expect(await res.json(), url).toEqual({ error: "Sign in required" });
  }
  // Server actions are POSTs to page URLs: refused the same way, before any action runs.
  const action = await request.post("/portfolio", {
    headers: { "Next-Action": "0".repeat(40) },
    maxRedirects: 0,
  });
  expect(action.status()).toBe(307);

  await page.goto("/admin/data-health");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fdata-health/);
  await expectAccessible(page);
});

test("a wrong password is refused without saying why", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#login-error")).toHaveText("That password is not right.");
  await expect(page).toHaveURL(/\/login/);
});

test("owner signs in, finds a ticker with the palette and sees labelled prices", async ({
  page,
}) => {
  await signIn(page, "/admin/data-health");
  await expect(page).toHaveURL(/\/admin\/data-health$/);
  await expect(page.getByRole("heading", { name: "Data health" })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Markets" })).toBeVisible();
  await expect(page.getByRole("note", { name: "Sample data notice" })).toBeVisible();
  await expect(page.getByText(/End-of-day, as of .* · Source: /).first()).toBeVisible();
  await expectAccessible(page);

  // "/" opens the command palette; type, arrow down, Enter.
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  await page.keyboard.type("TEST_DIV");
  await expect(dialog.getByRole("option").first()).toContainText("TEST_DIV");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/stocks\/TEST_DIV(\?|$)/);
  await expect(page.getByRole("heading", { name: "TEST_DIV" })).toBeVisible();
  await expect(page.getByText(/End-of-day, as of .* · Source: Synthetic/).first()).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});

test("an unknown ticker shows a helpful not-found page", async ({ page }) => {
  await signIn(page, "/stocks/NOPE_NOT_A_TICKER");
  await expect(page.getByText("No security with that ticker")).toBeVisible();
});
