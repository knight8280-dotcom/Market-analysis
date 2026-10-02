import type { JobsOptions } from "bullmq";

/** BullMQ queues (spec §3.4 names, plus ingest-macro, maintenance, monitor and the DLQ). */
export const QUEUES = {
  eod: "ingest-eod",
  alerts: "alerts-evaluate",
  backtest: "backtest-run",
  fundamentals: "ingest-fundamentals",
  filings: "ingest-filings",
  macro: "ingest-macro",
  maintenance: "maintenance",
  monitor: "monitor",
  deadLetter: "dead-letter",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOBS = {
  ingestSecurities: "ingest-securities",
  scheduleEod: "schedule-eod",
  ingestEod: "ingest-eod",
  reconcileEod: "reconcile-eod",
  recomputeAdjustments: "recompute-adjustments",
  ingestFundamentals: "ingest-fundamentals",
  buildStatements: "build-statements",
  ingestFilings: "ingest-filings",
  scheduleEdgar: "schedule-edgar",
  attachEdgarIds: "attach-edgar-ids",
  ingestMacro: "ingest-macro",
  ensurePartitions: "ensure-partitions",
  stalenessMonitor: "staleness-monitor",
  refreshScreener: "refresh-screener",
  ingestEarnings: "ingest-earnings",
  ingestReleases: "ingest-releases",
  evaluateAlerts: "evaluate-alerts",
  runBacktest: "run-backtest",
  ingestInsider: "ingest-insider",
  sweepInsiders: "sweep-insiders",
  refreshCusips: "refresh-cusips",
  ingestForm13f: "ingest-13f",
  schedule13f: "schedule-13f",
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

export const QUEUE_OF: Readonly<Record<JobName, QueueName>> = {
  "ingest-securities": QUEUES.eod,
  "schedule-eod": QUEUES.eod,
  "ingest-eod": QUEUES.eod,
  "reconcile-eod": QUEUES.eod,
  "recompute-adjustments": QUEUES.maintenance,
  "ingest-fundamentals": QUEUES.fundamentals,
  "build-statements": QUEUES.fundamentals,
  "ingest-filings": QUEUES.filings,
  "schedule-edgar": QUEUES.filings,
  "attach-edgar-ids": QUEUES.filings,
  "ingest-macro": QUEUES.macro,
  "ensure-partitions": QUEUES.maintenance,
  "staleness-monitor": QUEUES.monitor,
  "refresh-screener": QUEUES.maintenance,
  "ingest-earnings": QUEUES.macro,
  "ingest-releases": QUEUES.macro,
  "evaluate-alerts": QUEUES.alerts,
  "run-backtest": QUEUES.backtest,
  "ingest-insider": QUEUES.filings,
  "sweep-insiders": QUEUES.filings,
  "refresh-cusips": QUEUES.filings,
  "ingest-13f": QUEUES.filings,
  "schedule-13f": QUEUES.filings,
};

/**
 * Deterministic job ids make enqueueing idempotent: adding a job whose id already exists is a
 * no-op. Parts are joined with "/" (BullMQ rejects most ids containing ":").
 */
export function jobId(name: JobName, ...parts: (string | number)[]): string {
  const id = [name, ...parts].join("/");
  if (id.includes(":")) throw new Error(`Job id may not contain ":" (${id})`);
  return id;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000, jitter: 0.5 },
  // Keep finished jobs for a week so re-adding the same id stays a no-op.
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export const CONCURRENCY: Readonly<Record<QueueName, number>> = {
  "ingest-eod": 4,
  // One at a time: evaluations never race each other over delivery or the daily cap.
  "alerts-evaluate": 1,
  // CPU-bound, in a worker thread: one at a time.
  "backtest-run": 1,
  "ingest-fundamentals": 2,
  "ingest-filings": 2,
  "ingest-macro": 1,
  maintenance: 2,
  monitor: 1,
  "dead-letter": 1,
};
