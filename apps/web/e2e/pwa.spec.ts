import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, expect, type Page, test } from "@playwright/test";
import { BRAND } from "../src/brand";
import { expectAccessible, signIn } from "./helpers";
import { PAGE_ROUTES, PUBLIC_ASSETS } from "./routes";

/**
 * The installable app (Phase 2 step J1, spec §6, ADR-037): what a browser needs to install it,
 * the offline page, and the bottom navigation on phones.
 */
const LOCAL_CHROMIUM = "/opt/pw-browsers/chromium";

/** Width and height of a PNG, from its header. */
function pngSize(body: Buffer): { width: number; height: number } {
  expect(body.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

async function waitForServiceWorker(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test("the manifest, icons and service worker load without a session", async ({ request }) => {
  for (const path of PUBLIC_ASSETS) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
    expect(res.headers()["x-robots-tag"], path).toBe("noindex, nofollow");
  }
  const res = await request.get("/manifest.webmanifest");
  expect(res.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = (await res.json()) as {
    name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };
  expect(manifest).toMatchObject({ name: BRAND, start_url: "/", display: "standalone" });
  expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual([
    "192x192 any",
    "512x512 any",
    "512x512 maskable",
  ]);
  for (const icon of manifest.icons) {
    const png = await request.get(icon.src);
    expect(png.headers()["content-type"]).toBe("image/png");
    const [w, h] = icon.sizes.split("x").map(Number);
    expect(pngSize(await png.body())).toEqual({ width: w, height: h });
  }
  expect(pngSize(await (await request.get("/apple-icon")).body())).toEqual({
    width: 180,
    height: 180,
  });
  const sw = await request.get("/sw.js");
  expect(sw.headers()["content-type"]).toContain("javascript");
});

test("Chrome finds the app installable", async ({ baseURL }) => {
  // A persistent profile: Chrome does not install apps from a private (incognito) window.
  const dir = mkdtempSync(join(tmpdir(), "pwa-"));
  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    baseURL,
    ...(existsSync(LOCAL_CHROMIUM) ? { executablePath: LOCAL_CHROMIUM } : {}),
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await signIn(page, "/");
    await expect(page.getByRole("heading", { name: "Markets" })).toBeVisible();
    await waitForServiceWorker(page);
    const cdp = await context.newCDPSession(page);
    // Chrome's own installability criteria (Lighthouse no longer checks them).
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    expect(installabilityErrors).toEqual([]);
    const { errors } = await cdp.send("Page.getAppManifest");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offline, the open page says when it loaded and other pages show the offline page", async ({
  page,
}) => {
  await signIn(page, "/watchlists");
  await expect(page.getByRole("heading", { name: "Watchlists", level: 1 })).toBeVisible();
  await waitForServiceWorker(page);
  const status = page.getByRole("status", { name: "Connection" });
  await expect(status).toBeEmpty();
  try {
    await page.context().setOffline(true);
    await expect(status).toContainText(/^You're offline\. This page was loaded .+ ET and won't/);
    await expectAccessible(page);

    const res = await page.goto("/screener");
    expect(res?.status()).toBe(503);
    await expect(page).toHaveTitle(`Offline · ${BRAND}`);
    await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
    await expect(page.getByText(/^A page last loaded on this device at .+ ET\./)).toBeVisible();
    await expect(page.getByText(/Nothing from the app is kept offline\./)).toBeVisible();
    await expectAccessible(page);
    const retry = page.getByRole("link", { name: "Try again" });
    await expect(retry).toHaveAttribute("href", "/screener");

    await page.context().setOffline(false);
    await retry.click();
    await expect(page.getByRole("heading", { name: "Screener", level: 1 })).toBeVisible();
    await expect(status).toBeEmpty();
  } finally {
    await page.context().setOffline(false);
  }
});

test("on a computer the left navigation shows everything and the phone bar is hidden", async ({
  page,
}) => {
  await signIn(page, "/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "More" })).toBeHidden();
});

test.describe("on a phone", () => {
  // Pixel 7's size, touch and user agent; the browser stays the project's Chromium.
  const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 7"];
  test.use(pixel);

  test("no page is wider than the phone", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, "/");
    await expect(page.getByRole("heading", { name: "Markets" })).toBeVisible();
    // A phone widens its layout to fit content that sticks out, and the page then pans
    // sideways: the layout must stay the phone's own width.
    const phone = page.viewportSize()!.width;
    const wide: string[] = [];
    for (const url of Object.values(PAGE_ROUTES)) {
      await page.goto(url);
      const width = await page.evaluate(
        () =>
          new Promise<number>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done(window.innerWidth))),
          ),
      );
      if (width > phone) wide.push(`${url}: ${width}px`);
    }
    expect(wide).toEqual([]);
  });

  test("bottom navigation with the rest under More", async ({ page }) => {
    await signIn(page, "/");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toHaveCount(1);
    await expect(nav.getByRole("link")).toHaveText([
      "Markets",
      "Screener",
      "Watchlists",
      "Portfolio",
    ]);
    await expect(nav.getByRole("link", { name: "Markets" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const box = await nav.boundingBox();
    expect(Math.round(box!.y + box!.height)).toBe(page.viewportSize()!.height);
    await expectAccessible(page);

    await nav.getByRole("link", { name: "Watchlists" }).click();
    await expect(page).toHaveURL(/\/watchlists$/);
    await expect(nav.getByRole("link", { name: "Watchlists" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const more = nav.getByRole("button", { name: "More" });
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const panel = page.locator("#more-nav");
    await expect(panel.getByRole("link")).toHaveText([
      "Backtests",
      "Calendar",
      "Heatmap",
      "Alerts",
      "Data health",
      "Settings",
    ]);
    await expectAccessible(page);
    // Keyboard: Escape closes and puts focus back on More.
    await page.keyboard.press("Escape");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toBeHidden();
    await expect(more).toBeFocused();

    await more.click();
    await panel.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(panel).toBeHidden();
    await more.click();
    await expect(panel.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // A tap elsewhere closes it.
    await page.getByRole("heading", { name: "Settings", level: 1 }).click();
    await expect(panel).toBeHidden();

    // The footer scrolls clear of the bar.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const footer = await page.locator("footer").boundingBox();
    const bar = await nav.boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(bar!.y);
  });
});
