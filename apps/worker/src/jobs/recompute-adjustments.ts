import { previousTradingDay } from "@market/calendar";
import { computeAdjustmentFactors, type ProviderId } from "@market/market-data";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { actionsFor, replaceFactors, type StoredAction } from "../repo/actions";
import { closesOn } from "../repo/prices";
import { recordIssues } from "../repo/quality";
import { routeFor } from "../routing";

export const RecomputeAdjustmentsInput = z.object({ securityId: z.string().regex(/^\d+$/) });

/**
 * Rebuilds a security's adjustment factors from its corporate actions (spec §3.7: "adjusted
 * series are recomputed when a new action arrives, and dependent caches are invalidated").
 * The same action reported by several sources is counted once, preferring the price route's
 * primary, then its fallback.
 */
export async function recomputeAdjustments(ctx: WorkerContext, raw: unknown) {
  const { securityId } = RecomputeAdjustmentsInput.parse(raw);
  const route = await routeFor(ctx, "daily_bars");
  const preference: (ProviderId | null)[] = [route.primary, route.fallback];
  const rank = (s: ProviderId) => {
    const i = preference.indexOf(s);
    return i === -1 ? preference.length : i;
  };

  const stored = await actionsFor(ctx.db, securityId);
  const chosen = new Map<string, StoredAction>();
  for (const a of stored) {
    const key = `${a.type}|${a.ex_date}`;
    const current = chosen.get(key);
    if (!current || rank(a.source) < rank(current.source)) chosen.set(key, a);
  }
  const actions = [...chosen.values()];

  const needed = [
    ...new Set(
      actions.filter((a) => a.cash_amount !== null).map((a) => previousTradingDay(a.ex_date)),
    ),
  ];
  const closes = await closesOn(ctx.db, securityId, needed);
  const closeBefore = (exDate: string): number | null => {
    const date = previousTradingDay(exDate);
    const candidates = closes
      .filter((c) => c.date === date)
      .sort((a, b) => rank(a.source as ProviderId) - rank(b.source as ProviderId));
    return candidates[0]?.close ?? null;
  };

  const { factors, issues } = computeAdjustmentFactors(actions, closeBefore);
  const now = ctx.clock();
  await replaceFactors(ctx.db, securityId, factors, now);
  await recordIssues(
    ctx.db,
    issues.map((i) => ({
      runId: null,
      dataset: "corporate_actions",
      source: null,
      securityId,
      date: i.ex_date,
      rule: i.rule,
      severity: i.rule === "action_not_adjusted" ? ("info" as const) : ("warning" as const),
      action: "skipped" as const,
      message: i.message,
    })),
  );
  // Cache-invalidation hook: Phase 1 readers subscribe to this event.
  await ctx.events.emit({ type: "adjustments_recomputed", securityId, at: now });
  return { securityId, factors: factors.length, issues: issues.length };
}
