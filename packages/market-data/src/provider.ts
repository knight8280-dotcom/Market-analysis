import type { IsoDate } from "@market/calendar";
import { NotSupportedError } from "./errors";
import type {
  CorporateAction,
  DailyBar,
  EarningsEvent,
  FilingRecord,
  FundamentalFact,
  MacroObservation,
  MacroSeries,
  NewsItem,
  ProviderId,
  SecurityRecord,
} from "./types";

/** Inclusive date range in the exchange time zone. */
export interface DateRange {
  start: IsoDate;
  end: IsoDate;
}

/** News items, and the ones left out (never repaired or guessed at) with the reason. */
export interface NewsPage {
  items: NewsItem[];
  skipped: { id: string; reason: string }[];
}

export interface SymbolRange extends DateRange {
  /** The vendor's symbol. */
  symbol: string;
}

/**
 * The provider abstraction (spec §2.1). Adapters implement what their vendor supports; the
 * rest throws NotSupportedError. Methods for datasets that arrive in later phases (intraday,
 * quotes, news, earnings, insiders, institutions, options) are declared now so every adapter
 * keeps the same shape; their request and record types are defined when the feature is built.
 *
 * Beyond the spec's list: getFilings, getMacroSeries and getMacroObservations (EDGAR and FRED
 * need them) and healthCheck (used for failback probes).
 */
export interface MarketDataProvider {
  readonly id: ProviderId;
  getSecurities(req?: { symbols?: readonly string[] }): Promise<SecurityRecord[]>;
  getDailyBars(req: SymbolRange): Promise<DailyBar[]>;
  getCorporateActions(req: SymbolRange): Promise<CorporateAction[]>;
  getFundamentals(req: { cik: string }): Promise<FundamentalFact[]>;
  getFilings(req: { cik: string }): Promise<FilingRecord[]>;
  getMacroSeries(req: { seriesId: string }): Promise<MacroSeries>;
  getMacroObservations(req: { seriesId: string; start?: IsoDate }): Promise<MacroObservation[]>;
  /** Earnings dates, estimates and actuals between two dates (inclusive). */
  getEarningsCalendar(req: { from: IsoDate; to: IsoDate }): Promise<EarningsEvent[]>;
  /** A company's news between two dates (inclusive), with any items left out and why. */
  getNews(req: { symbol: string; from: IsoDate; to: IsoDate }): Promise<NewsPage>;
  /** Cheap request proving the vendor is reachable and our credentials work. */
  healthCheck(): Promise<void>;

  // Later phases.
  getIntradayBars(req: unknown): Promise<never>;
  getQuoteSnapshot(req: unknown): Promise<never>;
  streamQuotes(req: unknown): AsyncIterable<never>;
  getInsiderTransactions(req: unknown): Promise<never>;
  getInstitutionalHoldings(req: unknown): Promise<never>;
  getOptionsChain(req: unknown): Promise<never>;
}

/** Default implementations that reject with NotSupportedError. */
export abstract class BaseProvider implements MarketDataProvider {
  abstract readonly id: ProviderId;

  protected unsupported(method: string): Promise<never> {
    return Promise.reject(new NotSupportedError(this.id, method));
  }

  getSecurities(_req?: { symbols?: readonly string[] }): Promise<SecurityRecord[]> {
    return this.unsupported("getSecurities");
  }
  getDailyBars(_req: SymbolRange): Promise<DailyBar[]> {
    return this.unsupported("getDailyBars");
  }
  getCorporateActions(_req: SymbolRange): Promise<CorporateAction[]> {
    return this.unsupported("getCorporateActions");
  }
  getFundamentals(_req: { cik: string }): Promise<FundamentalFact[]> {
    return this.unsupported("getFundamentals");
  }
  getFilings(_req: { cik: string }): Promise<FilingRecord[]> {
    return this.unsupported("getFilings");
  }
  getMacroSeries(_req: { seriesId: string }): Promise<MacroSeries> {
    return this.unsupported("getMacroSeries");
  }
  getMacroObservations(_req: { seriesId: string; start?: IsoDate }): Promise<MacroObservation[]> {
    return this.unsupported("getMacroObservations");
  }
  abstract healthCheck(): Promise<void>;

  getIntradayBars(_req: unknown): Promise<never> {
    return this.unsupported("getIntradayBars");
  }
  getQuoteSnapshot(_req: unknown): Promise<never> {
    return this.unsupported("getQuoteSnapshot");
  }
  streamQuotes(_req: unknown): AsyncIterable<never> {
    throw new NotSupportedError(this.id, "streamQuotes");
  }
  getNews(_req: { symbol: string; from: IsoDate; to: IsoDate }): Promise<NewsPage> {
    return this.unsupported("getNews");
  }
  getEarningsCalendar(_req: { from: IsoDate; to: IsoDate }): Promise<EarningsEvent[]> {
    return this.unsupported("getEarningsCalendar");
  }
  getInsiderTransactions(_req: unknown): Promise<never> {
    return this.unsupported("getInsiderTransactions");
  }
  getInstitutionalHoldings(_req: unknown): Promise<never> {
    return this.unsupported("getInstitutionalHoldings");
  }
  getOptionsChain(_req: unknown): Promise<never> {
    return this.unsupported("getOptionsChain");
  }
}
