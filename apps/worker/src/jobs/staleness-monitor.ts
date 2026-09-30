import { onPrimaryProbe, onStalenessBreach, type Dataset } from "@market/market-data";
import type { WorkerContext } from "../context";
import { checkDailyBars, checkFundamentals, checkMacro, type FreshnessResult } from "../freshness";
import { JOBS, jobId } from "../queues";
import { openAlert, resolveAlerts } from "../repo/alerts";
import { recordFailure, recordSuccess } from "../repo/health";
import { applyDecision, routeFor } from "../routing";
import { countDefaultPartitionRows } from "./ensure-partitions";

/**
 * Runs every minute (spec §7): checks each dataset against its freshness SLO, opens or resolves
 * staleness alerts (the data-health page shows open alerts as banners), fails daily bars over
 * to the fallback on a breach and re-requests the missing session from it, and probes a
 * failed-over primary so it can fail back.
 */
export async function stalenessMonitor(ctx: WorkerContext) {
  const now = ctx.clock();
  const results: FreshnessResult[] = [
    await checkDailyBars(ctx.db, now),
    await checkFundamentals(ctx.db, now),
    await checkMacro(ctx.db, now),
  ];

  for (const r of results) {
    if (r.applicable && !r.ok) {
      const route = await routeFor(ctx, r.dataset);
      const { opened } = await openAlert(ctx.db, {
        kind: "staleness",
        dataset: r.dataset,
        source: null,
        severity: "critical",
        message: r.message,
        details: r.details,
        at: now,
      });
      if (opened) {
        ctx.log.error({ dataset: r.dataset, details: r.details }, r.message);
        await ctx.events.emit({
          type: "alert_opened",
          kind: "staleness",
          dataset: r.dataset,
          source: null,
          at: now,
        });
      }
      if (r.dataset === "daily_bars") {
        const decision = onStalenessBreach(route, r.message, now);
        await applyDecision(ctx, decision);
        if (decision.event?.to) {
          // Ask the new provider for the missing session straight away.
          const session = String(r.details.session);
          await ctx.dispatch.dispatch({
            name: JOBS.scheduleEod,
            data: { date: session },
            jobId: jobId(JOBS.scheduleEod, session, decision.event.to),
          });
        }
      }
    } else if (
      (await resolveAlerts(ctx.db, { kind: "staleness", dataset: r.dataset, at: now })) > 0
    ) {
      ctx.log.info({ dataset: r.dataset }, "staleness resolved");
      await ctx.events.emit({
        type: "alert_resolved",
        kind: "staleness",
        dataset: r.dataset,
        source: null,
        at: now,
      });
    }
  }

  const defaultRows = await countDefaultPartitionRows(ctx);
  if (defaultRows > 0) {
    await openAlert(ctx.db, {
      kind: "partition",
      dataset: "daily_bars",
      source: null,
      severity: "warning",
      message: `${defaultRows} rows in market.prices_daily_default`,
      details: { rows: defaultRows },
      at: now,
    });
  }

  const probes: { dataset: Dataset; healthy: boolean }[] = [];
  for (const dataset of ["daily_bars", "fundamentals", "filings", "macro"] as const) {
    const route = await routeFor(ctx, dataset);
    if (route.active === route.primary) continue;
    const primary = ctx.providers.get(route.primary);
    if (!primary) continue;
    try {
      await primary.healthCheck();
      const successes = await recordSuccess(ctx.db, {
        source: route.primary,
        dataset,
        latencyMs: 0,
        at: now,
      });
      await applyDecision(ctx, onPrimaryProbe(route, successes, now));
      probes.push({ dataset, healthy: true });
    } catch (err) {
      await recordFailure(ctx.db, {
        source: route.primary,
        dataset,
        error: err instanceof Error ? err.message : String(err),
        at: now,
      });
      probes.push({ dataset, healthy: false });
    }
  }
  return {
    at: now.toISOString(),
    results: results.map(({ dataset, applicable, ok }) => ({ dataset, applicable, ok })),
    probes,
  };
}
