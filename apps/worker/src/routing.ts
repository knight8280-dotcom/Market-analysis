import {
  onPrimaryFailure,
  type Dataset,
  type Decision,
  type MarketDataProvider,
  type ProviderId,
  type RouteState,
} from "@market/market-data";
import type { WorkerContext } from "./context";
import { openAlert, recordEventAlert, resolveAlerts } from "./repo/alerts";
import { recordFailure, recordSuccess, resetSuccesses } from "./repo/health";
import { loadRoute, saveRoute } from "./repo/routing";

export class NoProviderAvailableError extends Error {
  constructor(dataset: Dataset) {
    super(`No provider is available for ${dataset}; serving last-good data until one recovers`);
    this.name = "NoProviderAvailableError";
  }
}

export function routeFor(ctx: WorkerContext, dataset: Dataset): Promise<RouteState> {
  return loadRoute(ctx.db, dataset, ctx.routes[dataset]);
}

export function providerFor(ctx: WorkerContext, id: ProviderId): MarketDataProvider {
  const provider = ctx.providers.get(id);
  if (!provider) throw new Error(`Provider ${id} is not configured in this process`);
  return provider;
}

/** The provider a job should use: an explicit override, else the dataset's active route. */
export async function resolveSource(
  ctx: WorkerContext,
  dataset: Dataset,
  override?: ProviderId,
): Promise<{ route: RouteState; source: ProviderId; provider: MarketDataProvider }> {
  const route = await routeFor(ctx, dataset);
  const source = override ?? route.active;
  if (!source) throw new NoProviderAvailableError(dataset);
  return { route, source, provider: providerFor(ctx, source) };
}

/** Persists a routing decision, records alerts and emits the provider_failover/failback event. */
export async function applyDecision(ctx: WorkerContext, decision: Decision): Promise<void> {
  const { state, event } = decision;
  if (!event) return;
  const at = event.at;
  await saveRoute(ctx.db, state, at);
  if (event.type === "provider_failover") {
    // Failback needs healthy probes made after this point, not successes from before the outage.
    await resetSuccesses(ctx.db, { source: event.from, dataset: event.dataset });
    await openAlert(ctx.db, {
      kind: "failover",
      dataset: event.dataset,
      source: event.from,
      severity: "critical",
      message: event.to
        ? `${event.dataset}: failed over from ${event.from} to ${event.to} (${event.reason})`
        : `${event.dataset}: ${event.from} unavailable and no fallback; serving last-good data (${event.reason})`,
      details: { from: event.from, to: event.to, reason: event.reason },
      at,
    });
  } else {
    await resolveAlerts(ctx.db, { kind: "failover", dataset: event.dataset, at });
    await recordEventAlert(ctx.db, {
      kind: "failback",
      dataset: event.dataset,
      source: event.to,
      severity: "info",
      message: `${event.dataset}: back on primary ${event.to}`,
      details: { from: event.from, to: event.to },
      at,
    });
  }
  ctx.log.warn({ event }, event.type);
  await ctx.events.emit(event);
}

/**
 * Runs a provider call, recording latency and success or failure in ops.provider_health. A
 * failure of the active primary counts toward failover (spec §2.1).
 */
export async function withProviderHealth<T>(
  ctx: WorkerContext,
  call: { route: RouteState; source: ProviderId; dataset: Dataset },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    await recordSuccess(ctx.db, {
      source: call.source,
      dataset: call.dataset,
      latencyMs: Date.now() - started,
      at: ctx.clock(),
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const now = ctx.clock();
    const failures = await recordFailure(ctx.db, {
      source: call.source,
      dataset: call.dataset,
      error: message,
      at: now,
    });
    if (call.source === call.route.primary && call.route.active === call.route.primary) {
      await applyDecision(ctx, onPrimaryFailure(call.route, failures, message, now));
    }
    throw err;
  }
}
