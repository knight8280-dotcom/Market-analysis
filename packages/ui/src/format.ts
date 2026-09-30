/**
 * Number and date formatting for display. Inputs come from the database as strings or numbers;
 * a missing value renders as an em dash, never as 0.
 */
export const MISSING = "—";

type Num = number | string | null | undefined;

function toNumber(value: Num): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatPrice(value: Num, currency = "USD"): string {
  const n = toNumber(value);
  if (n === null) return MISSING;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : 2,
  }).format(n);
}

export function formatNumber(value: Num, digits = 2): string {
  const n = toNumber(value);
  if (n === null) return MISSING;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

/** A fraction (0.0123) as a signed percentage ("+1.23%"). */
export function formatPercent(fraction: Num, digits = 2): string {
  const n = toNumber(fraction);
  if (n === null) return MISSING;
  const s = new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: "exceptZero",
  }).format(n);
  // Intl uses a hyphen-minus; a real minus sign reads better and aligns with "+".
  return s.replace("-", "−");
}

/** 1234567 → "1.23M"; for volumes and market caps. */
export function formatCompact(value: Num): string {
  const n = toNumber(value);
  if (n === null) return MISSING;
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
}

/** "2026-09-29" → "Sep 29, 2026". Calendar dates are formatted without a time zone shift. */
export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return MISSING;
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** An instant in exchange time: "Sep 29, 2026, 4:31 PM ET". */
export function formatDateTimeET(at: Date | string | null | undefined): string {
  if (!at) return MISSING;
  const date = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return MISSING;
  return `${new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(date)} ET`;
}
