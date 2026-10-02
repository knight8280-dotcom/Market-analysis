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

/** A level or multiple as entered: 30 → "30", 27.5 → "27.5", 1/3 → "0.33". */
export function plain(n: number, digits = 2): string {
  return String(Number(n.toFixed(digits)));
}

/** Share counts and other large numbers: 12_345_678 → "12.3M". */
export function compact(n: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
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

/** An instant in exchange time: "Sep 30, 2026, 4:05 PM ET". */
export function dateTimeET(at: Date): string {
  const text = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(at);
  // Some ICU versions put a narrow no-break space before AM/PM; plain text reads better.
  return `${text.replace(/\u202f/g, " ")} ET`;
}

/** EDGAR form names read better with "Form" before a bare number: "4" → "Form 4". */
export function formName(form: string): string {
  return /^\d/.test(form) && !form.includes("-") ? `Form ${form}` : form;
}

/** A short, stable fingerprint of a string (32-bit FNV-1a, hex). Not for security. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Fingerprint of a parsed screen's conditions (zod output has a fixed key order). A screen alert
 * starts a new comparison when its screen's conditions change; the sort order does not matter.
 */
export function screenFingerprint(screen: { conditions: unknown }): string {
  return fingerprint(JSON.stringify(screen.conditions));
}

const DIRECTION = { up: "up", down: "down", either: "up or down" } as const;
const CHANGE = { enters: "enters", leaves: "leaves", either: "enters or leaves" } as const;

/** The condition in words, for lists and forms: "Closes above $200.00". */
export function describeAlert(def: AlertDefinition, context: { screenName?: string } = {}): string {
  switch (def.kind) {
    case "price_above":
      return `Closes above ${money(def.params.price)}`;
    case "price_below":
      return `Closes below ${money(def.params.price)}`;
    case "pct_move":
      return `Moves ${percent(def.params.pct)} or more in a day (${DIRECTION[def.params.direction]})`;
    case "earnings_upcoming":
      return `Earnings within ${def.params.days} ${def.params.days === 1 ? "day" : "days"}`;
    case "rsi_below":
    case "rsi_above":
      return `RSI(${def.params.period}) crosses ${def.kind === "rsi_below" ? "below" : "above"} ${plain(def.params.level)}`;
    case "sma_cross": {
      const { fast, slow, direction } = def.params;
      return fast === 1
        ? `Close crosses ${direction} its ${slow}-day average`
        : `${fast}-day average crosses ${direction} the ${slow}-day average`;
    }
    case "volume_spike":
      return `Volume at least ${plain(def.params.multiple)}× its ${def.params.lookback}-day average`;
    case "new_filing":
      return `New filing: ${def.params.forms.map(formName).join(", ")}${def.params.amendments ? " (amendments too)" : ""}`;
    case "insider_purchase":
      return def.params.minValue > 0
        ? `An insider buys at least ${money(def.params.minValue).replace(/\.00$/, "")} on the open market (Form 4)`
        : "An insider buys on the open market (Form 4)";
    case "screen_membership": {
      const screen = context.screenName ? `“${context.screenName}”` : "the screen";
      return `A security ${CHANGE[def.params.change]} ${screen}`;
    }
  }
}
