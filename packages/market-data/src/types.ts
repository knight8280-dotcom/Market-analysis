import { z } from "zod";

/**
 * Canonical record types. Every adapter maps vendor payloads to these shapes and validates them
 * with zod, so nothing downstream depends on a vendor's format. Field names are snake_case to
 * match the database columns they are stored in.
 */

export const PROVIDER_IDS = [
  "synthetic",
  "tiingo",
  "twelvedata",
  "massive",
  "sec_edgar",
  "fred",
  "treasury",
] as const;
export const ProviderId = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderId>;

export const DATASETS = [
  "securities",
  "daily_bars",
  "corporate_actions",
  "fundamentals",
  "filings",
  "macro",
] as const;
export const Dataset = z.enum(DATASETS);
export type Dataset = z.infer<typeof Dataset>;

/**
 * What a record may be used for, stamped on every record:
 * - synthetic: generated test data, never shown in production;
 * - public_domain: government data (EDGAR, FRED public-domain series, Treasury);
 * - personal_dev: a personal-plan vendor key; the developer only, never displayed to anyone else;
 * - display_delayed / display_realtime: covered by a signed display/redistribution license.
 */
export const LICENSE_TIERS = [
  "synthetic",
  "public_domain",
  "personal_dev",
  "display_delayed",
  "display_realtime",
] as const;
export const LicenseTier = z.enum(LICENSE_TIERS);
export type LicenseTier = z.infer<typeof LicenseTier>;

export const ASSET_CLASSES = [
  "equity",
  "etf",
  "fund",
  "adr",
  "preferred",
  "warrant",
  "right",
  "unit",
  "index",
  "option",
  "crypto",
  "fx",
  "future",
] as const;
export const AssetClass = z.enum(ASSET_CLASSES);
export type AssetClass = z.infer<typeof AssetClass>;

export const IsoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const Cik = z.string().regex(/^\d{10}$/, "must be a 10-digit CIK");
const AccessionNo = z.string().regex(/^\d{10}-\d{2}-\d{6}$/, "must look like 0000320193-24-000123");
const finite = z.number().finite();

/** Provenance carried by every record (spec §2.1). */
export const Provenance = z.object({
  source: ProviderId,
  /** The identifier the vendor used for this record: ticker, CIK or series id. */
  source_symbol: z.string().min(1).nullable(),
  fetched_at: z.date(),
  /** When the value was true in the world: session close, filing date, observation date. */
  as_of: z.date(),
  license_tier: LicenseTier,
});
export type Provenance = z.infer<typeof Provenance>;

export const SymbolPeriod = z.object({
  ticker: z.string().min(1),
  valid_from: IsoDateString,
  /** Exclusive; null while current. */
  valid_to: IsoDateString.nullable(),
});
export type SymbolPeriod = z.infer<typeof SymbolPeriod>;

export const SecurityRecord = Provenance.extend({
  /** Vendor's permanent id when it has one; lets us tell reused tickers apart. */
  source_security_id: z.string().min(1).nullable(),
  ticker: z.string().min(1),
  name: z.string().min(1),
  asset_class: AssetClass,
  exchange_mic: z
    .string()
    .regex(/^[A-Z0-9]{4}$/)
    .nullable(),
  cik: Cik.nullable(),
  figi: z
    .string()
    .regex(/^[A-Z0-9]{12}$/)
    .nullable(),
  sector: z.string().min(1).nullable(),
  industry: z.string().min(1).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  listed_at: IsoDateString.nullable(),
  delisted_at: IsoDateString.nullable(),
  /** Exchange ticker history, oldest first. Empty when the vendor does not provide it. */
  symbol_history: z.array(SymbolPeriod),
});
export type SecurityRecord = z.infer<typeof SecurityRecord>;

/**
 * A raw (unadjusted) daily bar. Numeric fields are only type-checked here; the ingest validator
 * applies the business rules (OHLC consistency, positive prices, volume) so each failure is
 * reported under its own rule name instead of a generic parse error.
 */
export const DailyBar = Provenance.extend({
  source_symbol: z.string().min(1),
  date: IsoDateString,
  open: finite,
  high: finite,
  low: finite,
  close: finite,
  volume: finite,
  vwap: finite.nullable(),
});
export type DailyBar = z.infer<typeof DailyBar>;

export const CORPORATE_ACTION_TYPES = [
  "split",
  "cash_dividend",
  "special_dividend",
  "stock_dividend",
  "spin_off",
  "symbol_change",
  "merger",
] as const;
export const CorporateActionType = z.enum(CORPORATE_ACTION_TYPES);
export type CorporateActionType = z.infer<typeof CorporateActionType>;

export const CorporateAction = Provenance.extend({
  source_symbol: z.string().min(1),
  type: CorporateActionType,
  ex_date: IsoDateString,
  /** New shares per old share: 4 for 4:1, 0.1 for a 1:10 reverse split, 1.05 for a 5% stock dividend. */
  ratio: z.number().finite().positive().nullable(),
  cash_amount: z.number().finite().positive().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  record_date: IsoDateString.nullable(),
  pay_date: IsoDateString.nullable(),
  details: z.record(z.string(), z.unknown()),
}).superRefine((a, ctx) => {
  if ((a.type === "split" || a.type === "stock_dividend") && a.ratio === null) {
    ctx.addIssue({ code: "custom", path: ["ratio"], message: `${a.type} requires a ratio` });
  }
  if ((a.type === "cash_dividend" || a.type === "special_dividend") && a.cash_amount === null) {
    ctx.addIssue({
      code: "custom",
      path: ["cash_amount"],
      message: `${a.type} requires a cash_amount`,
    });
  }
});
export type CorporateAction = z.infer<typeof CorporateAction>;

export const FundamentalFact = Provenance.extend({
  cik: Cik,
  taxonomy: z.string().min(1),
  concept: z.string().min(1),
  unit: z.string().min(1),
  value: finite,
  period_start: IsoDateString.nullable(),
  period_end: IsoDateString,
  fiscal_year: z.number().int().nullable(),
  fiscal_period: z.string().min(1).nullable(),
  form: z.string().min(1),
  filed_at: IsoDateString,
  accession_no: AccessionNo,
  frame: z.string().min(1).nullable(),
});
export type FundamentalFact = z.infer<typeof FundamentalFact>;

export const FilingRecord = Provenance.extend({
  accession_no: AccessionNo,
  cik: Cik,
  form_type: z.string().min(1),
  /** Acceptance time: when the filing became public. */
  filed_at: z.date(),
  filing_date: IsoDateString,
  period: IsoDateString.nullable(),
  primary_document: z.string().min(1).nullable(),
  items: z.array(z.string()),
  url: z.url(),
});
export type FilingRecord = z.infer<typeof FilingRecord>;

export const MacroSeries = Provenance.extend({
  series_id: z.string().min(1),
  title: z.string().min(1),
  units: z.string().nullable(),
  frequency: z.string().nullable(),
  seasonal_adjustment: z.string().nullable(),
  last_updated: z.date().nullable(),
  observation_start: IsoDateString.nullable(),
  observation_end: IsoDateString.nullable(),
});
export type MacroSeries = z.infer<typeof MacroSeries>;

export const MacroObservation = Provenance.extend({
  series_id: z.string().min(1),
  date: IsoDateString,
  /** null when the source reports the value as missing; never zero-filled. */
  value: finite.nullable(),
  realtime_start: IsoDateString,
});
export type MacroObservation = z.infer<typeof MacroObservation>;
