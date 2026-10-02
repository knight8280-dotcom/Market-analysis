import type { Dataset, ProviderId } from "./types";

/**
 * Per-dataset provider routing and failover (spec §2.1). These are pure decisions; the worker
 * persists RouteState in ops.dataset_routing so every process agrees on the active provider.
 *
 * Policy:
 * - after `failuresBeforeFailover` consecutive failures of the active primary, switch to the
 *   fallback (or to "none", meaning serve last-good data with a staleness banner); on a
 *   staleness breach, switch only if a fallback exists; emit `provider_failover`;
 * - while failed over, the monitor probes the primary; after `successesBeforeFailback`
 *   consecutive healthy probes (counted from the failover), switch back and emit
 *   `provider_failback`.
 * One chart series never silently mixes sources: bars keep their `source`, and readers mark
 * the boundary where it changes.
 */

export interface RouteConfig {
  primary: ProviderId;
  fallback: ProviderId | null;
}

export type RoutingTable = Readonly<Record<Dataset, RouteConfig>>;

export function buildRoutingTable(prices: {
  primary: ProviderId;
  fallback: ProviderId | null;
}): RoutingTable {
  const priceRoute = { primary: prices.primary, fallback: prices.fallback };
  return {
    securities: priceRoute,
    daily_bars: priceRoute,
    corporate_actions: priceRoute,
    fundamentals: { primary: "sec_edgar", fallback: null },
    filings: { primary: "sec_edgar", fallback: null },
    macro: { primary: "fred", fallback: null },
    earnings: { primary: "finnhub", fallback: null },
    institutional_holdings: { primary: "sec_edgar", fallback: null },
    short_interest: { primary: "finra", fallback: null },
  };
}

export interface RouteState {
  dataset: Dataset;
  primary: ProviderId;
  fallback: ProviderId | null;
  /** null: no provider available; readers serve last-good data with a staleness banner. */
  active: ProviderId | null;
  failedOverAt: Date | null;
  reason: string | null;
}

export type RoutingEvent =
  | {
      type: "provider_failover";
      dataset: Dataset;
      from: ProviderId;
      to: ProviderId | null;
      reason: string;
      at: Date;
    }
  | {
      type: "provider_failback";
      dataset: Dataset;
      from: ProviderId | null;
      to: ProviderId;
      at: Date;
    };

export interface FailoverPolicy {
  failuresBeforeFailover: number;
  successesBeforeFailback: number;
}

export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = {
  failuresBeforeFailover: 3,
  successesBeforeFailback: 3,
};

export interface Decision {
  state: RouteState;
  event?: RoutingEvent;
}

export function initialRouteState(dataset: Dataset, config: RouteConfig): RouteState {
  return {
    dataset,
    primary: config.primary,
    fallback: config.fallback,
    active: config.primary,
    failedOverAt: null,
    reason: null,
  };
}

function failover(state: RouteState, reason: string, now: Date): Decision {
  if (state.active !== state.primary) return { state };
  const next: RouteState = { ...state, active: state.fallback, failedOverAt: now, reason };
  return {
    state: next,
    event: {
      type: "provider_failover",
      dataset: state.dataset,
      from: state.primary,
      to: state.fallback,
      reason,
      at: now,
    },
  };
}

/** Called after a failed fetch from the primary with its consecutive-failure count. */
export function onPrimaryFailure(
  state: RouteState,
  consecutiveFailures: number,
  reason: string,
  now: Date,
  policy: FailoverPolicy = DEFAULT_FAILOVER_POLICY,
): Decision {
  if (consecutiveFailures < policy.failuresBeforeFailover) return { state };
  return failover(state, `${consecutiveFailures} consecutive failures: ${reason}`, now);
}

/**
 * Called by the staleness monitor when the dataset breaches its freshness SLO. Without a
 * fallback there is nowhere better to go (the data is stale either way), so the route stays and
 * the staleness alert and banner carry the message. Provider errors still fail over to "none".
 */
export function onStalenessBreach(state: RouteState, reason: string, now: Date): Decision {
  if (state.fallback === null) return { state };
  return failover(state, `staleness: ${reason}`, now);
}

/** Called after a health probe of the primary while failed over. */
export function onPrimaryProbe(
  state: RouteState,
  consecutiveSuccesses: number,
  now: Date,
  policy: FailoverPolicy = DEFAULT_FAILOVER_POLICY,
): Decision {
  if (state.active === state.primary) return { state };
  if (consecutiveSuccesses < policy.successesBeforeFailback) return { state };
  const next: RouteState = { ...state, active: state.primary, failedOverAt: null, reason: null };
  return {
    state: next,
    event: {
      type: "provider_failback",
      dataset: state.dataset,
      from: state.active,
      to: state.primary,
      at: now,
    },
  };
}
