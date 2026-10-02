import "server-only";
import type { BacktestReport, StrategyInput } from "@market/backtest";
import { OWNER_USER_ID } from "@market/config";
import { db } from "./db";

/** The owner's backtest runs and saved strategies (Phase 2 step B8). */

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RunKind = "single" | "sweep" | "walk_forward";

export interface RunSummary {
  totalReturn: number | null;
  cagr: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  trades: number | null;
  benchmarkTotalReturn: number | null;
  first: string | null;
  last: string | null;
  combinations: number;
  best: Record<string, number> | null;
}

export interface RunListItem {
  id: string;
  name: string;
  kind: RunKind;
  status: RunStatus;
  createdAt: Date;
  finishedAt: Date | null;
  error: string | null;
  strategyId: string | null;
  summary: RunSummary | null;
}

export async function listRuns(limit = 100): Promise<RunListItem[]> {
  const rows = await db()
    .selectFrom("backtest_runs as r")
    .leftJoin("backtest_results as x", "x.run_id", "r.run_id")
    .select([
      "r.run_id",
      "r.name",
      "r.kind",
      "r.status",
      "r.created_at",
      "r.finished_at",
      "r.error",
      "r.strategy_id",
      "x.summary",
    ])
    .where("r.user_id", "=", OWNER_USER_ID)
    .orderBy("r.created_at", "desc")
    .orderBy("r.run_id", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.run_id,
    name: r.name,
    kind: r.kind as RunKind,
    status: r.status as RunStatus,
    createdAt: new Date(r.created_at),
    finishedAt: r.finished_at ? new Date(r.finished_at) : null,
    error: r.error,
    strategyId: r.strategy_id,
    summary: (r.summary as RunSummary | null) ?? null,
  }));
}

/** What the worker read for a run (apps/worker/src/backtest/load.ts LoadedInputs). */
export interface RunInputs {
  source: string;
  warmupSessions: number;
  loadedFrom: string;
  runFrom: string;
  runTo: string;
  securities: { ticker: string; securityId: string; bars: number; delistedAt: string | null }[];
  benchmark: { ticker: string; available: boolean } | null;
  riskFree: { series: "DTB3"; available: boolean };
  notes: string[];
}

export interface RunDetail extends RunListItem {
  request: unknown;
  startedAt: Date | null;
  codeVersion: string | null;
  dataSnapshotId: string | null;
  report: BacktestReport | null;
  validation: unknown;
  inputs: RunInputs | null;
}

export async function getRun(id: string): Promise<RunDetail | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const r = await db()
    .selectFrom("backtest_runs as r")
    .leftJoin("backtest_results as x", "x.run_id", "r.run_id")
    .select([
      "r.run_id",
      "r.name",
      "r.kind",
      "r.status",
      "r.request",
      "r.created_at",
      "r.started_at",
      "r.finished_at",
      "r.error",
      "r.strategy_id",
      "r.code_version",
      "r.data_snapshot_id",
      "x.summary",
      "x.report",
      "x.validation",
      "x.inputs",
    ])
    .where("r.run_id", "=", id)
    .where("r.user_id", "=", OWNER_USER_ID)
    .executeTakeFirst();
  if (!r) return null;
  return {
    id: r.run_id,
    name: r.name,
    kind: r.kind as RunKind,
    status: r.status as RunStatus,
    createdAt: new Date(r.created_at),
    startedAt: r.started_at ? new Date(r.started_at) : null,
    finishedAt: r.finished_at ? new Date(r.finished_at) : null,
    error: r.error,
    strategyId: r.strategy_id,
    request: r.request,
    codeVersion: r.code_version,
    dataSnapshotId: r.data_snapshot_id,
    summary: (r.summary as RunSummary | null) ?? null,
    report: (r.report as unknown as BacktestReport | null) ?? null,
    validation: r.validation ?? null,
    inputs: (r.inputs as unknown as RunInputs | null) ?? null,
  };
}

/** Earlier runs of the same request, to show whether a re-run matched them. */
export async function sameRequestRuns(
  run: RunDetail,
): Promise<{ id: string; dataSnapshotId: string; createdAt: Date }[]> {
  const rows = await db()
    .selectFrom("backtest_runs")
    .select(["run_id", "data_snapshot_id", "created_at"])
    .where("user_id", "=", OWNER_USER_ID)
    .where("status", "=", "succeeded")
    .where("run_id", "!=", run.id)
    .where("request", "=", JSON.stringify(run.request))
    .orderBy("created_at", "desc")
    .limit(5)
    .execute();
  return rows.map((r) => ({
    id: r.run_id,
    dataSnapshotId: r.data_snapshot_id!,
    createdAt: new Date(r.created_at),
  }));
}

export interface SavedStrategy {
  id: string;
  name: string;
  definition: StrategyInput;
  updatedAt: Date;
}

export async function listStrategies(): Promise<SavedStrategy[]> {
  const rows = await db()
    .selectFrom("strategies")
    .select(["strategy_id", "name", "definition", "updated_at"])
    .where("user_id", "=", OWNER_USER_ID)
    .orderBy("name")
    .execute();
  return rows.map((r) => ({
    id: r.strategy_id,
    name: r.name,
    definition: r.definition as unknown as StrategyInput,
    updatedAt: new Date(r.updated_at),
  }));
}

export async function getStrategy(id: string): Promise<SavedStrategy | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  return (await listStrategies()).find((s) => s.id === id) ?? null;
}
