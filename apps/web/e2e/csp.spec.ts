import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { PAGE_ROUTES } from "./routes";

/**
 * The Content-Security-Policy (Phase 2 step J3, spec §8, ADR-039): every page comes with a
 * nonce-based policy, Next puts that response's nonce on each of its scripts, and nothing on any
 * page breaks the policy (charts, the indicator worker, live updates, the service worker).
 */
test("every page runs under the CSP, with this response's nonce on the scripts it sends", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await context.addInitScript(() => {
    const w = window as Window & { cspViolations?: string[] };
    w.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.cspViolations!.push(
        `${e.violatedDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`,
      ),
    );
  });
  const reported: string[] = [];
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) reported.push(m.text());
  });

  const check = async (url: string, res: Awaited<ReturnType<typeof page.goto>>) => {
    const csp = res!.headers()["content-security-policy"] ?? "";
    expect(csp, url).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    // Every script tag the server sent carries this response's nonce. (Chunks that Next's own
    // loader adds later need none: 'strict-dynamic' trusts what a trusted script loads.)
    const tags = (await res!.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length, url).toBeGreaterThan(0);
    expect(
      tags.filter((t) => !t.includes(`nonce="${nonce}"`)),
      url,
    ).toEqual([]);
    // Give charts, workers and live updates a moment to start.
    await page.waitForTimeout(300);
    const violations = await page.evaluate(
      () => (window as Window & { cspViolations?: string[] }).cspViolations ?? [],
    );
    expect(violations, url).toEqual([]);
  };

  await check("/login", await page.goto("/login"));
  await signIn(page, "/");
  await expect(page.getByRole("heading", { name: "Markets" })).toBeVisible();
  for (const url of Object.values(PAGE_ROUTES)) await check(url, await page.goto(url));
  // A chart with enough indicators to run them in the Web Worker.
  await check(
    "/stocks/TEST_SPLIT4 with indicators",
    await page.goto("/stocks/TEST_SPLIT4?tf=1Y&ind=sma20,sma50,bb20,rsi14,macd,stoch,adx14"),
  );
  expect(reported).toEqual([]);
});
