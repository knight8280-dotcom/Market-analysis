import type { IsoDate } from "@market/calendar";
import type { CorporateActionType } from "./types";

/**
 * Split and dividend adjustment factors (spec §3.2, §3.7). Raw prices are never modified; the
 * factors are stored as a sparse step function in market.adjustment_factors and applied on read.
 *
 * For each ex-date e:
 * - splits and stock dividends with ratio r (new shares per old share) scale earlier prices by
 *   1/r and earlier volumes by r;
 * - a cash dividend D scales earlier prices by (1 - D / C), where C is the raw close on the
 *   previous trading day, converted to post-split units when a split shares the ex-date.
 * Row (e) holds the product of the factors of every action with ex_date >= e; a bar dated d uses
 * the row with the smallest ex_date > d (none: factor 1).
 *
 * Spin-offs and mergers are stored but not price-adjusted: that needs the value of the
 * distributed entity, which we do not have, and approximating it would fabricate data.
 */

export interface AdjustableAction {
  type: CorporateActionType;
  ex_date: IsoDate;
  ratio: number | null;
  cash_amount: number | null;
}

export interface FactorRow {
  ex_date: IsoDate;
  split_factor: number;
  dividend_factor: number;
}

export interface AdjustmentIssue {
  rule: "dividend_prev_close_missing" | "dividend_exceeds_price" | "action_not_adjusted";
  ex_date: IsoDate;
  message: string;
}

export function computeAdjustmentFactors(
  actions: readonly AdjustableAction[],
  rawCloseBefore: (exDate: IsoDate) => number | null,
): { factors: FactorRow[]; issues: AdjustmentIssue[] } {
  const issues: AdjustmentIssue[] = [];
  const perDate = new Map<IsoDate, { ratio: number; cash: number }>();
  const entry = (d: IsoDate) => {
    let e = perDate.get(d);
    if (!e) {
      e = { ratio: 1, cash: 0 };
      perDate.set(d, e);
    }
    return e;
  };

  for (const a of actions) {
    switch (a.type) {
      case "split":
      case "stock_dividend":
        if (a.ratio !== null && a.ratio > 0) entry(a.ex_date).ratio *= a.ratio;
        break;
      case "cash_dividend":
      case "special_dividend":
        if (a.cash_amount !== null && a.cash_amount > 0) entry(a.ex_date).cash += a.cash_amount;
        break;
      case "spin_off":
      case "merger":
        issues.push({
          rule: "action_not_adjusted",
          ex_date: a.ex_date,
          message: `${a.type} is stored but prices are not adjusted for it`,
        });
        break;
      case "symbol_change":
        break;
    }
  }

  const perDateFactors: { ex_date: IsoDate; split: number; dividend: number }[] = [];
  for (const [exDate, { ratio, cash }] of perDate) {
    let dividend = 1;
    if (cash > 0) {
      const close = rawCloseBefore(exDate);
      if (close === null || !(close > 0)) {
        issues.push({
          rule: "dividend_prev_close_missing",
          ex_date: exDate,
          message: "no raw close on the previous trading day; dividend not applied",
        });
      } else {
        const f = 1 - cash / (close / ratio);
        if (f > 0) {
          dividend = f;
        } else {
          issues.push({
            rule: "dividend_exceeds_price",
            ex_date: exDate,
            message: `dividend ${cash} is not below the previous close ${close}; not applied`,
          });
        }
      }
    }
    if (ratio !== 1 || dividend !== 1)
      perDateFactors.push({ ex_date: exDate, split: 1 / ratio, dividend });
  }

  perDateFactors.sort((a, b) => b.ex_date.localeCompare(a.ex_date));
  const factors: FactorRow[] = [];
  let split = 1;
  let dividend = 1;
  for (const f of perDateFactors) {
    split *= f.split;
    dividend *= f.dividend;
    factors.push({ ex_date: f.ex_date, split_factor: split, dividend_factor: dividend });
  }
  factors.reverse();
  return { factors, issues };
}

/** The factors that apply to a bar dated `date` (rows sorted by ex_date ascending). */
export function factorFor(
  date: IsoDate,
  rows: readonly FactorRow[],
): { split: number; dividend: number } {
  const row = rows.find((r) => r.ex_date > date);
  return row
    ? { split: row.split_factor, dividend: row.dividend_factor }
    : { split: 1, dividend: 1 };
}
