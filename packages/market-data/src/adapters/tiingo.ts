import type { IsoDate } from "@market/calendar";
import { z } from "zod";
import { ProviderError } from "../errors";
import { HttpClient, type HttpClientOptions, type RateLimiter } from "../http";
import { BaseProvider, type SymbolRange } from "../provider";
import { CorporateAction, DailyBar, SecurityRecord, type AssetClass } from "../types";
import { exchangeMic, parseVendor, sessionCloseOf } from "./common";

/**
 * Tiingo end-of-day adapter (the primary price provider, pending contract).
 *
 * SHAPE UNVERIFIED: built from Tiingo's public documentation (price fields date, open, high,
 * low, close, volume, adjOpen..adjVolume, divCash, splitFactor; meta fields ticker, name,
 * exchangeCode, description, startDate, endDate) and tested against fixtures with synthetic
 * values. The Authorization header scheme is also unverified. Record one response per endpoint
 * with a personal key before relying on it (spec rule 9; docs/DATA_SOURCES.md).
 *
 * Personal keys are for the developer only: this data must not be shown to anyone else until a
 * display license is signed (DATA_LICENSES.tiingo).
 *
 * We store only the raw fields. Tiingo's adjusted fields are ignored; we compute our own
 * adjustments from the corporate actions (divCash, splitFactor) carried on the same rows.
 */

export const TIINGO_HOST = "api.tiingo.com";

const PriceRow = z.object({
  date: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  divCash: z.number(),
  splitFactor: z.number(),
});
const PricesPayload = z.array(PriceRow);

const MetaPayload = z.object({
  ticker: z.string(),
  name: z.string(),
  exchangeCode: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
});

export interface TiingoOptions extends Pick<
  HttpClientOptions,
  "fetch" | "sleep" | "random" | "onResponse"
> {
  apiKey: string;
  /**
   * Asset class per symbol. Tiingo's meta endpoint does not report it, and guessing would
   * fabricate reference data, so securities missing from this map are refused.
   */
  assetClasses?: Readonly<Record<string, AssetClass>>;
  /** Plan quotas (see tiingoRateLimits); every request waits for a slot. */
  rateLimiter?: RateLimiter;
  baseUrl?: string;
  now?: () => Date;
}

export class TiingoProvider extends BaseProvider {
  readonly id = "tiingo" as const;
  readonly http: HttpClient;
  private readonly base: string;
  private readonly now: () => Date;
  private readonly assetClasses: Readonly<Record<string, AssetClass>>;
  // Bars and corporate actions come from the same rows; one request serves both calls.
  private readonly recent = new Map<
    string,
    { at: number; rows: Promise<z.infer<typeof PricesPayload>> }
  >();

  constructor(opts: TiingoOptions) {
    super();
    const override = opts.baseUrl ? new URL(opts.baseUrl) : null;
    this.base = override ? override.origin : `https://${TIINGO_HOST}`;
    this.now = opts.now ?? (() => new Date());
    this.assetClasses = opts.assetClasses ?? {};
    this.http = new HttpClient({
      provider: this.id,
      allowedHosts: [override ? override.host : TIINGO_HOST],
      headers: { authorization: `Token ${opts.apiKey}` },
      redactQueryParams: ["token"],
      rateLimiter: opts.rateLimiter,
      fetch: opts.fetch,
      sleep: opts.sleep,
      random: opts.random,
      onResponse: opts.onResponse,
    });
  }

  private priceRows(req: SymbolRange): Promise<z.infer<typeof PricesPayload>> {
    const url = new URL(`/tiingo/daily/${encodeURIComponent(req.symbol)}/prices`, this.base);
    url.searchParams.set("startDate", req.start);
    url.searchParams.set("endDate", req.end);
    url.searchParams.set("format", "json");
    const key = url.toString();
    const cached = this.recent.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.rows;
    const rows = this.http
      .getJson(url)
      .then((raw) => parseVendor(this.id, PricesPayload, raw, "daily prices"));
    this.recent.set(key, { at: Date.now(), rows });
    for (const [k, v] of this.recent) if (Date.now() - v.at >= 60_000) this.recent.delete(k);
    return rows;
  }

  override async getDailyBars(req: SymbolRange): Promise<DailyBar[]> {
    const fetchedAt = this.now();
    const rows = await this.priceRows(req);
    return rows.map((r) => {
      const date = r.date.slice(0, 10);
      return parseVendor(
        this.id,
        DailyBar,
        {
          source: this.id,
          source_symbol: req.symbol,
          fetched_at: fetchedAt,
          as_of: sessionCloseOf(date),
          license_tier: "personal_dev",
          date,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          vwap: null,
        },
        "daily price row",
      );
    });
  }

  override async getCorporateActions(req: SymbolRange): Promise<CorporateAction[]> {
    const fetchedAt = this.now();
    const rows = await this.priceRows(req);
    const actions: CorporateAction[] = [];
    for (const r of rows) {
      const date: IsoDate = r.date.slice(0, 10);
      const base = {
        source: this.id,
        source_symbol: req.symbol,
        fetched_at: fetchedAt,
        as_of: sessionCloseOf(date),
        license_tier: "personal_dev" as const,
        ex_date: date,
        currency: "USD",
        record_date: null,
        pay_date: null,
        details: {},
      };
      if (r.splitFactor !== 1) {
        actions.push(
          parseVendor(
            this.id,
            CorporateAction,
            { ...base, type: "split", ratio: r.splitFactor, cash_amount: null },
            "split",
          ),
        );
      }
      if (r.divCash > 0) {
        actions.push(
          parseVendor(
            this.id,
            CorporateAction,
            { ...base, type: "cash_dividend", ratio: null, cash_amount: r.divCash },
            "dividend",
          ),
        );
      }
    }
    return actions;
  }

  override async getSecurities(
    req: { symbols?: readonly string[] } = {},
  ): Promise<SecurityRecord[]> {
    const symbols = req.symbols ?? Object.keys(this.assetClasses);
    const out: SecurityRecord[] = [];
    for (const symbol of symbols) {
      const assetClass = this.assetClasses[symbol];
      if (!assetClass) {
        throw new ProviderError(
          this.id,
          `Asset class for ${symbol} is not configured; refusing to guess`,
          {
            retryable: false,
          },
        );
      }
      const fetchedAt = this.now();
      const raw = await this.http.getJson(
        new URL(`/tiingo/daily/${encodeURIComponent(symbol)}`, this.base),
      );
      const meta = parseVendor(this.id, MetaPayload, raw, "ticker meta");
      out.push(
        parseVendor(
          this.id,
          SecurityRecord,
          {
            source: this.id,
            source_symbol: symbol,
            fetched_at: fetchedAt,
            as_of: fetchedAt,
            license_tier: "personal_dev",
            source_security_id: null,
            ticker: meta.ticker.toUpperCase(),
            name: meta.name,
            asset_class: assetClass,
            exchange_mic: exchangeMic(meta.exchangeCode),
            cik: null,
            figi: null,
            sector: null,
            industry: null,
            currency: "USD",
            listed_at: meta.startDate ? meta.startDate.slice(0, 10) : null,
            delisted_at: null,
            symbol_history: [],
          },
          "ticker meta",
        ),
      );
    }
    return out;
  }

  override async healthCheck(): Promise<void> {
    await this.http.getJson(new URL("/tiingo/daily/spy", this.base));
  }
}
