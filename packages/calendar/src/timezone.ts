import { parseIsoDate, type IsoDate } from "./dates";

/** The exchange time zone. Storage is always UTC; this is only for session times and display. */
export const MARKET_TIME_ZONE = "America/New_York";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(instant: Date, timeZone: string = MARKET_TIME_ZONE): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? NaN,
    month: parts.month ?? NaN,
    day: parts.day ?? NaN,
    hour: parts.hour ?? NaN,
    minute: parts.minute ?? NaN,
    second: parts.second ?? NaN,
  };
}

/** UTC offset of `timeZone` at `instant`, in minutes (e.g. -240 for New York in summer). */
export function offsetMinutes(instant: Date, timeZone: string = MARKET_TIME_ZONE): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** The instant at which the wall clock in `timeZone` reads `date` `time` ("HH:MM"). */
export function zonedTimeToUtc(
  date: IsoDate,
  time: string,
  timeZone: string = MARKET_TIME_ZONE,
): Date {
  const { year, month, day } = parseIsoDate(date);
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new TypeError(`Expected HH:MM, got "${time}"`);
  const guess = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]));
  const first = offsetMinutes(new Date(guess), timeZone);
  const candidate = guess - first * 60_000;
  const second = offsetMinutes(new Date(candidate), timeZone);
  return new Date(second === first ? candidate : guess - second * 60_000);
}

/** The calendar date in `timeZone` at `instant`. */
export function zonedDate(instant: Date, timeZone: string = MARKET_TIME_ZONE): IsoDate {
  const p = zonedParts(instant, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
