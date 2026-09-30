import { describe, expect, it, vi } from "vitest";
import { acceptanceTime, padCik, SecEdgarProvider, secUserAgent } from "../src/adapters/sec-edgar";
import { ProviderResponseError } from "../src/errors";
import { fixtureFetch } from "./helpers/fixtures";

const now = new Date("2026-09-30T12:00:00Z");
function provider(routes: Parameters<typeof fixtureFetch>[0]) {
  const f = fixtureFetch(routes);
  const acquire = vi.fn(() => Promise.resolve(0));
  const p = new SecEdgarProvider({
    appName: "Example Analytics",
    contactEmail: "admin@example.com",
    rateLimiter: { acquire },
    baseUrl: "https://sec.test",
    fetch: f.fetch,
    sleep: () => Promise.resolve(),
    now: () => now,
  });
  return { p, calls: f.calls, acquire };
}

describe("SEC EDGAR helpers", () => {
  it("pads CIKs to 10 digits", () => {
    expect(padCik(320193)).toBe("0000320193");
    expect(padCik("CIK0000320193")).toBe("0000320193");
    expect(() => padCik("12345678901")).toThrow();
  });

  it("requires a declared contact in the User-Agent", () => {
    expect(secUserAgent("Example Analytics", "admin@example.com")).toBe(
      "Example Analytics admin@example.com",
    );
    expect(() => secUserAgent("Example", "")).toThrow(/contact email/);
    expect(() => secUserAgent(" ", "admin@example.com")).toThrow();
  });

  it("reads acceptanceDateTime as UTC (verified against the filing index page)", () => {
    // Index page: "Accepted 2025-10-31 06:01:26" (EDT) == 10:01:26 UTC.
    expect(acceptanceTime("2025-10-31T10:01:26.000Z", "2025-10-31").toISOString()).toBe(
      "2025-10-31T10:01:26.000Z",
    );
    // Missing or malformed: midnight Eastern on the filing date.
    expect(acceptanceTime("", "2025-02-14").toISOString()).toBe("2025-02-14T05:00:00.000Z");
    expect(acceptanceTime("2025-02-14 10:00", "2025-02-14").toISOString()).toBe(
      "2025-02-14T05:00:00.000Z",
    );
  });
});

describe("SecEdgarProvider", () => {
  it("sends the declared User-Agent and takes a rate-limit slot per request", async () => {
    const { p, calls, acquire } = provider({
      "/files/company_tickers_exchange.json": "sec-edgar/company_tickers_exchange.json",
    });
    await p.getTickerMap();
    expect(calls[0]!.headers["user-agent"]).toBe("Example Analytics admin@example.com");
    expect(calls[0]!.headers["accept-encoding"]).toBe("gzip, deflate");
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("maps the ticker file, keeping share classes and unknown exchanges", async () => {
    const { p } = provider({
      "/files/company_tickers_exchange.json": "sec-edgar/company_tickers_exchange.json",
    });
    const map = await p.getTickerMap();
    expect(map).toHaveLength(4);
    expect(map[0]).toEqual({
      cik: "0000000042",
      name: "Test Registrant Inc.",
      ticker: "TEST_EDGR",
      exchange: "Nasdaq",
    });
    expect(map.filter((e) => e.cik === "0000000043").map((e) => e.ticker)).toEqual([
      "TEST_HLDA",
      "TEST_HLDB",
    ]);
    expect(map[3]!.exchange).toBeNull();
  });

  it("maps recent filings with acceptance time, items and document URLs", async () => {
    const { p, calls } = provider({
      "/submissions/CIK0000000042.json": "sec-edgar/submissions-CIK0000000042.json",
    });
    const filings = await p.getFilings({ cik: "42" });
    expect(calls[0]!.url).toBe("https://sec.test/submissions/CIK0000000042.json");
    expect(filings).toHaveLength(4);
    const [q, eightK, , form4] = filings;
    expect(q).toMatchObject({
      source: "sec_edgar",
      license_tier: "public_domain",
      cik: "0000000042",
      accession_no: "0000000042-25-000010",
      form_type: "10-Q",
      filing_date: "2025-08-01",
      period: "2025-06-28",
      items: [],
      url: "https://sec.test/Archives/edgar/data/42/000000004225000010/test-20250628.htm",
    });
    expect(q!.filed_at.toISOString()).toBe("2025-08-01T10:01:36.000Z");
    expect(q!.as_of).toEqual(q!.filed_at);
    expect(eightK!.items).toEqual(["2.02", "9.01"]);
    expect(form4).toMatchObject({ period: null, primary_document: null });
    expect(form4!.url).toBe(
      "https://sec.test/Archives/edgar/data/42/000000004225000007/0000000042-25-000007-index.htm",
    );
  });

  it("maps every companyfacts fact with its filing provenance", async () => {
    const { p } = provider({
      "/api/xbrl/companyfacts/CIK0000000042.json": "sec-edgar/companyfacts-CIK0000000042.json",
    });
    const facts = await p.getFundamentals({ cik: "0000000042" });
    expect(facts).toHaveLength(6);
    const shares = facts.find((f) => f.concept === "EntityCommonStockSharesOutstanding")!;
    expect(shares).toMatchObject({
      taxonomy: "dei",
      unit: "shares",
      period_start: null,
      value: 250000000,
      frame: "CY2025Q2I",
    });
    // The same revenue figure reported again in a later filing is kept as a separate fact.
    const revenue = facts.filter((f) => f.concept === "Revenues" && f.period_end === "2024-06-29");
    expect(revenue.map((f) => f.accession_no)).toEqual([
      "0000000042-24-000080",
      "0000000042-25-000010",
    ]);
    expect(revenue[1]!.frame).toBeNull();
    const eps = facts.find((f) => f.concept === "EarningsPerShareBasic")!;
    expect(eps).toMatchObject({
      unit: "USD/shares",
      value: 0.5,
      fiscal_year: 2025,
      fiscal_period: "Q3",
    });
    const assets = facts.find((f) => f.concept === "Assets")!;
    expect(assets).toMatchObject({
      fiscal_year: null,
      fiscal_period: null,
      filed_at: "2025-08-01",
    });
    expect(assets.as_of.toISOString()).toBe("2025-08-01T04:00:00.000Z");
  });

  it("rejects a changed response shape instead of guessing", async () => {
    const { p } = provider({
      "/submissions/CIK0000000042.json": {
        status: 200,
        body: JSON.stringify({ cik: "42", name: "x", filings: {} }),
      },
    });
    await expect(p.getFilings({ cik: "42" })).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("backs off and retries when SEC answers 403", async () => {
    let n = 0;
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      n += 1;
      if (n === 1) return Promise.resolve(new Response("", { status: 403 }));
      return fixtureFetch({
        "/submissions/CIK0000000042.json": "sec-edgar/submissions-CIK0000000042.json",
      }).fetch(input, init);
    }) as typeof fetch;
    const p = new SecEdgarProvider({
      appName: "Example Analytics",
      contactEmail: "admin@example.com",
      rateLimiter: { acquire: () => Promise.resolve(0) },
      baseUrl: "https://sec.test",
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    });
    await expect(p.getFilings({ cik: "42" })).resolves.toHaveLength(4);
    expect(p.http.statusCounts.get(403)).toBe(1);
  });

  it("does not support price datasets", async () => {
    const { p } = provider({});
    await expect(
      p.getDailyBars({ symbol: "X", start: "2024-01-02", end: "2024-01-03" }),
    ).rejects.toThrow(/does not support/);
  });
});

describe("SecEdgarProvider against recorded live responses (Apple, 2026-09-30)", () => {
  const recorded = {
    "/submissions/CIK0000320193.json": "sec-edgar/recorded/submissions-CIK0000320193.trimmed.json",
    "/api/xbrl/companyfacts/CIK0000320193.json":
      "sec-edgar/recorded/companyfacts-CIK0000320193.trimmed.json",
  };

  it("parses real submissions, with acceptance times in UTC", async () => {
    const { p } = provider(recorded);
    const filings = await p.getFilings({ cik: "320193" });
    expect(filings).toHaveLength(6);
    const tenK = filings.find((f) => f.accession_no === "0000320193-25-000079")!;
    // The filing index page says "Accepted 2025-10-31 06:01:26" (Eastern).
    expect(tenK).toMatchObject({ form_type: "10-K", filing_date: "2025-10-31", cik: "0000320193" });
    expect(tenK.filed_at.toISOString()).toBe("2025-10-31T10:01:26.000Z");
    expect(tenK.url).toMatch(
      /^https:\/\/sec\.test\/Archives\/edgar\/data\/320193\/000032019325000079\/.+\.htm$/,
    );
  });

  it("parses real companyfacts", async () => {
    const { p } = provider(recorded);
    const facts = await p.getFundamentals({ cik: "320193" });
    expect(facts).toHaveLength(12);
    expect(new Set(facts.map((f) => f.unit))).toEqual(new Set(["shares", "USD", "USD/shares"]));
    for (const f of facts) {
      expect(f.cik).toBe("0000320193");
      expect(f.accession_no).toMatch(/^\d{10}-\d{2}-\d{6}$/);
    }
  });
});

describe("SecEdgarProvider against recorded edge cases (2026-09-30)", () => {
  it("accepts a companyfacts CIK sent as a string (ExxonMobil Holdings Corp)", async () => {
    const { p } = provider({
      "/api/xbrl/companyfacts/CIK0002115436.json":
        "sec-edgar/recorded/companyfacts-CIK0002115436.trimmed.json",
    });
    const facts = await p.getFundamentals({ cik: "2115436" });
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.cik === "0002115436")).toBe(true);
  });

  it("stores fy 0 / fp '' as no fiscal period (Wells Fargo 8-K exhibit facts)", async () => {
    const { p } = provider({
      "/api/xbrl/companyfacts/CIK0000072971.json":
        "sec-edgar/recorded/companyfacts-CIK0000072971.trimmed.json",
    });
    const facts = await p.getFundamentals({ cik: "72971" });
    const exhibit = facts.find((f) => f.taxonomy !== "us-gaap")!;
    expect(exhibit).toMatchObject({ fiscal_year: null, fiscal_period: null });
    const assets = facts.find((f) => f.concept === "Assets")!;
    expect(assets.fiscal_year).toBeGreaterThan(2000);
  });

  it("rejects a companyfacts file that names a different CIK", async () => {
    const { p } = provider({
      "/api/xbrl/companyfacts/CIK0000000043.json": "sec-edgar/companyfacts-CIK0000000042.json",
    });
    await expect(p.getFundamentals({ cik: "43" })).rejects.toThrow(/names CIK 42/);
  });
});

describe("getSubmissions", () => {
  it("returns registrant metadata with the filings (Apple, recorded)", async () => {
    const f = fixtureFetch({
      "/submissions/CIK0000320193.json":
        "sec-edgar/recorded/submissions-CIK0000320193.trimmed.json",
    });
    const p = new SecEdgarProvider({
      appName: "Market Analysis",
      contactEmail: "admin@example.com",
      rateLimiter: { acquire: () => Promise.resolve(0) },
      baseUrl: "https://sec.test",
      fetch: f.fetch,
    });
    const { entity, filings } = await p.getSubmissions({ cik: "320193" });
    expect(entity).toMatchObject({
      cik: "0000320193",
      name: "Apple Inc.",
      sicCode: "3571",
      tickers: ["AAPL"],
    });
    expect(entity.sicDescription).toMatch(/computers/i);
    expect(filings).toHaveLength(6);
  });
});
