/**
 * What a backtest runs on. The worker loads it from the database; tests build it by hand. Every
 * array is oldest first.
 */

export interface Bars {
  /** Sessions this security traded, ascending. */
  dates: string[];
  /** Raw prices and volume, as traded on the day. Fills and valuations use these. */
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  /**
   * Cumulative adjustment factors for the splits and dividends after each bar, as known at the
   * end of the data (market.adjustment_factors). Adjusted price = raw × split × dividend;
   * adjusted volume = raw ÷ split.
   */
  splitFactor: number[];
  dividendFactor: number[];
}

/** A split or stock dividend: `ratio` new shares per old share from `exDate`. */
export interface ShareChange {
  exDate: string;
  ratio: number;
}

/** Cash per share, in the share basis of the ex-date. */
export interface CashDividend {
  exDate: string;
  amount: number;
}

/**
 * Trailing-twelve-month figures as first reported, usable from `availableFrom` (the session
 * after the filing that completed them).
 */
export interface FundamentalPoint {
  availableFrom: string;
  /** The last period end the TTM figures cover. */
  periodEnd: string;
  revenueTtm: number | null;
  netIncomeTtm: number | null;
  /** The same TTM figure one year earlier, as known at `availableFrom`. */
  revenueTtmYearAgo: number | null;
}

/** Shares outstanding from a filing's cover page, as of `asOf`, usable from `availableFrom`. */
export interface SharesPoint {
  availableFrom: string;
  asOf: string;
  shares: number;
}

export interface SecurityData {
  securityId: string;
  ticker: string;
  bars: Bars;
  shareChanges: ShareChange[];
  dividends: CashDividend[];
  fundamentals: FundamentalPoint[];
  shares: SharesPoint[];
  /**
   * When the security belongs to the universe (inclusive dates; `to` null = open-ended), e.g.
   * the dates its ticker was valid. Survivorship-free: delisted securities keep their history.
   */
  membership: { from: string; to: string | null }[];
  /** Delisting date; a position still held is closed at the last available close. */
  delistedAt: string | null;
}

export interface BacktestData {
  /** Every trading session from the first bar loaded (for indicator warm-up) to the end. */
  sessions: string[];
  securities: SecurityData[];
  /** Total-return (split- and dividend-adjusted) closes of the benchmark. */
  benchmark: { ticker: string; dates: string[]; adjClose: number[] } | null;
  /** 3-month T-bill rate (FRED DTB3) as a decimal annual rate, by observation date. */
  riskFree: { dates: string[]; rate: number[] } | null;
}

export { lastIndexAtOrBefore } from "@market/metrics";
