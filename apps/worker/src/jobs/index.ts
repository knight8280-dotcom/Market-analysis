import type { WorkerContext } from "../context";
import { evaluateAlerts } from "./alerts";
import { runBacktestJob } from "./backtest";
import type { JobName } from "../queues";
import {
  attachEdgarIds,
  buildStatementsJob,
  ingestFilings,
  ingestFundamentals,
  scheduleEdgar,
} from "./edgar";
import { ensurePartitions } from "./ensure-partitions";
import { ingestInsiderFiling, sweepInsiders } from "./insiders";
import { ingestForm13f, refreshCusips, schedule13f } from "./thirteenf";
import { ingestShortInterest } from "./short-interest";
import { ingestNews, ingestPressRelease, pruneNewsJob, sweepPressReleases } from "./news";
import { scoreNewsSentiment } from "./sentiment";
import { ingestEod, reconcileEod, scheduleEod } from "./ingest-eod";
import { ingestMacro } from "./ingest-macro";
import { ingestSecurities } from "./ingest-securities";
import { recomputeAdjustments } from "./recompute-adjustments";
import { ingestEarnings, ingestReleases } from "./calendars";
import { refreshScreener } from "./screener";
import { stalenessMonitor } from "./staleness-monitor";

export type Handler = (ctx: WorkerContext, data: unknown) => Promise<unknown>;

/** Every job handler, independent of BullMQ so the CLI and tests can run them directly. */
export const HANDLERS: Readonly<Record<JobName, Handler>> = {
  "ingest-securities": ingestSecurities,
  "schedule-eod": scheduleEod,
  "ingest-eod": ingestEod,
  "reconcile-eod": reconcileEod,
  "recompute-adjustments": recomputeAdjustments,
  "ingest-fundamentals": ingestFundamentals,
  "build-statements": buildStatementsJob,
  "ingest-filings": ingestFilings,
  "schedule-edgar": (ctx) => scheduleEdgar(ctx),
  "attach-edgar-ids": (ctx) => attachEdgarIds(ctx),
  "ingest-macro": ingestMacro,
  "ensure-partitions": (ctx) => ensurePartitions(ctx),
  "staleness-monitor": (ctx) => stalenessMonitor(ctx),
  "refresh-screener": (ctx) => refreshScreener(ctx),
  "ingest-earnings": ingestEarnings,
  "ingest-releases": ingestReleases,
  "evaluate-alerts": evaluateAlerts,
  "run-backtest": runBacktestJob,
  "ingest-insider": ingestInsiderFiling,
  "sweep-insiders": sweepInsiders,
  "refresh-cusips": refreshCusips,
  "ingest-13f": ingestForm13f,
  "schedule-13f": (ctx) => schedule13f(ctx),
  "ingest-short-interest": ingestShortInterest,
  "ingest-news": ingestNews,
  "ingest-press-release": ingestPressRelease,
  "sweep-press-releases": sweepPressReleases,
  "prune-news": (ctx) => pruneNewsJob(ctx),
  "score-news-sentiment": scoreNewsSentiment,
};

export function runJob(ctx: WorkerContext, name: JobName, data: unknown): Promise<unknown> {
  return HANDLERS[name](ctx, data);
}
