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
  sic: z.string().nullable().optional(),
  sicDescription: z.string().nullable().optional(),
  tickers: z.array(z.string()).optional(),
  exchanges: z.array(z.string().nullable()).optional(),
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
  // Usually a number; some newer registrants' files send a numeric string ("2115436").
  cik: z.union([z.number().int(), z.string().regex(/^\d{1,10}$/)]),
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

export interface EdgarEntity {
  cik: string;
  name: string;
  sicCode: string | null;
  sicDescription: string | null;
  tickers: string[];
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
      // companyfacts for a large filer is several MB.
      timeoutMs: 60_000,
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
    return (await this.getSubmissions(req)).filings;
  }

  /** One submissions request: registrant metadata (name, SIC) plus recent filings. */
  async getSubmissions(req: {
    cik: string;
  }): Promise<{ entity: EdgarEntity; filings: FilingRecord[] }> {
    const cik = padCik(req.cik);
    const fetchedAt = this.now();
    const raw = await this.http.getJson(`${this.dataBase}/submissions/CIK${cik}.json`);
    const payload = parseVendor(this.id, SubmissionsPayload, raw, "submissions");
    const sic = payload.sic && /^\d{3,4}$/.test(payload.sic) ? payload.sic : null;
    const entity: EdgarEntity = {
      cik,
      name: payload.name,
      sicCode: sic,
      sicDescription: payload.sicDescription || null,
      tickers: payload.tickers ?? [],
    };
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
    return { entity, filings };
  }

  /** Every XBRL fact in companyfacts, one record per (filing, concept, unit, period). */
  override async getFundamentals(req: { cik: string }): Promise<FundamentalFact[]> {
    const cik = padCik(req.cik);
    const fetchedAt = this.now();
    const raw = await this.http.getJson(`${this.dataBase}/api/xbrl/companyfacts/CIK${cik}.json`);
    const payload = parseVendor(this.id, CompanyFactsPayload, raw, "companyfacts");
    if (padCik(payload.cik) !== cik) {
      throw new ProviderResponseError(this.id, `companyfacts for ${cik} names CIK ${payload.cik}`);
    }
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
                  // Some facts (e.g. 8-K exhibits) carry fy 0 and fp "": no fiscal period.
                  fiscal_year: f.fy ? f.fy : null,
                  fiscal_period: f.fp ? f.fp : null,
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

  /** A document in a filing's EDGAR archive folder, e.g. FilingSummary.xml or R3.htm. */
  async getArchiveDocument(req: { cik: string; accession: string; file: string }): Promise<string> {
    if (!/^[A-Za-z0-9._-]+$/.test(req.file))
      throw new TypeError(`Bad archive file name: ${req.file}`);
    if (!/^\d{10}-\d{2}-\d{6}$/.test(req.accession)) {
      throw new TypeError(`Bad accession number: ${req.accession}`);
    }
    const folder = `${Number(padCik(req.cik))}/${req.accession.replaceAll("-", "")}`;
    return this.http.getText(`${this.wwwBase}/Archives/edgar/data/${folder}/${req.file}`);
  }

  override async healthCheck(): Promise<void> {
    await this.http.getJson(`${this.dataBase}/submissions/CIK${this.probeCik}.json`);
  }
}

/**
 * EDGAR's acceptanceDateTime (e.g. "2025-10-31T10:01:26.000Z") is true UTC: verified on
 * 2026-09-30 against the filing index page, which showed "Accepted 2025-10-31 06:01:26"
 * (Eastern, UTC-4). Falls back to 00:00 ET on the filing date when missing or malformed.
 */
export function acceptanceTime(value: string, filingDate: string): Date {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return zonedTimeToUtc(filingDate, "00:00");
}
