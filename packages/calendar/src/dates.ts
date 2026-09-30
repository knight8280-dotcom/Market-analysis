/** Calendar-date helpers on ISO "YYYY-MM-DD" strings. All arithmetic is done in UTC. */

export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export const Weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;

export function parseIsoDate(date: IsoDate): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(date);
  if (!match) throw new TypeError(`Expected a YYYY-MM-DD date, got "${date}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const back = new Date(Date.UTC(year, month - 1, day));
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    throw new TypeError(`Not a real calendar date: "${date}"`);
  }
  return { year, month, day };
}

export function isoDate(year: number, month: number, day: number): IsoDate {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function toUtcMs(date: IsoDate): number {
  const { year, month, day } = parseIsoDate(date);
  return Date.UTC(year, month - 1, day);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(toUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function weekday(date: IsoDate): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const d = weekday(date);
  return d === Weekday.Sat || d === Weekday.Sun;
}

/** The n-th (1-based) given weekday of a month, e.g. the 3rd Monday of January. */
export function nthWeekday(year: number, month: number, day: number, n: number): IsoDate {
  const first = isoDate(year, month, 1);
  const offset = (day - weekday(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

/** The last given weekday of a month, e.g. the last Monday of May. */
export function lastWeekday(year: number, month: number, day: number): IsoDate {
  const last = addDays(isoDate(year, month + 1, 1), -1);
  const offset = (weekday(last) - day + 7) % 7;
  return addDays(last, -offset);
}

/** Western (Gregorian) Easter Sunday: the anonymous Meeus/Jones/Butcher algorithm. */
export function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(year, month, day);
}
