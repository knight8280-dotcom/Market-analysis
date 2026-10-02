import { describe, expect, it } from "vitest";
import { FinnhubProvider } from "../src/adapters/finnhub";
import { ProviderResponseError } from "../src/errors";
import { fixtureFetch } from "./helpers/fixtures";

function provider(routes: Parameters<typeof fixtureFetch>[0]) {
  const f = fixtureFetch(routes);
  const acquire = () => Promise.resolve(0);
  const p = new FinnhubProvider({
    apiKey: "finnhub-key-for-tests-only",
    baseUrl: "https://finnhub.test",
    rateLimiter: { acquire },
    fetch: f.fetch,
    sleep: () => Promise.resolve(),
    now: () => new Date("2026-09-30T12:00:00Z"),
  });
  return { p, calls: f.calls };
}

describe("FinnhubProvider", () => {
  it("maps the earnings calendar with provenance, keeping the key out of the URL", async () => {
    const { p, calls } = provider({ "/api/v1/calendar/earnings": "finnhub/earnings.json" });
    const events = await p.getEarningsCalendar({ from: "2026-09-01", to: "2026-10-31" });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      source: "finnhub",
      source_symbol: "TEST_DIV",
      license_tier: "personal_dev",
      report_date: "2026-10-20",
      hour: "amc",
      fiscal_year: 2026,
      fiscal_quarter: 3,
      eps_estimate: 1.25,
      eps_actual: null,
    });
    // Unknown or empty fields stay empty.
    expect(events[2]).toMatchObject({ hour: null, fiscal_quarter: null, eps_estimate: null });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("from")).toBe("2026-09-01");
    expect(url.toString()).not.toContain("finnhub-key-for-tests-only");
    expect(calls[0]!.headers["x-finnhub-token"]).toBe("finnhub-key-for-tests-only");
  });

  it("maps company news with provenance and leaves out what it cannot use", async () => {
    const { p, calls } = provider({ "/api/v1/company-news": "finnhub/company-news.json" });
    const { items, skipped } = await p.getNews({
      symbol: "TEST_DIV",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      source: "finnhub",
      source_symbol: "TEST_DIV",
      fetched_at: new Date("2026-09-30T12:00:00Z"),
      as_of: new Date("2026-09-30T08:00:00Z"),
      license_tier: "personal_dev",
      source_id: "9000001",
      url: "https://news.example.invalid/2026/10/01/dividend?utm_source=finnhub",
      headline: "TEST_DIV Example Corp raises its quarterly dividend",
      described: false,
      summary: "Example Corp said its board approved a higher dividend.",
      publisher: "Example Wire",
      category: "company",
      published_at: new Date("2026-09-30T08:00:00Z"),
      symbols: ["TEST_DIV"],
    });
    // An empty summary stays empty; every related symbol is kept.
    expect(items[1]).toMatchObject({ summary: null, symbols: ["TEST_DIV", "TEST_SPLIT4"] });
    expect(skipped.map((s) => s.id)).toEqual(["9000003", "9000004", "9000005"]);
    expect(skipped[0]!.reason).toMatch(/^url:/);
    expect(skipped[2]!.reason).toBe("publication time 0 is not plausible");
    const url = new URL(calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: "TEST_DIV",
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("rejects a payload that does not match the documented shape", async () => {
    const { p } = provider({
      "/api/v1/calendar/earnings": { status: 200, body: JSON.stringify({ earnings: [] }) },
    });
    await expect(p.getEarningsCalendar({ from: "2026-09-01", to: "2026-09-02" })).rejects.toThrow(
      ProviderResponseError,
    );
    const news = provider({
      "/api/v1/company-news": { status: 200, body: JSON.stringify({ articles: [] }) },
    });
    await expect(
      news.p.getNews({ symbol: "TEST_DIV", from: "2026-09-01", to: "2026-09-02" }),
    ).rejects.toThrow(ProviderResponseError);
  });
});
