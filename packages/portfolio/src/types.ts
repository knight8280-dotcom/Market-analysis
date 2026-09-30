/** Transaction types, as stored in public.transactions. */
export const TX_TYPES = ["buy", "sell", "dividend", "deposit", "withdrawal", "fee"] as const;
export type TxType = (typeof TX_TYPES)[number];

/**
 * One ledger entry. Quantities and prices are as traded (before any later split). `amount` is
 * the cash amount for dividends, deposits, withdrawals and fees; trades use quantity × price.
 */
export interface Tx {
  id?: string;
  date: string;
  type: TxType;
  securityId: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fees: number;
}

/** A split or stock dividend: `ratio` new shares per old share, effective on `exDate`. */
export interface ShareAction {
  securityId: string;
  exDate: string;
  ratio: number;
}

/** Raw (as-traded) closes per security, dates ascending. */
export type PriceBook = ReadonlyMap<
  string,
  { dates: readonly string[]; closes: readonly number[] }
>;

export interface Lot {
  securityId: string;
  openDate: string;
  quantity: number;
  /** Cost per share including the buy's fees, in the current share basis. */
  costPerShare: number;
}

export interface DayValue {
  date: string;
  cash: number;
  holdings: number;
  value: number;
  /** Net external flow that day: deposits (including implicit ones) minus withdrawals. */
  flow: number;
  /** Cash the ledger was short at the end of the day, treated as a deposit. */
  implicitDeposit: number;
  /** Return for the day, with flows counted at the start of the day. */
  dailyReturn: number;
  /** Growth of 1 since the first day (time-weighted). */
  index: number;
}

export interface Position {
  securityId: string;
  quantity: number;
  costBasis: number;
  /** Latest close on or before the end date; null when there is none. */
  price: number | null;
  priceDate: string | null;
  /** Quantity × price, or the cost basis when there is no price. */
  marketValue: number;
  unrealized: number;
  /** Share of the portfolio's value, cash included. */
  weight: number;
}

export interface PortfolioReport {
  start: string | null;
  end: string;
  days: DayValue[];
  positions: Position[];
  cash: number;
  value: number;
  /** Deposits (including implicit ones) minus withdrawals. */
  netContributions: number;
  /** Time-weighted return since the first transaction. */
  twr: number | null;
  /** Annualized TWR; null for periods shorter than a year. */
  twrAnnualized: number | null;
  /** Money-weighted return (XIRR, annualized); null when it cannot be solved. */
  xirr: number | null;
  /** Largest peak-to-trough fall of the time-weighted index, as a positive fraction. */
  maxDrawdown: number | null;
  realized: number;
  unrealized: number;
  dividends: number;
  fees: number;
  warnings: string[];
}
