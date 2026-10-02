import { createDb, createPool } from "@market/db";
import { executeRun, type RunOutcome } from "./execute";
import type { ThreadMessage } from "./runner";

/** One backtest in a worker thread (see runner.ts): its own small pool, one run, done. */
export async function runThread(message: ThreadMessage): Promise<RunOutcome> {
  const { runId, source, codeVersion, timeLimitMs, databaseUrl } = message;
  const pool = createPool(databaseUrl, { max: 2, applicationName: "worker-backtest" });
  try {
    return await executeRun(createDb(pool), runId, { source, codeVersion, timeLimitMs });
  } finally {
    await pool.end();
  }
}
