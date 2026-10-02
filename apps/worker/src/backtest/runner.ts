import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { codeVersion } from "@market/backtest/snapshot";
import type { Database } from "@market/db";
import type { Logger } from "../log";
import { executeRun, failRun, type ExecuteOptions, type RunOutcome } from "./execute";

/**
 * Where backtests run. The engine is synchronous and CPU-bound (a 400-combination sweep can
 * take minutes), so the worker runs each one in a worker thread: the event loop stays free for
 * the other queues, lock renewals and the scheduler, and a run past its time limit can be
 * stopped outright. Tests and one-off CLI runs may run in-process.
 */
export type BacktestRunner = (runId: string, source: string) => Promise<RunOutcome>;

/** Soft limit checked by the engine; the thread is stopped a minute after it. */
export const BACKTEST_TIME_LIMIT_MS = 10 * 60_000;
const HARD_LIMIT_GRACE_MS = 60_000;

/** The commit the worker runs, when it runs from a git checkout. */
export function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

export function inProcessRunner(
  db: Database,
  opts: Partial<Omit<ExecuteOptions, "source">> = {},
): BacktestRunner {
  const version = opts.codeVersion ?? codeVersion(null);
  const timeLimitMs = opts.timeLimitMs ?? BACKTEST_TIME_LIMIT_MS;
  return (runId, source) => executeRun(db, runId, { source, codeVersion: version, timeLimitMs });
}

export interface ThreadMessage {
  runId: string;
  source: string;
  codeVersion: string;
  timeLimitMs: number;
  databaseUrl: string;
}

export function threadRunner(opts: {
  db: Database;
  databaseUrl: string;
  log: Logger;
  codeVersion?: string;
  timeLimitMs?: number;
}): BacktestRunner {
  const version = opts.codeVersion ?? codeVersion(gitSha());
  const timeLimitMs = opts.timeLimitMs ?? BACKTEST_TIME_LIMIT_MS;
  return (runId, source) =>
    new Promise<RunOutcome>((resolve, reject) => {
      const message: ThreadMessage = {
        runId,
        source,
        codeVersion: version,
        timeLimitMs,
        databaseUrl: opts.databaseUrl,
      };
      const thread = new Worker(new URL("./thread.mjs", import.meta.url), { workerData: message });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        void thread.terminate();
        const error = `stopped after ${Math.round((timeLimitMs + HARD_LIMIT_GRACE_MS) / 60_000)} minutes`;
        failRun(opts.db, runId, error).then(
          () => finish(() => resolve({ runId, status: "failed", error })),
          (err: unknown) => finish(() => reject(asError(err))),
        );
      }, timeLimitMs + HARD_LIMIT_GRACE_MS);
      thread.once("message", (outcome: RunOutcome) => finish(() => resolve(outcome)));
      thread.once("error", (err: unknown) => {
        opts.log.error({ err, runId }, "backtest thread failed");
        // Thrown database errors are retried by the queue; the run stays claimable.
        finish(() => reject(asError(err)));
      });
      thread.once("exit", (code) => {
        if (code !== 0) finish(() => reject(new Error(`backtest thread exited with code ${code}`)));
      });
    });
}
