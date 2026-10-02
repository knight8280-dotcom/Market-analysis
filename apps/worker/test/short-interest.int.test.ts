import { FinraProvider } from "@market/market-data/adapters/finra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJob } from "../src/jobs/index";
import { harness, type Harness } from "./helpers/context";

/**
 * FINRA short interest (Phase 2 step H3) through a stub FINRA host. Field names are FINRA's;
 * every value is made up (FINRA's data may not be republished, and this repository is public).
 */
const NOW = "2026-10-02T23:45:00Z";
let h: Harness;
const bodies: { offset: number; dateRangeFilters: { startDate: string; endDate: string }[] }[] = [];
let answer: Record<string, unknown>[] = [];

const row = (
  symbol: string,
  issueName: string,
  date: string,
  extra: Record<string, unknown> = {},
) => ({
  symbolCode: symbol,
  issueName,
  marketClassCode: "NYSE",
  currentShortPositionQuantity: 5000,
  previousShortPositionQuantity: 4000,
  stockSplitFlag: null,
  averageDailyVolumeQuantity: 2500,
  daysToCoverQuantity: 2,
  revisionFlag: null,
  settlementDate: date,
  ...extra,
});

beforeAll(async () => {
  const finra = new FinraProvider({
    clientId: "client-1",
    clientSecret: "secret-1",
    baseUrl: "https://finra.test",
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/access_token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "t", expires_in: 1800 })),
        );
      }
      bodies.push(
        JSON.parse(typeof init?.body === "string" ? init.body : "{}") as (typeof bodies)[number],
      );
      return Promise.resolve(new Response(JSON.stringify(answer)));
    },
    sleep: () => Promise.resolve(),
    now: () => new Date(NOW),
  });
  h = await harness({ now: NOW, extraProviders: [finra] });
  for (const [ticker, name] of [
    ["TSTA", "Test Alpha Inc."],
    ["BRK-B", "Berkshire Hathaway Inc."],
    ["OLDX", "Old Example Holdings"],
  ]) {
    const { security_id } = await h.t.db
      .insertInto("market.securities")
      .values({ ticker: ticker!, name: name!, asset_class: "equity" })
      .returning("security_id")
      .executeTakeFirstOrThrow();
    await h.t.db
      .insertInto("market.provider_symbols")
      .values({ security_id, source: "tiingo", source_symbol: ticker!, valid_from: "2020-01-01" })
      .execute();
  }
  await h.run("ingest-securities", { source: "synthetic" });
});
afterAll(async () => {
  await h.t.drop();
});

const stored = () =>
  h.t.db
    .selectFrom("market.short_interest as si")
    .innerJoin("market.securities as s", "s.security_id", "si.security_id")
    .select([
      "s.ticker",
      "si.settlement_date",
      "si.symbol",
      "si.short_interest",
      "si.days_to_cover",
      "si.revised",
      "si.source",
    ])
    .orderBy("si.settlement_date")
    .orderBy("s.ticker")
    .execute();

describe("ingest-short-interest", () => {
  it("does nothing until FINRA credentials are set", async () => {
    const providers = new Map(h.ctx.providers);
    providers.delete("finra");
    expect(await runJob({ ...h.ctx, providers }, "ingest-short-interest", {})).toMatchObject({
      configured: false,
    });
  });

  it("stores FINRA's figures for our real listings, matched by ticker and name", async () => {
    answer = [
      row("TSTA", "Test Alpha Inc. Common Stock", "2026-09-15"),
      // FINRA writes class shares without separators.
      row("BRKB", "Berkshire Hathaway Inc. Class", "2026-09-15", {
        averageDailyVolumeQuantity: 0,
        daysToCoverQuantity: 999.99,
      }),
      // The ticker now belongs to another company: reported, not stored.
      row("OLDX", "Newco Biotherapeutics Corp", "2026-09-15"),
    ];
    const result = await h.run("ingest-short-interest");
    expect(result).toEqual({
      configured: true,
      from: "2025-08-28",
      to: "2026-10-02",
      symbols: 3,
      stored: 2,
      settlementDates: ["2026-09-15"],
      rejected: [
        'OLDX: FINRA\'s OLDX is "Newco Biotherapeutics Corp", which does not agree with "Old Example Holdings"',
      ],
    });
    // Synthetic listings are never asked for.
    expect(bodies[0]!.dateRangeFilters[0]).toMatchObject({
      startDate: "2025-08-28",
      endDate: "2026-10-02",
    });
    expect(await stored()).toEqual([
      {
        ticker: "BRK-B",
        settlement_date: "2026-09-15",
        symbol: "BRKB",
        short_interest: "5000",
        days_to_cover: null,
        revised: false,
        source: "finra",
      },
      {
        ticker: "TSTA",
        settlement_date: "2026-09-15",
        symbol: "TSTA",
        short_interest: "5000",
        days_to_cover: "2",
        revised: false,
        source: "finra",
      },
    ]);
    const issues = await h.t.db
      .selectFrom("ops.data_quality_issues")
      .select(["rule", "dataset"])
      .where("rule", "=", "short_interest_name_mismatch")
      .execute();
    expect(issues).toEqual([{ rule: "short_interest_name_mismatch", dataset: "short_interest" }]);
  });

  it("asks again from five weeks before the latest date, so revisions replace earlier figures", async () => {
    answer = [
      row("TSTA", "Test Alpha Inc. Common Stock", "2026-09-15", {
        currentShortPositionQuantity: 5100,
        revisionFlag: "R",
      }),
      row("TSTA", "Test Alpha Inc. Common Stock", "2026-09-30"),
    ];
    const result = await h.run("ingest-short-interest");
    expect(result).toMatchObject({
      from: "2026-08-11",
      stored: 2,
      settlementDates: ["2026-09-15", "2026-09-30"],
    });
    const tsta = (await stored()).filter((r) => r.ticker === "TSTA");
    expect(tsta.map((r) => [r.settlement_date, r.short_interest, r.revised])).toEqual([
      ["2026-09-15", "5100", true],
      ["2026-09-30", "5000", false],
    ]);
    const runs = await h.t.db
      .selectFrom("ops.data_ingestion_runs")
      .select(["status", "dataset", "source"])
      .where("job_name", "=", "ingest-short-interest")
      .execute();
    expect(runs).toEqual([
      { status: "succeeded", dataset: "short_interest", source: "finra" },
      { status: "succeeded", dataset: "short_interest", source: "finra" },
    ]);
  });
});
