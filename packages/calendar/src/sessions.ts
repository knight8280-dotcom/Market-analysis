import { addDays, isWeekend, parseIsoDate, type IsoDate } from "./dates";
import { assertSupportedYear, earlyCloseOn, holidayOn } from "./holidays";
import { MARKET_TIME_ZONE, zonedDate, zonedTimeToUtc } from "./timezone";

export const REGULAR_OPEN = "09:30";
export const REGULAR_CLOSE = "16:00";
export const EARLY_CLOSE = "13:00";

export interface Session {
  /** Trading date in the exchange time zone. */
  date: IsoDate;
  open: Date;
  close: Date;
  earlyClose: boolean;
}

export function isTradingDay(date: IsoDate): boolean {
  assertSupportedYear(parseIsoDate(date).year);
  return !isWeekend(date) && holidayOn(date) === null;
}

/** Regular-hours session for `date`, or null when the market is closed that day. */
export function sessionFor(date: IsoDate): Session | null {
  if (!isTradingDay(date)) return null;
  const early = earlyCloseOn(date) !== null;
  return {
    date,
    open: zonedTimeToUtc(date, REGULAR_OPEN, MARKET_TIME_ZONE),
    close: zonedTimeToUtc(date, early ? EARLY_CLOSE : REGULAR_CLOSE, MARKET_TIME_ZONE),
    earlyClose: early,
  };
}

export function nextTradingDay(date: IsoDate): IsoDate {
  let d = addDays(date, 1);
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}

export function previousTradingDay(date: IsoDate): IsoDate {
  let d = addDays(date, -1);
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

/** Trading days from `start` to `end`, both inclusive. */
export function tradingDaysBetween(start: IsoDate, end: IsoDate): IsoDate[] {
  const days: IsoDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (isTradingDay(d)) days.push(d);
  }
  return days;
}

/** The exchange-local calendar date at `instant`. */
export function marketDateOf(instant: Date): IsoDate {
  return zonedDate(instant, MARKET_TIME_ZONE);
}

export type MarketStatus = "open" | "pre_open" | "after_close" | "closed_day";

export function marketStatusAt(instant: Date): MarketStatus {
  const session = sessionFor(marketDateOf(instant));
  if (!session) return "closed_day";
  if (instant < session.open) return "pre_open";
  if (instant >= session.close) return "after_close";
  return "open";
}

/** The most recent session that has already closed at `instant`. */
export function latestClosedSession(instant: Date): Session {
  return latestSessionWhere(instant, (session) => session.close);
}

/**
 * The most recent session whose date, at wall-clock `time` in the exchange time zone, is at or
 * before `instant`. `latestSessionDueBy(now, "18:30")` answers "which day's EOD bars must be
 * loaded by now?" for the 6:30 p.m. ET freshness SLO, including on early-close days.
 */
export function latestSessionDueBy(instant: Date, time: string): Session {
  return latestSessionWhere(instant, (session) =>
    zonedTimeToUtc(session.date, time, MARKET_TIME_ZONE),
  );
}

function latestSessionWhere(instant: Date, deadline: (session: Session) => Date): Session {
  let date = marketDateOf(instant);
  for (;;) {
    const session = sessionFor(date);
    if (session && deadline(session).getTime() <= instant.getTime()) return session;
    date = addDays(date, -1);
  }
}
