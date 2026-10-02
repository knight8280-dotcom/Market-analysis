import { z } from "zod";

/**
 * Alert conditions. Phase 1 (steps I1-I3): price levels, one-day moves and earnings dates.
 * Phase 2 (step E1): RSI and moving-average crossings, volume spikes, new SEC filings and
 * changes in a saved screen's results. Prices are end-of-day closes.
 */
export const ALERT_KINDS = [
  "price_above",
  "price_below",
  "pct_move",
  "earnings_upcoming",
  "rsi_below",
  "rsi_above",
  "sma_cross",
  "volume_spike",
  "new_filing",
  "screen_membership",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** The kinds added in Phase 2, shown and evaluated only while the `alert_types` flag is on. */
export const PHASE2_KINDS = [
  "rsi_below",
  "rsi_above",
  "sma_cross",
  "volume_spike",
  "new_filing",
  "screen_membership",
] as const satisfies readonly AlertKind[];

/** Kinds evaluated on the adjusted daily series (indicators and volume). */
export const SERIES_KINDS = [
  "rsi_below",
  "rsi_above",
  "sma_cross",
  "volume_spike",
] as const satisfies readonly AlertKind[];

/** Screen alerts watch a saved screen; every other kind watches one security. */
export const watchesScreen = (kind: AlertKind): boolean => kind === "screen_membership";

export const KIND_LABELS: Record<AlertKind, string> = {
  price_above: "Closes above a price",
  price_below: "Closes below a price",
  pct_move: "Moves by a percentage in a day",
  earnings_upcoming: "Earnings coming up",
  rsi_below: "RSI crosses below a level",
  rsi_above: "RSI crosses above a level",
  sma_cross: "Moving-average cross",
  volume_spike: "Volume spike",
  new_filing: "New SEC filing",
  screen_membership: "Screen results change",
};

const price = z.number().finite().positive().max(10_000_000);

const rsiParams = z.strictObject({
  /** RSI level, strictly between 0 and 100. */
  level: z.number().finite().gt(0).lt(100),
  /** Sessions in the RSI (Wilder smoothing); 14 is the usual choice. */
  period: z.number().int().min(2).max(100),
});

/**
 * An EDGAR form type as listed in the filing index ("10-K", "8-K", "4", "SC 13D"); amendments
 * ("10-K/A") are matched through `amendments` rather than listed.
 */
export const FormType = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9 -]{0,19}$/, "use the form's EDGAR name, such as 10-K or SC 13D")
  .refine((f) => !f.endsWith(" "), "no trailing spaces");

export const AlertDefinition = z.discriminatedUnion("kind", [
  /** The close crosses above `price` (the previous close was at or below it). */
  z.object({ kind: z.literal("price_above"), params: z.strictObject({ price }) }),
  /** The close crosses below `price` (the previous close was at or above it). */
  z.object({ kind: z.literal("price_below"), params: z.strictObject({ price }) }),
  /** The one-day change (split-adjusted) reaches `pct` (a fraction) in `direction`. */
  z.object({
    kind: z.literal("pct_move"),
    params: z.strictObject({
      pct: z.number().finite().gt(0).max(1),
      direction: z.enum(["up", "down", "either"]),
    }),
  }),
  /** An earnings date falls within the next `days` calendar days. */
  z.object({
    kind: z.literal("earnings_upcoming"),
    params: z.strictObject({ days: z.number().int().min(1).max(30) }),
  }),
  /** RSI on adjusted closes crosses below `level` (the session before was at or above it). */
  z.object({ kind: z.literal("rsi_below"), params: rsiParams }),
  /** RSI on adjusted closes crosses above `level` (the session before was at or below it). */
  z.object({ kind: z.literal("rsi_above"), params: rsiParams }),
  /**
   * The `fast`-session simple average (1 = the close itself) crosses above or below the
   * `slow`-session average, on adjusted closes.
   */
  z.object({
    kind: z.literal("sma_cross"),
    params: z
      .strictObject({
        fast: z.number().int().min(1).max(400),
        slow: z.number().int().min(2).max(400),
        direction: z.enum(["above", "below"]),
      })
      .refine((p) => p.fast < p.slow, {
        message: "the fast average must cover fewer sessions than the slow one",
        path: ["fast"],
      }),
  }),
  /**
   * The session's volume is at least `multiple` times the average of the `lookback` sessions
   * before it (split-adjusted volumes).
   */
  z.object({
    kind: z.literal("volume_spike"),
    params: z.strictObject({
      multiple: z.number().finite().min(1.1).max(100),
      lookback: z.number().int().min(5).max(250),
    }),
  }),
  /** The company files one of `forms` with the SEC (amendments too when `amendments`). */
  z.object({
    kind: z.literal("new_filing"),
    params: z.strictObject({
      forms: z
        .array(FormType)
        .min(1)
        .max(20)
        .refine((forms) => new Set(forms).size === forms.length, "list each form once"),
      amendments: z.boolean(),
    }),
  }),
  /** Securities enter or leave the results of a saved screen (the alert's `screen_id`). */
  z.object({
    kind: z.literal("screen_membership"),
    params: z.strictObject({ change: z.enum(["enters", "leaves", "either"]) }),
  }),
]);
export type AlertDefinition = z.infer<typeof AlertDefinition>;

/** Hours after firing during which an alert stays quiet (0 = no cooldown; at most 30 days). */
export const CooldownHours = z.number().int().min(0).max(720);

/** Snooze choices offered on notifications and alert pages, in hours. */
export const SNOOZE_HOURS = [24, 72, 168] as const;

/** Emails per day across all alerts; events beyond it are recorded as suppressed. */
export const DEFAULT_DAILY_CAP = 20;

/** Parses an alert row's kind and params, or returns null for a definition that no longer validates. */
export function parseAlert(kind: string, params: unknown): AlertDefinition | null {
  const parsed = AlertDefinition.safeParse({ kind, params });
  return parsed.success ? parsed.data : null;
}

const Member = z.object({ securityId: z.string(), ticker: z.string() });
export type ScreenMember = z.infer<typeof Member>;

/**
 * What an alert remembers between evaluations (`public.alerts.state`): how far through the
 * stored filings it has looked, and a screen's results when they were last reported.
 */
export const AlertState = z.object({
  /** new_filing: filings stored up to this time have been considered (ISO timestamp). */
  filingsSeenThrough: z.iso.datetime({ offset: true }).optional(),
  /** screen_membership: the results last reported, or the starting point. */
  screen: z
    .object({
      /** Fingerprint of the screen's conditions when these results were taken. */
      definition: z.string(),
      asOf: z.string(),
      members: z.array(Member).max(10_000),
    })
    .optional(),
});
export type AlertState = z.infer<typeof AlertState>;

/** A stored state, or an empty one when it is missing or no longer readable. */
export function parseState(raw: unknown): AlertState {
  const parsed = AlertState.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}
