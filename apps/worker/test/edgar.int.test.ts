import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BaseProvider, type ProviderId, type SecurityRecord } from "@market/market-data";
import { SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRequest } from "../src/context";
import { harness, type Harness } from "./helpers/context";

/**
 * Plan step A5 against recorded SEC responses: Apple's trimmed live recordings plus the
 * synthetic CIK 42 registrant, both kept in the market-data package's fixtures.
 */
const FIXTURES = "../../../packages/market-data/test/fixtures/sec-edgar/";
const fixture = (path: string) =>
  readFileSync(fileURLToPath(new URL(FIXTURES + path, import.meta.url)), "utf8");

const TICKER_MAP = JSON.stringify({
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [320193, "Apple Inc.", "AAPL", "Nasdaq"],
    [42, "Test Registrant Inc.", "TEST-A", "Nasdaq"],
    [884394, "SPDR S&P 500 ETF TRUST", "SPY", "NYSE"],
    // A synthetic ticker that SEC happened to list must still never get a real id.
    [43, "Test Holdings Corp", "TEST_SPLIT4", null],
  ],
});

const ROUTES: Record<string, () => string> = {
  "/files/company_tickers_exchange.json": () => TICKER_MAP,
  "/submissions/CIK0000320193.json": () =>
    fixture("recorded/submissions-CIK0000320193.trimmed.json"),
  "/api/xbrl/companyfacts/CIK0000320193.json": () =>
    fixture("recorded/companyfacts-CIK0000320193.trimmed.json"),
  "/submissions/CIK0000000042.json": () => fixture("submissions-CIK0000000042.json"),
  "/api/xbrl/companyfacts/CIK0000000042.json": () => fixture("companyfacts-CIK0000000042.json"),
};

function secProvider(now: () => Date) {
  const requests: string[] = [];
  const fetchImpl = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url.pathname);
    const body = ROUTES[url.pathname];
    return Promise.resolve(
      body ? new Response(body(), { status: 200 }) : new Response("not found", { status: 404 }),
    );
  };
  const provider = new SecEdgarProvider({
    appName: "Example Analytics",
    contactEmail: "admin@example.com",
    rateLimiter: { acquire: () => Promise.resolve(0) },
    baseUrl: "https://sec.test",
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    now,
  });
  return { provider, requests };
}

const NOW = new Date("2026-09-30T12:00:00Z");

/** A price vendor that reports no CIK, sector or industry, as Tiingo does. */
class StubVendor extends BaseProvider {
  readonly id: ProviderId = "tiingo";
  override healthCheck() {
    return Promise.resolve();
  }
  override getSecurities() {
    const record = (ticker: string, assetClass: "equity" | "etf"): SecurityRecord => ({
      source: "tiingo",
      source_symbol: ticker,
      fetched_at: NOW,
      as_of: NOW,
      license_tier: "personal_dev",
      source_security_id: null,
      ticker,
      name: `${ticker} Test Listing`,
      asset_class: assetClass,
      exchange_mic: null,
      cik: null,
      figi: null,
      sector: null,
      industry: null,
      currency: "USD",
      listed_at: null,
      delisted_at: null,
      symbol_history: [],
    });
    return Promise.resolve([
      record("AAPL", "equity"),
      record("TEST.A", "equity"),
      record("NOTSEC", "equity"),
      record("SPY", "etf"),
    ]);
  }
}

let h: Harness;
let sec: ReturnType<typeof secProvider>;

async function security(ticker: string, source: ProviderId = "tiingo") {
  return h.t.db
    .selectFrom("market.securities as s")
    .innerJoin("market.provider_symbols as ps", "ps.security_id", "s.security_id")
    .select(["s.cik", "s.sic_code", "s.sector", "s.industry"])
    .where("ps.source", "=", source)
    .where("s.ticker", "=", ticker)
    .executeTakeFirstOrThrow();
}

beforeAll(async () => {
  sec = secProvider(() => NOW);
  h = await harness({
    universeSize: 20,
    now: NOW.toISOString(),
    primary: "tiingo",
    extraProviders: [new StubVendor(), sec.provider],
  });
  await h.run("ingest-securities", { source: "synthetic" });
  await h.run("ingest-securities", { source: "tiingo" });
});
afterAll(async () => {
  await h.t.drop();
});

describe("attach-edgar-ids", () => {
  it("attaches CIKs to vendor equities by ticker and reports the ones SEC does not list", async () => {
    const spy = vi.spyOn(h.dispatcher, "dispatch");
    try {
      const result = await h.run("attach-edgar-ids");
      expect(result).toEqual({
        date: "2026-09-30",
        candidates: 3,
        attached: 2,
        unmatched: ["NOTSEC"],
      });
      expect(spy.mock.calls.map(([job]) => job.jobId).sort()).toEqual([
        "ingest-filings/2026-09-30/0000000042",
        "ingest-filings/2026-09-30/0000320193",
      ]);
    } finally {
      spy.mockRestore();
    }
    expect((await security("AAPL")).cik).toBe("0000320193");
    // "TEST.A" at the vendor is "TEST-A" at SEC.
    expect((await security("TEST.A")).cik).toBe("0000000042");
    expect((await security("NOTSEC")).cik).toBeNull();
    // ETFs are not registrants with XBRL financials.
    expect((await security("SPY")).cik).toBeNull();
  });

  it("never gives a synthetic security a real identifier", async () => {
    const synthetic = await h.t.db
      .selectFrom("market.securities as s")
      .innerJoin("market.provider_symbols as ps", "ps.security_id", "s.security_id")
      .select(["s.ticker", "s.cik"])
      .where("ps.source", "=", "synthetic")
      .execute();
    expect(synthetic.map((s) => s.ticker)).toContain("TEST_SPLIT4");
    expect(synthetic.filter((s) => s.cik !== null)).toEqual([]);
  });

  it("sets SIC code, industry and sector from submissions, then loads filings and facts", async () => {
    // Runs the two queued filings jobs and the companyfacts jobs they queue.
    expect(await h.drain()).toEqual({ ran: 4, failed: 0 });

    expect(await security("AAPL")).toEqual({
      cik: "0000320193",
      sic_code: "3571",
      sector: "Technology",
      industry: "Electronic Computers",
    });
    // The CIK 42 fixture has a SIC code but no description.
    expect(await security("TEST.A")).toMatchObject({ sic_code: "3571", industry: null });

    const runs = await h.t.db
      .selectFrom("ops.data_ingestion_runs")
      .select(["dataset", "status"])
      .where("dataset", "in", ["filings", "fundamentals"])
      .execute();
    expect(runs.filter((r) => r.status !== "succeeded")).toEqual([]);
    expect(runs.filter((r) => r.dataset === "filings")).toHaveLength(2);
    expect(runs.filter((r) => r.dataset === "fundamentals")).toHaveLength(2);
    const facts = await h.t.db
      .selectFrom("market.fundamentals_facts")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("cik", "=", "0000320193")
      .executeTakeFirstOrThrow();
    expect(Number(facts.n)).toBeGreaterThan(0);
  });

  it("keeps EDGAR enrichment when the price vendor re-reports the security without it", async () => {
    await h.run("ingest-securities", { source: "tiingo" });
    expect(await security("AAPL")).toEqual({
      cik: "0000320193",
      sic_code: "3571",
      sector: "Technology",
      industry: "Electronic Computers",
    });
  });

  it("is idempotent: a second filings run changes nothing", async () => {
    const result = (await h.run("ingest-filings", { cik: "320193" })) as Record<string, number>;
    expect(result.rows_inserted).toBe(0);
    expect(result.rows_unchanged).toBe(result.rows_fetched);
  });

  it("queues the attach job from the daily sweep only while equities lack a CIK", async () => {
    const dispatched: JobRequest[] = [];
    const spy = vi.spyOn(h.dispatcher, "dispatch").mockImplementation((job) => {
      dispatched.push(job);
      return Promise.resolve();
    });
    try {
      await h.run("schedule-edgar");
      expect(dispatched.map((j) => j.jobId)).toContain("attach-edgar-ids/2026-09-30");

      await h.t.db
        .updateTable("market.securities")
        .set({ is_active: false })
        .where("ticker", "=", "NOTSEC")
        .execute();
      dispatched.length = 0;
      await h.run("schedule-edgar");
      expect(dispatched.map((j) => j.name)).not.toContain("attach-edgar-ids");
      expect(dispatched.map((j) => j.jobId).sort()).toEqual([
        "ingest-filings/2026-09-30/0000000042",
        "ingest-filings/2026-09-30/0000320193",
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
