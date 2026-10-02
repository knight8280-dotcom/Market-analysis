import {
  AiError,
  costUsd,
  maxCostUsd,
  parseSentiment,
  SENTIMENT_BATCH,
  SENTIMENT_PROMPT_VERSION,
  sentimentRequest,
  type SentimentItem,
} from "@market/ai";
import { sql } from "@market/db";
import { z } from "zod";
import type { WorkerContext } from "../context";
import { monthToDateUsd, pruneAiRequests, recordAiRequest } from "../repo/ai";

/**
 * Model-estimated news sentiment (Phase 2 step I2, spec §5.12, ADR-036). Stories without an
 * estimate from the current model and prompt version are sent in batches; no request starts
 * that could take the month's AI spending past AI_MONTHLY_BUDGET_USD. Copies of a story and
 * exhibits without a headline are not rated.
 */
const Input = z.object({
  days: z.number().int().min(1).max(365).default(30),
  limit: z.number().int().min(1).max(2000).default(200),
});

export async function scoreNewsSentiment(ctx: WorkerContext, raw: unknown) {
  const { days, limit } = Input.parse(raw ?? {});
  const ai = ctx.ai;
  if (!ai) return { configured: false as const, note: "Set ANTHROPIC_API_KEY" };
  const model = ai.sentimentModel;
  await pruneAiRequests(ctx.db, ctx.clock());
  const since = new Date(ctx.clock().getTime() - days * 86_400_000);
  const pending = await sql<{
    article_id: string;
    headline: string;
    summary: string | null;
    companies: string[];
  }>`
    select a.article_id, a.headline, a.summary,
      coalesce(array_agg(s.ticker order by s.ticker) filter (where s.ticker is not null), '{}')
        as companies
    from market.news_articles a
    left join market.news_tickers t on t.article_id = a.article_id
    left join market.securities s on s.security_id = t.security_id
    where a.published_at >= ${since} and a.duplicate_of is null and not a.described
      and (a.sentiment_version is distinct from ${SENTIMENT_PROMPT_VERSION}
           or a.sentiment_model is distinct from ${model})
    group by a.article_id
    order by a.published_at desc, a.article_id desc
    limit ${limit}
  `.execute(ctx.db);
  const items: SentimentItem[] = pending.rows.map((r) => ({
    id: r.article_id,
    companies: r.companies,
    headline: r.headline,
    summary: r.summary,
  }));

  let scored = 0;
  let rejected = 0;
  let requests = 0;
  let spent = 0;
  let stoppedBy: "budget" | null = null;
  for (let i = 0; i < items.length; i += SENTIMENT_BATCH) {
    const batch = items.slice(i, i + SENTIMENT_BATCH);
    const request = sentimentRequest(batch, model);
    const most = maxCostUsd(
      model,
      request.system.length + request.messages[0]!.content.length,
      request.maxTokens,
    );
    if (most === null) {
      throw new Error(`No known price for ${model}, so the monthly AI cap cannot be kept`);
    }
    const monthSoFar = await monthToDateUsd(ctx.db, ctx.clock());
    if (monthSoFar + most > ai.monthlyBudgetUsd) {
      stoppedBy = "budget";
      ctx.log.warn(
        { monthSoFar, most, budget: ai.monthlyBudgetUsd },
        "AI monthly budget reached; sentiment waits for next month",
      );
      break;
    }
    const ids = batch.map((b) => b.id);
    let result;
    try {
      result = await ai.client.createMessage(request);
    } catch (err) {
      await recordAiRequest(ctx.db, {
        purpose: "sentiment",
        model,
        promptVersion: SENTIMENT_PROMPT_VERSION,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        details: { articles: ids },
        at: ctx.clock(),
      });
      throw err instanceof AiError ? err : new Error(String(err));
    }
    requests += 1;
    const cost = costUsd(model, result.usage) ?? 0;
    spent += cost;
    const { scores, rejected: refused } = parseSentiment(result.text, new Set(ids));
    rejected += batch.length - scores.length;
    await recordAiRequest(ctx.db, {
      purpose: "sentiment",
      model,
      promptVersion: SENTIMENT_PROMPT_VERSION,
      status: "ok",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      costUsd: cost,
      details: { articles: ids, scored: scores.length, rejected: refused.slice(0, 20) },
      at: ctx.clock(),
    });
    for (const s of scores) {
      await ctx.db
        .updateTable("market.news_articles")
        .set({
          sentiment_label: s.label,
          sentiment_score: s.score.toFixed(2),
          sentiment_model: model,
          sentiment_version: SENTIMENT_PROMPT_VERSION,
          sentiment_at: ctx.clock(),
        })
        .where("article_id", "=", s.id)
        .execute();
      scored += 1;
    }
  }
  return {
    configured: true as const,
    model,
    version: SENTIMENT_PROMPT_VERSION,
    pending: items.length,
    scored,
    rejected,
    requests,
    costUsd: Math.round(spent * 1e6) / 1e6,
    monthToDateUsd: Math.round((await monthToDateUsd(ctx.db, ctx.clock())) * 1e6) / 1e6,
    stoppedBy,
  };
}
