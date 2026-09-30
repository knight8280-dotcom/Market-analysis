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

  it("rejects a payload that does not match the documented shape", async () => {
    const { p } = provider({
      "/api/v1/calendar/earnings": { status: 200, body: JSON.stringify({ earnings: [] }) },
    });
    await expect(p.getEarningsCalendar({ from: "2026-09-01", to: "2026-09-02" })).rejects.toThrow(
      ProviderResponseError,
    );
  });
});
