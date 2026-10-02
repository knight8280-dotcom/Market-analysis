import { sql, type Database } from "@market/db";

/** What AI requests have cost since the start of the calendar month (UTC) of `at`. */
export async function monthToDateUsd(db: Database, at: Date): Promise<number> {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const row = await sql<{ usd: string | null }>`
    select sum(cost_usd) as usd from ops.ai_requests where created_at >= ${start}
  `.execute(db);
  return Number(row.rows[0]?.usd ?? 0);
}

export interface AiRequestRow {
  purpose: "sentiment" | "assistant";
  model: string;
  promptVersion: string | null;
  status: "ok" | "error";
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  error?: string | null;
  details?: Record<string, unknown>;
  at: Date;
}

export async function recordAiRequest(db: Database, r: AiRequestRow): Promise<void> {
  await db
    .insertInto("ops.ai_requests")
    .values({
      purpose: r.purpose,
      model: r.model,
      prompt_version: r.promptVersion,
      status: r.status,
      input_tokens: r.inputTokens ?? 0,
      output_tokens: r.outputTokens ?? 0,
      cache_write_tokens: r.cacheWriteTokens ?? 0,
      cache_read_tokens: r.cacheReadTokens ?? 0,
      cost_usd: (r.costUsd ?? 0).toFixed(6),
      error: r.error ?? null,
      details: JSON.stringify(r.details ?? {}),
      created_at: r.at,
    })
    .execute();
}

/** AI request logs are kept 90 days (spec §4 retention for AI logs). */
export const AI_LOG_DAYS = 90;

export async function pruneAiRequests(db: Database, at: Date): Promise<number> {
  const result = await db
    .deleteFrom("ops.ai_requests")
    .where("created_at", "<", new Date(at.getTime() - AI_LOG_DAYS * 86_400_000))
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
