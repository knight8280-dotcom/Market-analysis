import "server-only";
import { marketDateOf } from "@market/calendar";

export const CALENDAR_TABS = ["earnings", "economic", "actions"] as const;
export type CalendarTab = (typeof CALENDAR_TABS)[number];

const DAY = 86_400_000;
const shift = (d: string, days: number) =>
  new Date(Date.parse(d) + days * DAY).toISOString().slice(0, 10);

/** The window each tab shows: upcoming for scheduled events, recent for corporate actions. */
export function calendarWindow(
  tab: CalendarTab,
  now: Date = new Date(),
): { from: string; to: string } {
  const today = marketDateOf(now);
  if (tab === "actions") return { from: shift(today, -60), to: today };
  if (tab === "earnings") return { from: shift(today, -14), to: shift(today, 60) };
  return { from: shift(today, -7), to: shift(today, 45) };
}
