import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ProviderError } from "@market/market-data";
import { SecEdgarProvider } from "@market/market-data/adapters/sec-edgar";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRequest } from "../src/context";
import { harness, type Harness } from "./helpers/context";

/**
 * Form 4 insider transactions (Phase 2 step H1) against filings recorded from EDGAR on
 * 2026-10-02, served by a stub SEC host.
 */
const FORM4 = "../../../packages/market-data/test/fixtures/sec-edgar/recorded/form4/";
const recorded = (acc: string) =>
  readFileSync(fileURLToPath(new URL(`${FORM4}${acc}.xml`, import.meta.url)), "utf8");

const NOW = new Date("2026-10-02T12:00:00Z");

/** Accession, the CIK it is listed under, its folder's XML (or a status), filing time. */
const FILINGS = [
  { acc: "0000050863-26-000177", cik: "0000050863", form: "4", at: "2026-08-14T20:30:00Z" },
  { acc: "0000050863-26-000174", cik: "0000050863", form: "4", at: "2026-08-03T20:30:00Z" },
  { acc: "0001921955-26-000012", cik: "0000027419", form: "4/A", at: "2026-04-09T20:30:00Z" },
  // Listed under Goldman Sachs (a reporting owner); the issuer is Old QVC Group.
  { acc: "0000886982-26-000310", cik: "0000886982", form: "4", at: "2026-08-10T20:30:00Z" },
] as const;

const BROKEN = "0000000042-26-000001";
const NO_XML = "0000000042-26-000002";
const FLAKY = "0000000042-26-000003";
const OLD = "0000000042-25-000004";

let h: Harness;
const requests: string[] = [];
let flakyStatus = 503;

function secProvider() {
  const fetchImpl = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url.pathname);
    for (const f of FILINGS) {
      if (
        url.pathname ===
        `/Archives/edgar/data/${Number(f.cik)}/${f.acc.replaceAll("-", "")}/form4.xml`
      ) {
        return Promise.resolve(new Response(recorded(f.acc), { status: 200 }));
      }
    }
    if (url.pathname.includes(BROKEN.replaceAll("-", ""))) {
      // A real document cut off mid-way.
      return Promise.resolve(new Response(recorded("0001140361-26-038307").slice(0, 900)));
    }
    if (url.pathname.includes(FLAKY.replaceAll("-", ""))) {
      return Promise.resolve(new Response("busy", { status: flakyStatus }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return new SecEdgarProvider({
    appName: "Example Analytics",
    contactEmail: "admin@example.com",
    rateLimiter: { acquire: () => Promise.resolve(0) },
    baseUrl: "https://sec.test",
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    maxRetries: 1,
    now: () => NOW,
  });
}

async function storeFiling(f: {
  acc: string;
  cik: string;
  form: string;
  at: string;
  primary?: string | null;
}) {
  const folder = `https://sec.test/Archives/edgar/data/${Number(f.cik)}/${f.acc.replaceAll("-", "")}`;
  await h.t.db
    .insertInto("market.filings")
    .values({
      accession_no: f.acc,
      cik: f.cik,
      form_type: f.form,
      filed_at: new Date(f.at),
      filing_date: f.at.slice(0, 10),
      period: null,
      primary_document: f.primary === undefined ? "xslF345X06/form4.xml" : f.primary,
      items: [],
      url: `${folder}/${f.primary ?? "form4.xml"}`,
      source: "sec_edgar",
    })
    .execute();
}

beforeAll(async () => {
  h = await harness({ now: NOW.toISOString(), extraProviders: [secProvider()] });
  for (const f of FILINGS) await storeFiling(f);
  // The same Form 4 also listed under its reporting owner's CIK.
  await storeFiling({ ...FILINGS[0], cik: "0001008463" });
  await storeFiling({ acc: BROKEN, cik: "0000000042", form: "4", at: "2026-09-01T20:00:00Z" });
  await storeFiling({
    acc: NO_XML,
    cik: "0000000042",
    form: "4",
    at: "2026-09-02T20:00:00Z",
    primary: "form4.htm",
  });
  await storeFiling({ acc: FLAKY, cik: "0000000042", form: "4/A", at: "2026-09-03T20:00:00Z" });
  await storeFiling({ acc: OLD, cik: "0000000042", form: "4", at: "2024-01-05T20:00:00Z" });
  await storeFiling({
    acc: "0000000042-26-000009",
    cik: "0000000042",
    form: "10-Q",
    at: "2026-09-04T20:00:00Z",
    primary: "q.htm",
  });
});
afterAll(async () => {
  await h.t.drop();
});

const transactions = (acc: string) =>
  h.t.db
    .selectFrom("market.insider_transactions")
    .selectAll()
    .where("accession_no", "=", acc)
    .orderBy("line")
    .execute();

describe("ingest-insider", () => {
  it("reads a Form 4 and stores its lines as filed", async () => {
    const result = await h.run("ingest-insider", { cik: "50863", accession_no: FILINGS[0].acc });
    expect(result).toEqual({
      accession_no: FILINGS[0].acc,
      status: "read",
      issuer_cik: "0000050863",
      transactions: 1,
    });
    const filing = await h.t.db
      .selectFrom("market.insider_filings")
      .selectAll()
      .where("accession_no", "=", FILINGS[0].acc)
      .executeTakeFirstOrThrow();
    expect(filing).toMatchObject({
      issuer_cik: "0000050863",
      issuer_name: "INTEL CORP",
      issuer_symbol: "INTC",
      form_type: "4",
      period_of_report: "2026-08-11",
      original_filing_date: null,
      aff_10b5_1: false,
      source: "sec_edgar",
      parser_version: 1,
      url: "https://sec.test/Archives/edgar/data/50863/000005086326000177/form4.xml",
    });
    expect(filing.filed_at).toEqual(new Date(FILINGS[0].at));
    expect(filing.owners).toEqual([
      expect.objectContaining({ cik: "0001008463", name: "TAN LIP BU", officer_title: "CEO" }),
    ]);
    expect(await transactions(FILINGS[0].acc)).toEqual([
      expect.objectContaining({
        line: 1,
        code: "P",
        derivative: false,
        transaction_date: "2026-08-11",
        shares: "105263",
        price: "95",
        acquired_disposed: "A",
        shares_after: "1314669",
        ownership: "I",
        ownership_nature: "by Family Trust",
      }),
    ]);
  });

  it("keeps derivative lines, null prices and an amendment's original date", async () => {
    await h.run("ingest-insider", { cik: "50863", accession_no: FILINGS[1].acc });
    expect(
      (await transactions(FILINGS[1].acc)).map((t) => [t.code, t.derivative, t.price]),
    ).toEqual([
      ["M", false, null],
      ["F", false, "90.04"],
      ["M", true, null],
    ]);
    await h.run("ingest-insider", { cik: "27419", accession_no: FILINGS[2].acc });
    const amendment = await h.t.db
      .selectFrom("market.insider_filings")
      .select(["form_type", "original_filing_date"])
      .where("accession_no", "=", FILINGS[2].acc)
      .executeTakeFirstOrThrow();
    expect(amendment).toEqual({ form_type: "4/A", original_filing_date: "2026-03-19" });
  });

  it("files a document about another company under that company's CIK", async () => {
    const result = await h.run("ingest-insider", { cik: "886982", accession_no: FILINGS[3].acc });
    expect(result).toMatchObject({ status: "read", issuer_cik: "0001355096", transactions: 0 });
  });

  it("does not fetch a filing it has already read", async () => {
    const before = requests.length;
    const again = await h.run("ingest-insider", { cik: "1008463", accession_no: FILINGS[0].acc });
    expect(again).toEqual({ accession_no: FILINGS[0].acc, status: "already_read" });
    expect(requests.length).toBe(before);
    expect(await transactions(FILINGS[0].acc)).toHaveLength(1);
  });

  it("records documents it cannot read, and they stop being retried", async () => {
    expect(await h.run("ingest-insider", { cik: "42", accession_no: BROKEN })).toMatchObject({
      status: "unreadable",
    });
    expect(await h.run("ingest-insider", { cik: "42", accession_no: NO_XML })).toMatchObject({
      status: "unreadable",
      error: "no XML document (primary document: form4.htm)",
    });
    const errors = await h.t.db
      .selectFrom("market.insider_filing_errors")
      .select(["accession_no", "parser_version"])
      .orderBy("accession_no")
      .execute();
    expect(errors).toEqual([
      { accession_no: BROKEN, parser_version: 1 },
      { accession_no: NO_XML, parser_version: 1 },
    ]);
    expect(
      await h.t.db
        .selectFrom("market.insider_filings")
        .select("accession_no")
        .where("accession_no", "in", [BROKEN, NO_XML])
        .execute(),
    ).toEqual([]);
  });

  it("lets a network failure fail the job (so it retries) without recording anything", async () => {
    await expect(
      h.run("ingest-insider", { cik: "42", accession_no: FLAKY }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(
      await h.t.db
        .selectFrom("market.insider_filing_errors")
        .select("accession_no")
        .where("accession_no", "=", FLAKY)
        .execute(),
    ).toEqual([]);
  });

  it("refuses filings that are not Form 4", async () => {
    expect(
      await h.run("ingest-insider", { cik: "42", accession_no: "0000000042-26-000009" }),
    ).toEqual({ accession_no: "0000000042-26-000009", status: "not_form_4" });
  });
});

describe("sweep-insiders", () => {
  it("queues each unread Form 4 in the window once, skipping read and unreadable ones", async () => {
    const dispatched: JobRequest[] = [];
    const spy = vi.spyOn(h.dispatcher, "dispatch").mockImplementation((job) => {
      dispatched.push(job);
      return Promise.resolve();
    });
    try {
      expect(await h.run("sweep-insiders", { days: 365 })).toEqual({
        since: "2025-10-02T12:00:00.000Z",
        queued: 1,
      });
      expect(dispatched.map((j) => [j.jobId, j.data])).toEqual([
        [`ingest-insider/${FLAKY}/v1`, { cik: "0000000042", accession_no: FLAKY }],
      ]);
      dispatched.length = 0;
      // A longer window reaches the January 2024 filing too (1,100 days back is 2023-09-28).
      await h.run("sweep-insiders", { days: 1100 });
      expect(dispatched.map((j) => j.jobId)).toEqual([
        `ingest-insider/${FLAKY}/v1`,
        `ingest-insider/${OLD}/v1`,
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("offers a filing whose fetch failed again on the next sweep", async () => {
    flakyStatus = 404;
    // A 404 is not retried within the job: it fails, nothing is stored or recorded as unreadable.
    await expect(
      h.run("ingest-insider", { cik: "42", accession_no: FLAKY }),
    ).rejects.toBeInstanceOf(ProviderError);
    const dispatched: JobRequest[] = [];
    const spy = vi.spyOn(h.dispatcher, "dispatch").mockImplementation((job) => {
      dispatched.push(job);
      return Promise.resolve();
    });
    try {
      await h.run("sweep-insiders", { days: 365 });
      expect(dispatched.map((j) => j.jobId)).toEqual([`ingest-insider/${FLAKY}/v1`]);
    } finally {
      spy.mockRestore();
    }
    const stored = await h.t.db
      .selectFrom("market.insider_filings")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(stored.n)).toBe(4);
  });
});
