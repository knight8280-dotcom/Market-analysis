import type { WorkerContext } from "../context";
import type { JobName } from "../queues";
import { ingestFilings, ingestFundamentals, scheduleEdgar } from "./edgar";
import { ensurePartitions } from "./ensure-partitions";
import { ingestEod, reconcileEod, scheduleEod } from "./ingest-eod";
import { ingestMacro } from "./ingest-macro";
import { ingestSecurities } from "./ingest-securities";
import { recomputeAdjustments } from "./recompute-adjustments";
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
  "ingest-filings": ingestFilings,
  "schedule-edgar": (ctx) => scheduleEdgar(ctx),
  "ingest-macro": ingestMacro,
  "ensure-partitions": (ctx) => ensurePartitions(ctx),
  "staleness-monitor": (ctx) => stalenessMonitor(ctx),
};

export function runJob(ctx: WorkerContext, name: JobName, data: unknown): Promise<unknown> {
  return HANDLERS[name](ctx, data);
}
