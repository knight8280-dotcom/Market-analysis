import { describe, expect, it } from "vitest";
import { TiingoProvider } from "../src/adapters/tiingo";
import { ProviderError, ProviderResponseError } from "../src/errors";
import { fixtureFetch } from "./helpers/fixtures";

function provider(routes: Parameters<typeof fixtureFetch>[0]) {
  const f = fixtureFetch(routes);
  const p = new TiingoProvider({
    apiKey: "tiingo-key-for-tests",
    assetClasses: { TEST_TNGO: "equity" },
    baseUrl: "https://tiingo.test",
    fetch: f.fetch,
    sleep: () => Promise.resolve(),
    now: () => new Date("2026-09-30T12:00:00Z"),
  });
  return { p, calls: f.calls };
}
const range = { symbol: "TEST_TNGO", start: "2020-08-27", end: "2020-11-06" };
const pricesRoute = { "/tiingo/daily/TEST_TNGO/prices": "tiingo/prices-TEST_TNGO.json" };

describe("TiingoProvider", () => {
  it("maps raw (unadjusted) bars and authenticates with a header, not the URL", async () => {
    const { p, calls } = provider(pricesRoute);
    const bars = await p.getDailyBars(range);
    expect(bars).toHaveLength(5);
    expect(bars[2]).toMatchObject({
      source: "tiingo",
      source_symbol: "TEST_TNGO",
      license_tier: "personal_dev",
      date: "2020-08-31",
      open: 101,
      close: 102,
      volume: 4800000,
      vwap: null,
    });
    expect(bars[2]!.as_of.toISOString()).toBe("2020-08-31T20:00:00.000Z");
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("startDate")).toBe("2020-08-27");
    expect(url.searchParams.get("endDate")).toBe("2020-11-06");
    expect(url.toString()).not.toContain("tiingo-key-for-tests");
    expect(calls[0]!.headers.authorization).toBe("Token tiingo-key-for-tests");
  });

  it("derives splits and cash dividends from the same rows with one request", async () => {
    const { p, calls } = provider(pricesRoute);
    await p.getDailyBars(range);
    const actions = await p.getCorporateActions(range);
    expect(calls).toHaveLength(1);
    expect(actions.map((a) => [a.type, a.ex_date, a.ratio, a.cash_amount])).toEqual([
      ["split", "2020-08-31", 4, null],
      ["cash_dividend", "2020-11-06", null, 0.25],
    ]);
  });

  it("maps ticker metadata with the configured asset class", async () => {
    const { p } = provider({ "/tiingo/daily/TEST_TNGO": "tiingo/meta-TEST_TNGO.json" });
    const [s] = await p.getSecurities({ symbols: ["TEST_TNGO"] });
    expect(s).toMatchObject({
      ticker: "TEST_TNGO",
      asset_class: "equity",
      exchange_mic: "XNAS",
      listed_at: "1980-12-12",
    });
  });

  it("refuses to guess an asset class", async () => {
    const { p } = provider({});
    await expect(p.getSecurities({ symbols: ["UNKNOWN"] })).rejects.toBeInstanceOf(ProviderError);
  });

  it("rejects a changed response shape", async () => {
    const { p } = provider({
      "/tiingo/daily/TEST_TNGO/prices": {
        status: 200,
        body: JSON.stringify([{ date: "2020-08-27" }]),
      },
    });
    await expect(p.getDailyBars(range)).rejects.toBeInstanceOf(ProviderResponseError);
  });
});
