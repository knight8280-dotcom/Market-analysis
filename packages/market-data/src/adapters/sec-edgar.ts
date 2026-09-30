import { zonedTimeToUtc } from "@market/calendar";
import { z } from "zod";
import { ProviderResponseError } from "../errors";
import { HttpClient, type HttpClientOptions, type RateLimiter } from "../http";
import { BaseProvider } from "../provider";
import { FilingRecord, FundamentalFact } from "../types";
import { parseVendor } from "./common";

/**
 * SEC EDGAR adapter (spec §2.3): company ticker map, submissions (filing metadata) and XBRL
 * companyfacts. Every request goes through the shared Redis rate limiter (8 req/s across all
 * workers) with the declared User-Agent SEC's fair-access policy requires.
 *
 * Fixtures in test/fixtures/sec-edgar are hand-built in the documented response shape, because
 * recording live responses needs our real User-Agent contact. Re-record them on the first live
 * run (docs/DATA_SOURCES.md).
 */

export const SEC_HOSTS = { data: "data.sec.gov", www: "www.sec.gov" } as const;

/** SEC fair-access format: "Sample Company Name AdminContact@<sample company domain>.com". */
export function secUserAgent(appName: string, contactEmail: string): string {
  if (!appName.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new Error("SEC requests need an app name and a real contact email in the User-Agent");
  }
  return `${appName.trim()} ${contactEmail}`;
}

export function padCik(cik: string | number): string {
  const digits = String(cik).replace(/^CIK/i, "");
  if (!/^\d{1,10}$/.test(digits)) throw new TypeError(`Not a CIK: ${cik}`);
  return digits.padStart(10, "0");
}

// --- Vendor payload shapes -------------------------------------------------------------------

const TickerExchangePayload = z.object({
  fields: z.tuple([
    z.literal("cik"),
    z.literal("name"),
    z.literal("ticker"),
    z.literal("exchange"),
  ]),
  data: z.array(z.tuple([z.number().int(), z.string(), z.string(), z.string().nullable()])),
});

const SubmissionsPayload = z.object({
  cik: z.string(),
  name: z.string(),
  filings: z.object({
    recent: z.object({
      accessionNumber: z.array(z.string()),
      filingDate: z.array(z.string()),
      reportDate: z.array(z.string()),
      acceptanceDateTime: z.array(z.string()),
      form: z.array(z.string()),
      items: z.array(z.string()),
      primaryDocument: z.array(z.string()),
    }),
    files: z.array(
      z.object({
        name: z.string(),
        filingCount: z.number(),
        filingFrom: z.string(),
        filingTo: z.string(),
      }),
    ),
  }),
});

const FactPayload = z.object({
  start: z.string().optional(),
  end: z.string(),
  val: z.number(),
  accn: z.string(),
  fy: z.number().int().nullable().optional(),
  fp: z.string().nullable().optional(),
  form: z.string(),
  filed: z.string(),
  frame: z.string().optional(),
});

const CompanyFactsPayload = z.object({
  cik: z.number().int(),
  entityName: z.string(),
  facts: z.record(
    z.string(),
    z.record(
      z.string(),
      z.object({
        label: z.string().nullable().optional(),
        units: z.record(z.string(), z.array(FactPayload)),
      }),
    ),
  ),
});

// --- Adapter --------------------------------------------------------------------------------

export interface TickerMapEntry {
  cik: string;
  name: string;
  ticker: string;
  exchange: string | null;
}

export interface SecEdgarOptions extends Pick<
  HttpClientOptions,
  "fetch" | "sleep" | "random" | "onResponse" | "maxRetries"
> {
  appName: string;
  contactEmail: string;
  /** The shared limiter (SEC_RATE_LIMIT). Required: EDGAR is never called unmetered. */
  rateLimiter: RateLimiter;
  /** Test override: scheme + host for both SEC hosts, e.g. "http://127.0.0.1:1234". */
  baseUrl?: string;
  now?: () => Date;
  /** CIK fetched by healthCheck (default Apple, 0000320193). */
  probeCik?: string;
}

export class SecEdgarProvider extends BaseProvider {
  readonly id = "sec_edgar" as const;
  readonly http: HttpClient;
  private readonly dataBase: string;
  private readonly wwwBase: string;
  private readonly now: () => Date;
  private readonly probeCik: string;

  constructor(opts: SecEdgarOptions) {
    super();
    const override = opts.baseUrl ? new URL(opts.baseUrl) : null;
    this.dataBase = override ? override.origin : `https://${SEC_HOSTS.data}`;
    this.wwwBase = override ? override.origin : `https://${SEC_HOSTS.www}`;
    this.http = new HttpClient({
      provider: this.id,
      allowedHosts: override ? [override.host] : [SEC_HOSTS.data, SEC_HOSTS.www],
      headers: { "user-agent": secUserAgent(opts.appName, opts.contactEmail) },
      // SEC signals throttling with 403 as well as 429 (spec §2.3: back off on 429/403/503).
      retryStatuses: [403, 429, 500, 502, 503, 504],
      baseDelayMs: 1000,
      rateLimiter: opts.rateLimiter,
      fetch: opts.fetch,
      sleep: opts.sleep,
      random: opts.random,
      onResponse: opts.onResponse,
      maxRetries: opts.maxRetries,
    });
    this.now = opts.now ?? (() => new Date());
    this.probeCik = padCik(opts.probeCik ?? "320193");
  }

  /** Ticker → CIK map from company_tickers_exchange.json. Used to attach CIKs to securities. */
  async getTickerMap(): Promise<TickerMapEntry[]> {
    const raw = await this.http.getJson(`${this.wwwBase}/files/company_tickers_exchange.json`);
    const payload = parseVendor(this.id, TickerExchangePayload, raw, "company_tickers_exchange");
    return payload.data.map(([cik, name, ticker, exchange]) => ({
      cik: padCik(cik),
      name,
      ticker,
      exchange,
    }));
  }

  /**
   * Recent filings from the submissions API (at least one year or 1,000 filings). Older pages
   * listed under `filings.files` are left to the bulk submissions.zip path (RUNBOOK).
   */
  override async getFilings(req: { cik: string }): Promise<FilingRecord[]> {
    const cik = padCik(req.cik);
    const fetchedAt = this.now();
    const raw = await this.http.getJson(`${this.dataBase}/submissions/CIK${cik}.json`);
    const payload = parseVendor(this.id, SubmissionsPayload, raw, "submissions");
    const r = payload.filings.recent;
    const n = r.accessionNumber.length;
    for (const column of [
      r.filingDate,
      r.reportDate,
      r.acceptanceDateTime,
      r.form,
      r.items,
      r.primaryDocument,
    ]) {
      if (column.length !== n) {
        throw new ProviderResponseError(
          this.id,
          "Unexpected submissions response shape: columns differ in length",
        );
      }
    }

    const filings: FilingRecord[] = [];
    for (let i = 0; i < n; i += 1) {
      const accession = r.accessionNumber[i]!;
      const filingDate = r.filingDate[i]!;
      const primary = r.primaryDocument[i] || null;
      const folder = `${this.wwwBase}/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}`;
      const filedAt = acceptanceTime(r.acceptanceDateTime[i]!, filingDate);
      filings.push(
        parseVendor(
          this.id,
          FilingRecord,
          {
            source: this.id,
            source_symbol: cik,
            fetched_at: fetchedAt,
            as_of: filedAt,
            license_tier: "public_domain",
            accession_no: accession,
            cik,
            form_type: r.form[i]!,
            filed_at: filedAt,
            filing_date: filingDate,
            period: r.reportDate[i] || null,
            primary_document: primary,
            items: r.items[i]
              ? r.items[i]!.split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [],
            url: primary ? `${folder}/${primary}` : `${folder}/${accession}-index.htm`,
          },
          "submissions row",
        ),
      );
    }
    return filings;
  }

  /** Every XBRL fact in companyfacts, one record per (filing, concept, unit, period). */
  override async getFundamentals(req: { cik: string }): Promise<FundamentalFact[]> {
    const cik = padCik(req.cik);
    const fetchedAt = this.now();
    const raw = await this.http.getJson(`${this.dataBase}/api/xbrl/companyfacts/CIK${cik}.json`);
    const payload = parseVendor(this.id, CompanyFactsPayload, raw, "companyfacts");
    const facts: FundamentalFact[] = [];
    for (const [taxonomy, concepts] of Object.entries(payload.facts)) {
      for (const [concept, { units }] of Object.entries(concepts)) {
        for (const [unit, list] of Object.entries(units)) {
          for (const f of list) {
            facts.push(
              parseVendor(
                this.id,
                FundamentalFact,
                {
                  source: this.id,
                  source_symbol: cik,
                  fetched_at: fetchedAt,
                  as_of: zonedTimeToUtc(f.filed, "00:00"),
                  license_tier: "public_domain",
                  cik,
                  taxonomy,
                  concept,
                  unit,
                  value: f.val,
                  period_start: f.start ?? null,
                  period_end: f.end,
                  fiscal_year: f.fy ?? null,
                  fiscal_period: f.fp ?? null,
                  form: f.form,
                  filed_at: f.filed,
                  accession_no: f.accn,
                  frame: f.frame ?? null,
                },
                "companyfacts fact",
              ),
            );
          }
        }
      }
    }
    return facts;
  }

  override async healthCheck(): Promise<void> {
    await this.http.getJson(`${this.dataBase}/submissions/CIK${this.probeCik}.json`);
  }
}

/**
 * EDGAR's acceptanceDateTime looks like "2024-11-01T06:01:36.000Z", but the wall-clock time
 * appears to be Eastern even though it carries "Z". Reading it as Eastern makes a filing public
 * 4-5 hours later than the UTC reading, which is the conservative direction for point-in-time
 * use (it can never create look-ahead). Unverified against a live response; see DATA_SOURCES.md.
 * Falls back to 00:00 ET on the filing date.
 */
export function acceptanceTime(value: string, filingDate: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!m) return zonedTimeToUtc(filingDate, "00:00");
  const minute = zonedTimeToUtc(m[1]!, `${m[2]}:${m[3]}`);
  return new Date(minute.getTime() + Number(m[4]) * 1000);
}
