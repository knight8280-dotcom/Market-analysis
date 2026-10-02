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
