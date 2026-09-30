import type { IsoDate } from "@market/calendar";
import type { DailyBar } from "./types";

/**
 * Ingest validation rules for daily bars (spec §3.7). Bars are rejected or flagged, never
 * repaired: a rejected bar is simply missing ("Data unavailable"), per MUST-NOT #1.
 */

export type QualityRule =
  | "non_positive_price"
  | "ohlc_inconsistent"
  | "negative_volume"
  | "non_integer_volume"
  | "duplicate_bar"
  | "conflicting_duplicate_bar"
  | "large_move_without_action"
  | "non_trading_day";

export interface QualityIssue {
  rule: QualityRule;
  severity: "info" | "warning" | "error";
  action: "rejected" | "flagged" | "skipped";
  source_symbol: string;
  date: IsoDate;
  message: string;
  payload: Record<string, unknown>;
}

export interface BarValidationContext {
  /** Last stored close before the first bar in this batch, if any. */
  previousClose: number | null;
  /** Ex-dates of corporate actions for this security (a big move on these days is expected). */
  actionDates: ReadonlySet<IsoDate>;
  isTradingDay: (date: IsoDate) => boolean;
  /** Relative close-to-close move that gets flagged without a corporate action (default 0.5). */
  largeMoveThreshold?: number;
}

export interface BarValidationResult {
  accepted: DailyBar[];
  issues: QualityIssue[];
}

function sameValues(a: DailyBar, b: DailyBar): boolean {
  return (
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume &&
    a.vwap === b.vwap
  );
}

function values(bar: DailyBar): Record<string, unknown> {
  const { open, high, low, close, volume, vwap } = bar;
  return { open, high, low, close, volume, vwap };
}

/** Bars for one security from one source. */
export function validateDailyBars(
  bars: readonly DailyBar[],
  ctx: BarValidationContext,
): BarValidationResult {
  const threshold = ctx.largeMoveThreshold ?? 0.5;
  const issues: QualityIssue[] = [];
  const issue = (
    bar: DailyBar,
    rule: QualityRule,
    fields: Omit<QualityIssue, "rule" | "source_symbol" | "date">,
  ) => issues.push({ rule, source_symbol: bar.source_symbol, date: bar.date, ...fields });

  // Duplicates: identical copies collapse to one; conflicting copies are all rejected, because
  // we cannot know which one is right.
  const byDate = new Map<IsoDate, DailyBar[]>();
  for (const bar of bars) {
    const list = byDate.get(bar.date);
    if (list) list.push(bar);
    else byDate.set(bar.date, [bar]);
  }
  const unique: DailyBar[] = [];
  for (const [date, list] of byDate) {
    const first = list[0]!;
    if (list.length === 1) {
      unique.push(first);
    } else if (list.every((b) => sameValues(b, first))) {
      unique.push(first);
      issue(first, "duplicate_bar", {
        severity: "info",
        action: "skipped",
        message: `${list.length} identical bars for ${date}; kept one`,
        payload: { copies: list.length },
      });
    } else {
      issue(first, "conflicting_duplicate_bar", {
        severity: "error",
        action: "rejected",
        message: `${list.length} different bars for ${date}; all rejected`,
        payload: { bars: list.map(values) },
      });
    }
  }
  unique.sort((a, b) => a.date.localeCompare(b.date));

  const accepted: DailyBar[] = [];
  let previousClose = ctx.previousClose;
  for (const bar of unique) {
    const { open, high, low, close, volume } = bar;
    if (!(open > 0 && high > 0 && low > 0 && close > 0) || (bar.vwap !== null && !(bar.vwap > 0))) {
      issue(bar, "non_positive_price", {
        severity: "error",
        action: "rejected",
        message: "prices must be positive",
        payload: values(bar),
      });
      continue;
    }
    if (!(low <= Math.min(open, close) && high >= Math.max(open, close))) {
      issue(bar, "ohlc_inconsistent", {
        severity: "error",
        action: "rejected",
        message: "expected low <= open, close <= high",
        payload: values(bar),
      });
      continue;
    }
    if (volume < 0) {
      issue(bar, "negative_volume", {
        severity: "error",
        action: "rejected",
        message: "volume must not be negative",
        payload: values(bar),
      });
      continue;
    }
    if (!Number.isSafeInteger(volume)) {
      issue(bar, "non_integer_volume", {
        severity: "error",
        action: "rejected",
        message: "raw volume must be a whole number of shares",
        payload: values(bar),
      });
      continue;
    }
    if (!ctx.isTradingDay(bar.date)) {
      issue(bar, "non_trading_day", {
        severity: "warning",
        action: "flagged",
        message: `bar dated ${bar.date}, which the market calendar says was closed`,
        payload: values(bar),
      });
    }
    if (previousClose !== null && !ctx.actionDates.has(bar.date)) {
      const move = close / previousClose - 1;
      if (Math.abs(move) > threshold) {
        issue(bar, "large_move_without_action", {
          severity: "warning",
          action: "flagged",
          message: `close moved ${(move * 100).toFixed(1)}% with no corporate action on file`,
          payload: { previous_close: previousClose, close, move },
        });
      }
    }
    accepted.push(bar);
    previousClose = close;
  }
  return { accepted, issues };
}
