import { SECTORS } from "@market/market-data/sectors";

/**
 * Screenable fields: columns of market.screener_snapshot, plus a few computed ones. Only these
 * names can reach SQL; user input never becomes an identifier.
 */
export type FieldType = "number" | "text" | "enum";
export type FieldFormat = "price" | "percent" | "ratio" | "compact" | "number" | "text";

export interface FieldDef {
  label: string;
  type: FieldType;
  format: FieldFormat;
  group: "Descriptive" | "Performance" | "Technical" | "Valuation";
  /** For enums: the allowed values. */
  values?: readonly string[];
  /** A computed field: SQL over snapshot columns, and the same formula for the test oracle. */
  computed?: { sql: string; from: (row: SnapshotRow) => number | null };
  help?: string;
}

/** A snapshot row as the oracle sees it (numbers as JS numbers, NULL as null). */
export type SnapshotRow = Record<string, number | string | null>;

const num = (v: number | string | null | undefined) =>
  v === null || v === undefined ? null : Number(v);

export const FIELDS = {
  ticker: { label: "Ticker", type: "text", format: "text", group: "Descriptive" },
  name: { label: "Name", type: "text", format: "text", group: "Descriptive" },
  sector: {
    label: "Sector (SEC SIC)",
    type: "enum",
    format: "text",
    group: "Descriptive",
    values: SECTORS,
  },
  asset_class: {
    label: "Asset class",
    type: "enum",
    format: "text",
    group: "Descriptive",
    values: ["equity", "etf", "adr", "fund", "index"],
  },
  close: { label: "Price", type: "number", format: "price", group: "Descriptive" },
  market_cap: { label: "Market cap", type: "number", format: "compact", group: "Descriptive" },
  avg_volume_30d: {
    label: "Avg volume (30d)",
    type: "number",
    format: "compact",
    group: "Descriptive",
  },
  change_1d: { label: "Change (1D)", type: "number", format: "percent", group: "Performance" },
  return_1w: { label: "Return (1W)", type: "number", format: "percent", group: "Performance" },
  return_1m: { label: "Return (1M)", type: "number", format: "percent", group: "Performance" },
  return_3m: { label: "Return (3M)", type: "number", format: "percent", group: "Performance" },
  return_6m: { label: "Return (6M)", type: "number", format: "percent", group: "Performance" },
  return_ytd: { label: "Return (YTD)", type: "number", format: "percent", group: "Performance" },
  return_1y: { label: "Return (1Y)", type: "number", format: "percent", group: "Performance" },
  sma50: { label: "SMA 50", type: "number", format: "price", group: "Technical" },
  sma200: { label: "SMA 200", type: "number", format: "price", group: "Technical" },
  rsi14: { label: "RSI 14", type: "number", format: "number", group: "Technical" },
  high_52w: { label: "52-week high", type: "number", format: "price", group: "Technical" },
  low_52w: { label: "52-week low", type: "number", format: "price", group: "Technical" },
  pct_from_high_52w: {
    label: "From 52-week high",
    type: "number",
    format: "percent",
    group: "Technical",
    computed: {
      sql: "close::float8 / nullif(high_52w, 0) - 1",
      from: (r) => {
        const c = num(r.close);
        const h = num(r.high_52w);
        return c === null || h === null || h === 0 ? null : c / h - 1;
      },
    },
    help: "0% at the high, −10% ten percent below it.",
  },
  pct_from_sma200: {
    label: "From SMA 200",
    type: "number",
    format: "percent",
    group: "Technical",
    computed: {
      sql: "close::float8 / nullif(sma200, 0) - 1",
      from: (r) => {
        const c = num(r.close);
        const s = num(r.sma200);
        return c === null || s === null || s === 0 ? null : c / s - 1;
      },
    },
  },
  pe: { label: "P/E (TTM)", type: "number", format: "ratio", group: "Valuation" },
  ps: { label: "P/S (TTM)", type: "number", format: "ratio", group: "Valuation" },
  pb: { label: "P/B", type: "number", format: "ratio", group: "Valuation" },
  dividend_yield: {
    label: "Dividend yield (TTM)",
    type: "number",
    format: "percent",
    group: "Valuation",
  },
} as const satisfies Record<string, FieldDef>;

export type FieldId = keyof typeof FIELDS;
export const FIELD_IDS = Object.keys(FIELDS) as FieldId[];

export function fieldDef(id: FieldId): FieldDef {
  return FIELDS[id];
}

/** The value of a field on a row (computed fields included), for the oracle and the UI. */
export function fieldValue(row: SnapshotRow, id: FieldId): number | string | null {
  const def = fieldDef(id);
  if (def.computed) return def.computed.from(row);
  const v = row[id];
  if (v === null || v === undefined) return null;
  return def.type === "number" ? Number(v) : v;
}
