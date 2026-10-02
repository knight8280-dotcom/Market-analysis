import { AiError, type MessageRequest, type MessageResult } from "@market/ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiServices } from "../src/context";
import { runJob } from "../src/jobs/index";
import { harness, type Harness } from "./helpers/context";

/**
 * Model-estimated news sentiment (Phase 2 step I2) with a stand-in for the Anthropic client:
 * no key and no request leaves the machine. Headlines are made up.
 */
const NOW = "2026-10-02T12:00:00Z";
let h: Harness;
const requests: MessageRequest[] = [];
let reply: (ids: string[]) => string = (ids) =>
  JSON.stringify(ids.map((id) => ({ id, label: "positive", score: 0.4 })));
let failure: Error | null = null;

const client = {
  createMessage(req: MessageRequest): Promise<MessageResult> {
    requests.push(req);
    if (failure) return Promise.reject(failure);
    const { items } = JSON.parse(req.messages[0]!.content) as { items: { id: string }[] };
    return Promise.resolve({
      text: reply(items.map((i) => i.id)),
      model: req.model,
      stopReason: "end_turn",
      usage: { inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 0, cacheReadTokens: 0 },
    });
  },
};
const ai = (over: Partial<AiServices> = {}): AiServices => ({
  client,
  monthlyBudgetUsd: 10,
  sentimentModel: "claude-haiku-4-5-20251001",
  ...over,
});
const run = (services: AiServices | undefined, data: Record<string, unknown> = {}) =>
  runJob({ ...h.ctx, ai: services }, "score-news-sentiment", data);

beforeAll(async () => {
  h = await harness({ now: NOW });
  const { security_id } = await h.t.db
    .insertInto("market.securities")
    .values({ ticker: "EXMP", name: "Example Corp", asset_class: "equity" })
    .returning("security_id")
    .executeTakeFirstOrThrow();
  const add = async (n: number, extra: Record<string, unknown> = {}) => {
    const at = new Date(Date.parse(NOW) - (n + 1) * 3_600_000);
    const row = await h.t.db
      .insertInto("market.news_articles")
      .values({
        source: "finnhub",
        source_id: `story-${n}`,
        url: `https://news.example.invalid/${n}`,
        url_key: `news.example.invalid/${n}`,
        headline: `Example Corp story number ${n}`,
        summary: null,
        publisher: "Example Wire",
        published_at: at,
        fetched_at: at,
        license_tier: "personal_dev",
        ...extra,
      })
      .returning("article_id")
      .executeTakeFirstOrThrow();
    await h.t.db
      .insertInto("market.news_tickers")
      .values({ article_id: row.article_id, security_id })
      .execute();
    return row.article_id;
  };
  const first = await add(0);
  for (let n = 1; n < 25; n += 1) await add(n);
  // Not rated: a copy, an exhibit without a headline, and a story older than 30 days.
  await add(100, { duplicate_of: first });
  await add(101, { described: true, headline: "Example Corp filed Exhibit 99.1 with a Form 8-K" });
  await add(24 * 60);
});
afterAll(async () => {
  await h.t.drop();
});

const rated = () =>
  h.t.db
    .selectFrom("market.news_articles")
    .select([
      "source_id",
      "sentiment_label",
      "sentiment_score",
      "sentiment_model",
      "sentiment_version",
    ])
    .where("sentiment_label", "is not", null)
    .orderBy("source_id")
    .execute();

describe("score-news-sentiment", () => {
  it("does nothing without an Anthropic key", async () => {
    expect(await run(undefined)).toMatchObject({ configured: false });
    expect(requests).toHaveLength(0);
  });

  it("rates new stories in batches of 20, logging each request's tokens and cost", async () => {
    reply = (ids) =>
      JSON.stringify(
        ids.map((id, i) =>
          // One answer contradicts itself: it is not stored.
          i === 0 && ids.length === 5
            ? { id, label: "negative", score: 0.3 }
            : { id, label: "positive", score: 0.4 },
        ),
      );
    expect(await run(ai())).toEqual({
      configured: true,
      model: "claude-haiku-4-5-20251001",
      version: "news-sentiment-v1",
      pending: 25,
      scored: 24,
      rejected: 1,
      requests: 2,
      // Each request: 1,000 input tokens at $1 and 200 output tokens at $5 a million.
      costUsd: 0.004,
      monthToDateUsd: 0.004,
      stoppedBy: null,
    });
    expect(
      requests.map(
        (r) => (JSON.parse(r.messages[0]!.content) as { items: unknown[] }).items.length,
      ),
    ).toEqual([20, 5]);
    expect(requests[0]!.messages[0]!.content).toContain('"companies":["EXMP"]');
    const rows = await rated();
    expect(rows).toHaveLength(24);
    expect(rows[0]).toEqual({
      source_id: "story-0",
      sentiment_label: "positive",
      sentiment_score: "0.40",
      sentiment_model: "claude-haiku-4-5-20251001",
      sentiment_version: "news-sentiment-v1",
    });
    const log = await h.t.db
      .selectFrom("ops.ai_requests")
      .select(["purpose", "status", "input_tokens", "output_tokens", "cost_usd", "prompt_version"])
      .orderBy("request_id")
      .execute();
    expect(log).toEqual([
      {
        purpose: "sentiment",
        status: "ok",
        input_tokens: 1000,
        output_tokens: 200,
        cost_usd: "0.002000",
        prompt_version: "news-sentiment-v1",
      },
      {
        purpose: "sentiment",
        status: "ok",
        input_tokens: 1000,
        output_tokens: 200,
        cost_usd: "0.002000",
        prompt_version: "news-sentiment-v1",
      },
    ]);
  });

  it("asks again only for what is not yet rated by this model and prompt", async () => {
    requests.length = 0;
    expect(await run(ai())).toMatchObject({ pending: 1, scored: 1, requests: 1 });
    expect(await run(ai())).toMatchObject({ pending: 0, requests: 0 });
    expect(requests).toHaveLength(1);
  });

  it("starts no request that could take the month past the budget", async () => {
    requests.length = 0;
    const result = await run(ai({ monthlyBudgetUsd: 0.0061, sentimentModel: "claude-sonnet-5-5" }));
    expect(result).toMatchObject({ pending: 25, requests: 0, scored: 0, stoppedBy: "budget" });
    expect(requests).toHaveLength(0);
  });

  it("refuses a model without a known price, and records a failed request", async () => {
    await expect(run(ai({ sentimentModel: "some-unpriced-model" }))).rejects.toThrow(
      "No known price for some-unpriced-model",
    );
    failure = new AiError("Anthropic refused the request (HTTP 400)", 400, false);
    try {
      await expect(run(ai({ sentimentModel: "claude-sonnet-5-5" }))).rejects.toThrow(AiError);
    } finally {
      failure = null;
    }
    const failed = await h.t.db
      .selectFrom("ops.ai_requests")
      .select(["status", "error", "cost_usd"])
      .where("status", "=", "error")
      .execute();
    expect(failed).toEqual([
      { status: "error", error: "Anthropic refused the request (HTTP 400)", cost_usd: "0.000000" },
    ]);
  });

  it("keeps AI request logs 90 days", async () => {
    await h.t.db
      .insertInto("ops.ai_requests")
      .values({
        purpose: "sentiment",
        model: "claude-haiku-4-5-20251001",
        status: "ok",
        cost_usd: "0.5",
        created_at: new Date("2026-06-01T00:00:00Z"),
      })
      .execute();
    // Everything is rated by now: nothing is sent, and June's request is gone.
    expect(await run(ai())).toMatchObject({ pending: 0, requests: 0, monthToDateUsd: 0.006 });
    const left = await h.t.db.selectFrom("ops.ai_requests").select("created_at").execute();
    expect(left.length).toBe(4);
    expect(left.every((r) => r.created_at >= new Date("2026-07-04T00:00:00Z"))).toBe(true);
  });
});
