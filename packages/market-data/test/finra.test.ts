import { describe, expect, it } from "vitest";
import { FINRA_PAGE, FinraProvider } from "../src/adapters/finra";
import { ProviderError, ProviderResponseError } from "../src/errors";

/**
 * FINRA short interest (Phase 2 step H3). Field names are FINRA's; every value here is made up,
 * because FINRA's data may not be republished and this repository is public.
 */
const row = (symbol: string, extra: Record<string, unknown> = {}) => ({
  accountingYearMonthNumber: 20260915,
  symbolCode: symbol,
  issueName: `${symbol} Example Corp Common`,
  issuerServicesGroupExchangeCode: "A",
  marketClassCode: "NYSE",
  currentShortPositionQuantity: 1200,
  previousShortPositionQuantity: 1000,
  stockSplitFlag: null,
  averageDailyVolumeQuantity: 400,
  daysToCoverQuantity: 3,
  revisionFlag: null,
  changePercent: 20,
  changePreviousNumber: 200,
  settlementDate: "2026-09-15",
  ...extra,
});

interface Call {
  url: string;
  method: string;
  auth: string;
  body: unknown;
}

/** Answers token requests and queries in order, recording each request. */
function stub(answers: { token?: () => Response; query: (body: unknown, n: number) => Response }) {
  const calls: Call[] = [];
  let queries = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      auth: headers.authorization ?? "",
      body,
    });
    if (url.pathname === "/fip/rest/ews/oauth2/access_token") {
      return await Promise.resolve(
        answers.token?.() ??
          new Response(JSON.stringify({ access_token: `token-${calls.length}`, expires_in: 1800 })),
      );
    }
    queries += 1;
    return answers.query(body, queries);
  };
  return { fetch, calls };
}

let clock = new Date("2026-10-02T21:00:00Z");
const provider = (fetch: ReturnType<typeof stub>["fetch"]) =>
  new FinraProvider({
    clientId: "client-1",
    clientSecret: "secret-1",
    baseUrl: "https://finra.test",
    fetch,
    sleep: () => Promise.resolve(),
    now: () => clock,
  });

describe("FinraProvider", () => {
  it("gets a token, then queries by symbol and settlement date", async () => {
    const s = stub({ query: () => new Response(JSON.stringify([row("TESTA"), row("TESTBB")])) });
    const rows = await provider(s.fetch).getShortInterest({
      symbols: ["TESTBB", "TESTA", "TESTA"],
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(s.calls[0]).toMatchObject({
      url: "https://finra.test/fip/rest/ews/oauth2/access_token?grant_type=client_credentials",
      method: "POST",
      auth: `Basic ${Buffer.from("client-1:secret-1").toString("base64")}`,
    });
    expect(s.calls[1]).toMatchObject({
      url: "https://finra.test/data/group/otcMarket/name/consolidatedShortInterest",
      method: "POST",
      auth: "Bearer token-1",
      body: {
        limit: FINRA_PAGE,
        offset: 0,
        dateRangeFilters: [
          { fieldName: "settlementDate", startDate: "2026-09-01", endDate: "2026-09-30" },
        ],
        domainFilters: [{ fieldName: "symbolCode", values: ["TESTA", "TESTBB"] }],
      },
    });
    expect(rows[0]).toEqual({
      source: "finra",
      source_symbol: "TESTA",
      fetched_at: clock,
      as_of: new Date("2026-09-15T20:00:00Z"),
      license_tier: "personal_dev",
      settlement_date: "2026-09-15",
      issue_name: "TESTA Example Corp Common",
      market_class: "NYSE",
      short_interest: 1200,
      previous_short_interest: 1000,
      avg_daily_volume: 400,
      days_to_cover: 3,
      revised: false,
      split_adjusted: false,
    });
  });

  it("keeps FINRA's flags and leaves days to cover empty when there is no volume", async () => {
    const s = stub({
      query: () =>
        new Response(
          JSON.stringify([
            row("TESTZ", { averageDailyVolumeQuantity: 0, daysToCoverQuantity: 999.99 }),
            row("TESTR", { revisionFlag: "R", stockSplitFlag: "S" }),
          ]),
        ),
    });
    const [z, r] = await provider(s.fetch).getShortInterest({
      symbols: ["TESTZ", "TESTR"],
      from: "2026-09-15",
      to: "2026-09-15",
    });
    expect(z).toMatchObject({ avg_daily_volume: 0, days_to_cover: null });
    expect(r).toMatchObject({ revised: true, split_adjusted: true });
  });

  it("pages through full pages and reuses its token", async () => {
    const page = Array.from({ length: FINRA_PAGE }, (_, i) => row(`T${i}`));
    const s = stub({
      query: (_body, n) => new Response(JSON.stringify(n === 1 ? page : [row("TLAST")])),
    });
    const rows = await provider(s.fetch).getShortInterest({
      symbols: ["TESTA"],
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(rows).toHaveLength(FINRA_PAGE + 1);
    const queries = s.calls.filter((c) => c.url.includes("/data/"));
    expect(queries.map((c) => (c.body as { offset: number }).offset)).toEqual([0, FINRA_PAGE]);
    expect(s.calls.filter((c) => c.url.includes("access_token"))).toHaveLength(1);
  });

  it("asks a hundred symbols at a time, and an empty answer is no records", async () => {
    const symbols = Array.from({ length: 150 }, (_, i) => `S${String(i).padStart(3, "0")}`);
    const s = stub({ query: () => new Response("") });
    expect(
      await provider(s.fetch).getShortInterest({ symbols, from: "2026-09-01", to: "2026-09-30" }),
    ).toEqual([]);
    const sizes = s.calls
      .filter((c) => c.url.includes("/data/"))
      .map(
        (c) =>
          (c.body as { domainFilters: { values: string[] }[] }).domainFilters[0]!.values.length,
      );
    expect(sizes).toEqual([100, 50]);
  });

  it("replaces an expired token once, and renews it after thirty minutes", async () => {
    const s = stub({
      query: (_b, n) => (n === 1 ? new Response("expired", { status: 401 }) : new Response("[]")),
    });
    const p = provider(s.fetch);
    await p.getShortInterest({ symbols: ["TESTA"], from: "2026-09-01", to: "2026-09-30" });
    expect(s.calls.map((c) => c.auth.split(" ")[0])).toEqual([
      "Basic",
      "Bearer",
      "Basic",
      "Bearer",
    ]);
    expect(s.calls[3]!.auth).toBe("Bearer token-3");
    clock = new Date(clock.getTime() + 31 * 60_000);
    await p.getShortInterest({ symbols: ["TESTA"], from: "2026-09-01", to: "2026-09-30" });
    expect(s.calls.filter((c) => c.url.includes("access_token"))).toHaveLength(3);
  });

  it("fails on a refused credential or a changed record shape", async () => {
    const refused = stub({
      token: () => new Response("no", { status: 401 }),
      query: () => new Response("[]"),
    });
    await expect(
      provider(refused.fetch).getShortInterest({
        symbols: ["A"],
        from: "2026-09-01",
        to: "2026-09-30",
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    const changed = stub({
      query: () =>
        new Response(JSON.stringify([row("TESTA", { currentShortPositionQuantity: "1,200" })])),
    });
    await expect(
      provider(changed.fetch).getShortInterest({
        symbols: ["A"],
        from: "2026-09-01",
        to: "2026-09-30",
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });
});
