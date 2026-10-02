/**
 * Feature flags (spec §10: every Phase 2+ feature ships behind a flag). Defaults live here, in
 * code; the owner's overrides are rows in `ops.feature_flags`, changed on /settings. A feature's
 * flag is registered when work on it starts and defaults to on once the feature is complete.
 */
export interface FlagDefinition {
  label: string;
  description: string;
  default: boolean;
}

export const FEATURE_FLAGS = {
  backtests: {
    label: "Backtests",
    description: "Strategy builder, backtest runs and their reports.",
    default: true,
  },
  valuation: {
    label: "Valuation",
    description:
      "DCF calculator, saved scenarios, peer multiples and their history on ticker pages.",
    default: true,
  },
  alert_types: {
    label: "More alert types",
    description:
      "RSI and moving-average crossings, volume spikes, new SEC filings and changes in a saved screen's results.",
    default: true,
  },
  notifications: {
    label: "Notifications",
    description:
      "In-app notifications when alerts fire, with snooze and delete; the bell in the header.",
    default: true,
  },
  drawings: {
    label: "Chart drawings",
    description:
      "Trend lines, horizontal lines, Fibonacci retracements, rectangles and text on ticker charts.",
    default: true,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FEATURE_FLAGS;
export const FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FlagKey[];

export function isFlagKey(key: string): key is FlagKey {
  return Object.hasOwn(FEATURE_FLAGS, key);
}

/** Every flag's effective state: the owner's override where one exists, else the default. */
export function resolveFlags(
  overrides: readonly { key: string; enabled: boolean }[],
): Record<FlagKey, boolean> {
  const out = Object.fromEntries(FLAG_KEYS.map((k) => [k, FEATURE_FLAGS[k].default])) as Record<
    FlagKey,
    boolean
  >;
  for (const o of overrides) if (isFlagKey(o.key)) out[o.key] = o.enabled;
  return out;
}
