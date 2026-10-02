import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FinnhubProvider } from "@market/market-data/adapters/finnhub";
import { SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRequest } from "../src/context";
import { runJob } from "../src/jobs/index";
import { harness, type Harness } from "./helpers/context";

/**
 * News (Phase 2 step I1): 8-K press releases recorded from EDGAR (public filings) served by a
 * stub SEC host, and Finnhub company news from a stub with made-up articles in Finnhub's field
 * layout (vendor data is never committed).
 */
const PRESS = "../../../packages/market-data/test/fixtures/sec-edgar/recorded/press/";
const recorded = (name: string) =>
  readFileSync(fileURLToPath(new URL(`${PRESS}${name}`, import.meta.url)), "utf8");

const NOW = "2026-10-02T12:00:00Z";
const NVDA_8K = "0001045810-26-000073";
const NVDA_8K_NO_EXHIBIT = "0001045810-26-000078";
const MSFT_8K = "0001193125-26-380280";
let h: Harness;
const secRequests: string[] = [];
const finnhubRequests: URL[] = [];
let articles: Record<string, Record<string, unknown>[]> = {};

const SEC_ROUTES: Record<string, () => string> = {
  [`/Archives/edgar/data/1045810/000104581026000073/${NVDA_8K}-index.htm`]: () =>
    recorded(`${NVDA_8K}-index.htm`),
  "/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm": () => recorded(`${NVDA_8K}.htm`),
  [`/Archives/edgar/data/1045810/000104581026000078/${NVDA_8K_NO_EXHIBIT}-index.htm`]: () =>
    recorded(`${NVDA_8K_NO_EXHIBIT}-index.htm`),
  [`/Archives/edgar/data/789019/000119312526380280/${MSFT_8K}-index.htm`]: () =>
    '<table><tr><td>1</td><td>EX-99.1</td><td><a href="/x/d291965dex991.htm">d291965dex991.htm</a></td><td>EX-99.1</td><td>1</td></tr></table>',
  "/Archives/edgar/data/789019/000119312526380280/d291965dex991.htm": () =>
    recorded(`${MSFT_8K}.htm`),
};

const article = (id: number, at: string, headline: string, url: string, related: string) => ({
  category: "company",
  datetime: Date.parse(at) / 1000,
  headline,
  id,
  image: "",
  related,
  source: "Example Wire",
  summary: `Made-up summary ${id}.`,
  url,
});

beforeAll(async () => {
  const sec = new SecEdgarProvider({
    appName: "Example Analytics",
    contactEmail: "admin@example.com",
    rateLimiter: { acquire: () => Promise.resolve(0) },
    baseUrl: "https://sec.test",
    fetch: (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      secRequests.push(url.pathname);
      const body = SEC_ROUTES[url.pathname];
      return Promise.resolve(
        body ? new Response(body(), { status: 200 }) : new Response("not found", { status: 404 }),
      );
    },
    sleep: () => Promise.resolve(),
    maxRetries: 1,
    now: () => new Date(NOW),
  });
  const finnhub = new FinnhubProvider({
    apiKey: "finnhub-key-for-tests-only",
    baseUrl: "https://finnhub.test",
    rateLimiter: { acquire: () => Promise.resolve(0) },
    fetch: (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      finnhubRequests.push(url);
      return Promise.resolve(
        new Response(JSON.stringify(articles[url.searchParams.get("symbol") ?? ""] ?? [])),
      );
    },
    sleep: () => Promise.resolve(),
    now: () => new Date(NOW),
  });
  h = await harness({ now: NOW, extraProviders: [sec, finnhub] });
  for (const [ticker, name, cik] of [
    ["NVDA", "NVIDIA Corp", "0001045810"],
    ["MSFT", "Microsoft Corp", "0000789019"],
    ["BRK-B", "Berkshire Hathaway Inc.", null],
  ] as const) {
    const { security_id } = await h.t.db
      .insertInto("market.securities")
      .values({ ticker, name, asset_class: "equity", cik })
      .returning("security_id")
      .executeTakeFirstOrThrow();
    await h.t.db
      .insertInto("market.provider_symbols")
      .values({ security_id, source: "tiingo", source_symbol: ticker, valid_from: "2020-01-02" })
      .execute();
  }
  await h.run("ingest-securities", { source: "synthetic" });
  for (const [acc, cik, at, items] of [
    [NVDA_8K, "0001045810", "2026-08-26T20:21:19Z", ["2.02", "9.01"]],
    [NVDA_8K_NO_EXHIBIT, "0001045810", "2026-09-10T20:05:00Z", ["8.01"]],
    [MSFT_8K, "0000789019", "2026-09-25T20:10:00Z", ["7.01", "9.01"]],
    ["0001045810-25-000001", "0001045810", "2025-11-19T21:00:00Z", ["2.02", "9.01"]],
  ] as const) {
    await h.t.db
      .insertInto("market.filings")
      .values({
        accession_no: acc,
        cik,
        form_type: "8-K",
        filed_at: new Date(at),
        filing_date: at.slice(0, 10),
        period: null,
        primary_document: "doc.htm",
        items: [...items],
        url: `https://sec.test/Archives/edgar/data/${Number(cik)}/${acc.replaceAll("-", "")}/doc.htm`,
        source: "sec_edgar",
      })
      .execute();
  }
});
afterAll(async () => {
  await h.t.drop();
});

const newsOf = (ticker: string) =>
  h.t.db
    .selectFrom("market.news_articles as a")
    .innerJoin("market.news_tickers as t", "t.article_id", "a.article_id")
    .innerJoin("market.securities as s", "s.security_id", "t.security_id")
    .select([
      "a.article_id",
      "a.source",
      "a.headline",
      "a.described",
      "a.publisher",
      "a.duplicate_of",
      "a.url",
    ])
    .where("s.ticker", "=", ticker)
    .orderBy("a.published_at")
    .execute();

describe("8-K press releases", () => {
  it("reads an 8-K's Exhibit 99.1 as a news item about the company, once", async () => {
    expect(await h.run("ingest-press-release", { cik: "1045810", accession_no: NVDA_8K })).toEqual({
      accession_no: NVDA_8K,
      status: "stored",
      headline: "NVIDIA Announces Financial Results for Second Quarter Fiscal 2027",
      described: false,
    });
    const [item] = await newsOf("NVDA");
    expect(item).toMatchObject({
      source: "sec_edgar",
      headline: "NVIDIA Announces Financial Results for Second Quarter Fiscal 2027",
      described: false,
      publisher: "NVIDIA Corp",
      duplicate_of: null,
      url: "https://sec.test/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm",
    });
    const stored = await h.t.db
      .selectFrom("market.news_articles")
      .select(["summary", "published_at", "license_tier", "category"])
      .where("article_id", "=", item!.article_id)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      published_at: new Date("2026-08-26T20:21:19Z"),
      license_tier: "public_domain",
      category: "press release",
    });
    expect(stored.summary).toMatch(/^SANTA CLARA, Calif\.—Aug\. 26, 2026―NVIDIA/);
    const before = secRequests.length;
    expect(
      await h.run("ingest-press-release", { cik: "1045810", accession_no: NVDA_8K }),
    ).toMatchObject({ status: "already_read" });
    expect(secRequests.length).toBe(before);
  });

  it("describes an exhibit without a headline, and records an 8-K without one", async () => {
    expect(await h.run("ingest-press-release", { cik: "789019", accession_no: MSFT_8K })).toEqual({
      accession_no: MSFT_8K,
      status: "stored",
      headline: "Microsoft Corp filed Exhibit 99.1 with a Form 8-K: Regulation FD Disclosure",
      described: true,
    });
    expect(
      await h.run("ingest-press-release", { cik: "1045810", accession_no: NVDA_8K_NO_EXHIBIT }),
    ).toMatchObject({ status: "none", headline: null });
    const checks = await h.t.db
      .selectFrom("market.press_release_checks")
      .select(["accession_no", "outcome", "reader_version"])
      .orderBy("accession_no")
      .execute();
    expect(checks).toEqual([
      { accession_no: NVDA_8K, outcome: "stored", reader_version: 1 },
      { accession_no: NVDA_8K_NO_EXHIBIT, outcome: "none", reader_version: 1 },
      { accession_no: MSFT_8K, outcome: "stored", reader_version: 1 },
    ]);
  });

  it("sweeps recent 8-Ks with exhibits that have not been read", async () => {
    await h.t.db
      .deleteFrom("market.press_release_checks")
      .where("accession_no", "=", MSFT_8K)
      .execute();
    const dispatched: JobRequest[] = [];
    const spy = vi.spyOn(h.dispatcher, "dispatch").mockImplementation((job) => {
      dispatched.push(job);
      return Promise.resolve();
    });
    try {
      // The 2025 8-K is outside the window; the one without Item 9.01 has no exhibits.
      expect(await h.run("sweep-press-releases", { days: 30 })).toMatchObject({ queued: 1 });
      expect(await h.run("sweep-press-releases", { days: 400 })).toMatchObject({ queued: 2 });
    } finally {
      spy.mockRestore();
    }
    expect(dispatched.map((j) => j.jobId)).toEqual([
      `ingest-press-release/${MSFT_8K}/v1`,
      `ingest-press-release/${MSFT_8K}/v1`,
      "ingest-press-release/0001045810-25-000001/v1",
    ]);
  });
});

describe("ingest-news", () => {
  it("does nothing until a Finnhub key is set", async () => {
    const providers = new Map(h.ctx.providers);
    providers.delete("finnhub");
    expect(await runJob({ ...h.ctx, providers }, "ingest-news", {})).toMatchObject({
      configured: false,
    });
  });

  it("stores each article once, tagged with every listing it names, and marks copies", async () => {
    articles = {
      NVDA: [
        // The wire copy of the press release stored from the 8-K.
        article(
          1,
          "2026-08-26T20:25:00Z",
          "NVIDIA Announces Financial Results for Second Quarter Fiscal 2027",
          "https://wire.example.invalid/nvidia-q2",
          "NVDA",
        ),
        article(
          2,
          "2026-09-30T14:00:00Z",
          "Example story naming two companies",
          "https://news.example.invalid/two-companies?utm_source=finnhub",
          "NVDA,BRK.B",
        ),
      ],
      MSFT: [
        // The same story again, with a different tracking parameter.
        article(
          3,
          "2026-09-30T14:00:00Z",
          "Example story naming two companies",
          "https://www.news.example.invalid/two-companies/?utm_medium=feed",
          "MSFT",
        ),
        article(4, "2026-09-30T15:00:00Z", "A link that is not a web page", "javascript:x", "MSFT"),
      ],
    };
    expect(await h.run("ingest-news")).toEqual({
      configured: true,
      companies: 3,
      stored: 1,
      copies: 1,
      alreadyStored: 1,
      skipped: 1,
    });
    // First run: a month back for every company, Finnhub's dotted class-share symbol for BRK-B.
    expect(
      finnhubRequests.map((u) => [u.searchParams.get("symbol"), u.searchParams.get("from")]),
    ).toEqual([
      ["BRK.B", "2026-09-02"],
      ["MSFT", "2026-09-02"],
      ["NVDA", "2026-09-02"],
    ]);
    expect(finnhubRequests.every((u) => !u.toString().includes("finnhub-key"))).toBe(true);

    const nvda = await newsOf("NVDA");
    const press = nvda.find((n) => n.source === "sec_edgar")!;
    expect(nvda.find((n) => n.url === "https://wire.example.invalid/nvidia-q2")).toMatchObject({
      source: "finnhub",
      duplicate_of: press.article_id,
    });
    const shared = nvda.find((n) => n.headline === "Example story naming two companies")!;
    expect(shared.duplicate_of).toBeNull();
    expect((await newsOf("MSFT")).map((n) => n.article_id)).toContain(shared.article_id);
    expect((await newsOf("BRK-B")).map((n) => n.article_id)).toEqual([shared.article_id]);
    const issues = await h.t.db
      .selectFrom("ops.data_quality_issues")
      .select(["rule", "message"])
      .where("dataset", "=", "news")
      .execute();
    expect(issues.map((i) => i.rule)).toEqual(["news_item_skipped"]);
    expect(issues[0]!.message).toMatch(/^MSFT: Finnhub article 4 left out \(url: /);
  });

  it("asks again from two days before the latest article, and stores nothing twice", async () => {
    finnhubRequests.length = 0;
    h.setNow("2026-10-03T12:00:00Z");
    const result = await h.run("ingest-news");
    h.setNow(NOW);
    expect(result).toMatchObject({ stored: 0, copies: 0, alreadyStored: 3 });
    expect(
      Object.fromEntries(
        finnhubRequests.map((u) => [u.searchParams.get("symbol"), u.searchParams.get("from")]),
      ),
    ).toEqual({
      "BRK.B": "2026-09-28",
      MSFT: "2026-09-28",
      NVDA: "2026-09-28",
    });
    expect(
      await h.t.db
        .selectFrom("market.news_articles")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .executeTakeFirst(),
    ).toEqual({ n: "4" });
  });
});

describe("prune-news", () => {
  it("deletes news past the retention period with its tags", async () => {
    await h.t.db
      .updateTable("market.news_articles")
      .set({ published_at: new Date("2025-08-01T12:00:00Z") })
      .where("source", "=", "sec_edgar")
      .where("described", "=", true)
      .execute();
    expect(await h.run("prune-news")).toMatchObject({ deleted: 1 });
    expect((await newsOf("MSFT")).map((n) => n.described)).toEqual([false]);
  });
});
