import { day, money, percent } from "./format";
import type { AlertDefinition } from "./schema";

/** The latest end-of-day bar and the one before it, both in the latest bar's split basis. */
export interface LatestBar {
  date: string;
  close: number;
  prevDate: string | null;
  /** Previous close adjusted for any split between the two sessions; null without one. */
  prevClose: number | null;
}

export interface UpcomingEarnings {
  date: string;
  /** bmo, amc or dmh when the vendor says. */
  hour: string | null;
}

export interface EvaluationInput {
  ticker: string;
  bar: LatestBar | null;
  /** The next earnings date after `today`, if known. */
  earnings: UpcomingEarnings | null;
  /** The exchange-calendar date the evaluation runs on. */
  today: string;
  now: Date;
  lastFiredAt: Date | null;
  cooldownHours: number;
}

export type Evaluation =
  | { fire: false; reason: "no_data" | "not_met" | "cooldown" }
  | {
      fire: true;
      /**
       * Idempotency key stored as alert_events.bar_date: the bar's date for price conditions,
       * the report date for earnings, so each crossing or report fires at most once.
       */
      key: string;
      subject: string;
      text: string;
    };

const HOUR: Record<string, string> = {
  bmo: "before the open",
  amc: "after the close",
  dmh: "during market hours",
};

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Whether an alert fires (Phase 1 step I2). Pure: the worker supplies the data and records the
 * result. Price conditions fire on a crossing only, so a price that stays above a level fires
 * once, not every day; the cooldown then keeps a price hovering around the level from firing
 * repeatedly.
 */
export function evaluateAlert(def: AlertDefinition, input: EvaluationInput): Evaluation {
  const { ticker, bar } = input;
  let hit: { key: string; subject: string; text: string } | null = null;

  switch (def.kind) {
    case "price_above":
    case "price_below": {
      if (!bar || bar.prevClose === null) return { fire: false, reason: "no_data" };
      const level = def.params.price;
      const above = def.kind === "price_above";
      const crossed = above
        ? bar.prevClose <= level && bar.close > level
        : bar.prevClose >= level && bar.close < level;
      if (crossed) {
        const word = above ? "above" : "below";
        hit = {
          key: bar.date,
          subject: `${ticker} closed ${word} ${money(level)}`,
          text:
            `${ticker} closed at ${money(bar.close)} on ${day(bar.date)}, ${word} your level of ` +
            `${money(level)} (previous close ${money(bar.prevClose)}).`,
        };
      }
      break;
    }
    case "pct_move": {
      if (!bar || bar.prevClose === null || bar.prevClose <= 0) {
        return { fire: false, reason: "no_data" };
      }
      const change = bar.close / bar.prevClose - 1;
      const { pct, direction } = def.params;
      // A little tolerance so a move of exactly the threshold counts despite float rounding.
      const eps = 1e-12;
      const met =
        (direction !== "down" && change >= pct - eps) ||
        (direction !== "up" && change <= -pct + eps);
      if (met) {
        const verb = change >= 0 ? "rose" : "fell";
        hit = {
          key: bar.date,
          subject: `${ticker} ${verb} ${percent(change)} on ${day(bar.date)}`,
          text:
            `${ticker} ${verb} ${percent(change, 2)} on ${day(bar.date)}, closing at ` +
            `${money(bar.close)} (previous close ${money(bar.prevClose)}, split-adjusted). ` +
            `Your threshold: ${percent(pct)}.`,
        };
      }
      break;
    }
    case "earnings_upcoming": {
      const e = input.earnings;
      if (!e) return { fire: false, reason: "no_data" };
      if (e.date > input.today && e.date <= addDays(input.today, def.params.days)) {
        const when = e.hour && HOUR[e.hour] ? ` (${HOUR[e.hour]})` : "";
        hit = {
          key: e.date,
          subject: `${ticker} reports earnings on ${day(e.date)}`,
          text: `${ticker} is scheduled to report earnings on ${day(e.date)}${when}. Dates can move; check the calendar.`,
        };
      }
      break;
    }
  }

  if (!hit) return { fire: false, reason: "not_met" };
  if (
    input.lastFiredAt &&
    input.now.getTime() - input.lastFiredAt.getTime() < input.cooldownHours * 3_600_000
  ) {
    return { fire: false, reason: "cooldown" };
  }
  return { fire: true, ...hit };
}
