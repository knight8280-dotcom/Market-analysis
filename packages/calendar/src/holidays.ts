import {
  addDays,
  easterSunday,
  isoDate,
  lastWeekday,
  nthWeekday,
  parseIsoDate,
  weekday,
  Weekday,
  type IsoDate,
} from "./dates";

/**
 * NYSE/Nasdaq full-day closures and 1:00 p.m. early closes (spec §3.7).
 *
 * Regular holidays follow NYSE's observance rules. Unscheduled closures (national days of
 * mourning, emergencies) cannot be derived, so they are listed explicitly. Rules were checked
 * against NYSE's published schedule for 2024-2028 (test/fixtures/nyse-published.json); re-check
 * each year when NYSE publishes a new year, and add any new unscheduled closure here.
 */

export const CALENDAR_FIRST_YEAR = 2000;
export const CALENDAR_LAST_YEAR = 2030;

export interface MarketHoliday {
  date: IsoDate;
  name: string;
}

export interface EarlyClose {
  date: IsoDate;
  reason: string;
}

/** Unscheduled full-day closures since 2000. */
export const SPECIAL_CLOSURES: readonly MarketHoliday[] = [
  { date: "2001-09-11", name: "September 11 attacks" },
  { date: "2001-09-12", name: "September 11 attacks" },
  { date: "2001-09-13", name: "September 11 attacks" },
  { date: "2001-09-14", name: "September 11 attacks" },
  { date: "2004-06-11", name: "National Day of Mourning for President Reagan" },
  { date: "2007-01-02", name: "National Day of Mourning for President Ford" },
  { date: "2012-10-29", name: "Hurricane Sandy" },
  { date: "2012-10-30", name: "Hurricane Sandy" },
  { date: "2018-12-05", name: "National Day of Mourning for President George H.W. Bush" },
  { date: "2025-01-09", name: "National Day of Mourning for President Carter" },
];

export function assertSupportedYear(year: number): void {
  if (!Number.isInteger(year) || year < CALENDAR_FIRST_YEAR || year > CALENDAR_LAST_YEAR) {
    throw new RangeError(
      `Market calendar covers ${CALENDAR_FIRST_YEAR}-${CALENDAR_LAST_YEAR}; got ${year}`,
    );
  }
}

/** Saturday holidays move to Friday, Sunday holidays to Monday. */
function observed(date: IsoDate): IsoDate {
  const d = weekday(date);
  if (d === Weekday.Sat) return addDays(date, -1);
  if (d === Weekday.Sun) return addDays(date, 1);
  return date;
}

const holidayCache = new Map<number, MarketHoliday[]>();

export function holidaysForYear(year: number): MarketHoliday[] {
  assertSupportedYear(year);
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const list: MarketHoliday[] = [];
  // NYSE does not close on Friday, December 31 when New Year's Day falls on a Saturday.
  const newYear = isoDate(year, 1, 1);
  if (weekday(newYear) !== Weekday.Sat)
    list.push({ date: observed(newYear), name: "New Year's Day" });
  list.push({ date: nthWeekday(year, 1, Weekday.Mon, 3), name: "Martin Luther King, Jr. Day" });
  list.push({ date: nthWeekday(year, 2, Weekday.Mon, 3), name: "Washington's Birthday" });
  list.push({ date: addDays(easterSunday(year), -2), name: "Good Friday" });
  list.push({ date: lastWeekday(year, 5, Weekday.Mon), name: "Memorial Day" });
  if (year >= 2022) {
    list.push({
      date: observed(isoDate(year, 6, 19)),
      name: "Juneteenth National Independence Day",
    });
  }
  list.push({ date: observed(isoDate(year, 7, 4)), name: "Independence Day" });
  list.push({ date: nthWeekday(year, 9, Weekday.Mon, 1), name: "Labor Day" });
  list.push({ date: nthWeekday(year, 11, Weekday.Thu, 4), name: "Thanksgiving Day" });
  list.push({ date: observed(isoDate(year, 12, 25)), name: "Christmas Day" });
  for (const special of SPECIAL_CLOSURES) {
    if (parseIsoDate(special.date).year === year) list.push(special);
  }
  list.sort((a, b) => a.date.localeCompare(b.date));
  holidayCache.set(year, list);
  return list;
}

const earlyCloseCache = new Map<number, EarlyClose[]>();

export function earlyClosesForYear(year: number): EarlyClose[] {
  assertSupportedYear(year);
  const cached = earlyCloseCache.get(year);
  if (cached) return cached;

  const list: EarlyClose[] = [];
  // Before Independence Day: July 3 when it falls on Mon, Tue or Thu; on Wed only from 2013.
  // Before 2013, a Thursday July 4 moved the early close to Friday July 5 instead.
  const july3 = isoDate(year, 7, 3);
  const d3 = weekday(july3);
  if (d3 === Weekday.Mon || d3 === Weekday.Tue || d3 === Weekday.Thu) {
    list.push({ date: july3, reason: "Day before Independence Day" });
  } else if (d3 === Weekday.Wed) {
    if (year >= 2013) list.push({ date: july3, reason: "Day before Independence Day" });
    else list.push({ date: isoDate(year, 7, 5), reason: "Day after Independence Day" });
  }
  list.push({
    date: addDays(nthWeekday(year, 11, Weekday.Thu, 4), 1),
    reason: "Day after Thanksgiving",
  });
  const christmasEve = isoDate(year, 12, 24);
  const d24 = weekday(christmasEve);
  if (d24 >= Weekday.Mon && d24 <= Weekday.Thu) {
    list.push({ date: christmasEve, reason: "Christmas Eve" });
  }
  earlyCloseCache.set(year, list);
  return list;
}

export function holidayOn(date: IsoDate): MarketHoliday | null {
  return holidaysForYear(parseIsoDate(date).year).find((h) => h.date === date) ?? null;
}

export function earlyCloseOn(date: IsoDate): EarlyClose | null {
  return earlyClosesForYear(parseIsoDate(date).year).find((e) => e.date === date) ?? null;
}
