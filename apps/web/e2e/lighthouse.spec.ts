import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const DEBUG_PORT = 9333;
const LOCAL_CHROMIUM = "/opt/pw-browsers/chromium";

/**
 * Phase 1 acceptance: the ticker page's Largest Contentful Paint under 2.5 s in Lighthouse
 * (its default mobile profile: simulated slow 4G and a 4x slower CPU). Lighthouse drives the
 * same signed-in browser over the DevTools protocol, keeping the session cookie.
 */
test("ticker page LCP under 2.5 s in Lighthouse", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), "lh-"));
  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    args: [`--remote-debugging-port=${DEBUG_PORT}`],
    ...(existsSync(LOCAL_CHROMIUM) ? { executablePath: LOCAL_CHROMIUM } : {}),
  });
  try {
    const page = await context.newPage();
    await signIn(page, "/stocks/TEST_SPLIT4");
    await expect(page.getByRole("heading", { name: "TEST_SPLIT4", level: 1 })).toBeVisible();

    const { default: lighthouse } = await import("lighthouse");
    const result = await lighthouse(`${baseURL}/stocks/TEST_SPLIT4`, {
      port: DEBUG_PORT,
      output: "json",
      logLevel: "error",
      onlyCategories: ["performance"],
      disableStorageReset: true,
    });
    const audits = result?.lhr.audits ?? {};
    const lcp = audits["largest-contentful-paint"]?.numericValue;
    const report = {
      lcpMs: Math.round(lcp ?? Number.NaN),
      fcpMs: Math.round(audits["first-contentful-paint"]?.numericValue ?? Number.NaN),
      tbtMs: Math.round(audits["total-blocking-time"]?.numericValue ?? Number.NaN),
      cls: audits["cumulative-layout-shift"]?.numericValue,
      score: result?.lhr.categories.performance?.score,
      finalUrl: result?.lhr.finalDisplayedUrl,
    };
    test.info().annotations.push({ type: "lighthouse", description: JSON.stringify(report) });
    process.stdout.write(`lighthouse ${JSON.stringify(report)}\n`);
    // Signed in: Lighthouse measured the ticker page, not the login redirect.
    expect(report.finalUrl).toContain("/stocks/TEST_SPLIT4");
    expect(lcp).toBeLessThan(2500);
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
