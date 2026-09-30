import { z } from "zod";

/** Alert conditions (Phase 1 step I1). Prices are compared on end-of-day closes. */
export const ALERT_KINDS = ["price_above", "price_below", "pct_move", "earnings_upcoming"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

const price = z.number().finite().positive().max(10_000_000);

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
]);
export type AlertDefinition = z.infer<typeof AlertDefinition>;

/** Hours after firing during which an alert stays quiet (0 = no cooldown; at most 30 days). */
export const CooldownHours = z.number().int().min(0).max(720);

/** Emails per day across all alerts; events beyond it are recorded as suppressed. */
export const DEFAULT_DAILY_CAP = 20;

/** Parses an alert row's kind and params, or returns null for a definition that no longer validates. */
export function parseAlert(kind: string, params: unknown): AlertDefinition | null {
  const parsed = AlertDefinition.safeParse({ kind, params });
  return parsed.success ? parsed.data : null;
}
