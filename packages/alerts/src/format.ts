import type { AlertDefinition } from "./schema";

/** Formatting without the UI package, so the worker's emails match the app. Prices keep up to
 * four decimals, so a level of $2.705 reads as entered. */
export function money(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(n);
}

/** A fraction as an unsigned percentage: 0.052 → "5.2%". */
export function percent(fraction: number, digits = 1): string {
  return `${(Math.abs(fraction) * 100).toFixed(digits)}%`;
}

/** "2026-09-29" → "Sep 29, 2026", without a time zone shift. */
export function day(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, d)));
}

const DIRECTION = { up: "up", down: "down", either: "up or down" } as const;

/** The condition in words, for lists and forms: "Closes above $200.00". */
export function describeAlert(def: AlertDefinition): string {
  switch (def.kind) {
    case "price_above":
      return `Closes above ${money(def.params.price)}`;
    case "price_below":
      return `Closes below ${money(def.params.price)}`;
    case "pct_move":
      return `Moves ${percent(def.params.pct)} or more in a day (${DIRECTION[def.params.direction]})`;
    case "earnings_upcoming":
      return `Earnings within ${def.params.days} ${def.params.days === 1 ? "day" : "days"}`;
  }
}
