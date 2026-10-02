import "server-only";
import type { Database } from "@market/db";
import { ProviderId } from "@market/market-data";

/**
 * News tab data (Phase 2 step I1, spec §5.12): the stories tagged with a security, newest
 * first. Copies of a story (the same headline from another outlet) are folded under the first
 * one stored, with their own links.
 */

export interface NewsLink {
  id: string;
  source: ProviderId;
  publisher: string | null;
  url: string;
}

export interface NewsStory extends NewsLink {
  headline: string;
  /** The headline is our description of what was filed, not the item's own words. */
  described: boolean;
  summary: string | null;
  category: string | null;
  publishedAt: Date;
  fetchedAt: Date;
  /** The same story elsewhere. */
  copies: NewsLink[];
  /** Model-estimated tone for the company; null when not rated. */
  sentiment: {
    label: "negative" | "neutral" | "positive";
    score: number;
    model: string;
    version: string;
    at: Date;
  } | null;
}

export type NewsFilter = "all" | "press" | "news";

export async function newsFor(
  database: Database,
  securityId: string,
  opts: { since: Date; filter: NewsFilter; limit?: number },
): Promise<{ stories: NewsStory[]; truncated: boolean }> {
  const limit = opts.limit ?? 100;
  const tagged = await database
    .selectFrom("market.news_articles as a")
    .innerJoin("market.news_tickers as t", "t.article_id", "a.article_id")
    .select([
      "a.article_id",
      "a.duplicate_of",
      "a.source",
      "a.headline",
      "a.described",
      "a.summary",
      "a.publisher",
      "a.category",
      "a.url",
      "a.published_at",
      "a.fetched_at",
      "a.sentiment_label",
      "a.sentiment_score",
      "a.sentiment_model",
      "a.sentiment_version",
      "a.sentiment_at",
    ])
    .where("t.security_id", "=", securityId)
    .where("a.published_at", ">=", opts.since)
    .$if(opts.filter === "press", (q) => q.where("a.source", "=", "sec_edgar"))
    .$if(opts.filter === "news", (q) => q.where("a.source", "<>", "sec_edgar"))
    .orderBy("a.published_at", "desc")
    .orderBy("a.article_id", "desc")
    .limit(limit * 3)
    .execute();

  // A copy shows under its story; the story itself is fetched when only the copy is tagged.
  const byId = new Map(tagged.map((a) => [a.article_id, a]));
  const missing = [
    ...new Set(tagged.map((a) => a.duplicate_of).filter((id): id is string => id !== null)),
  ].filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const roots = await database
      .selectFrom("market.news_articles as a")
      .select([
        "a.article_id",
        "a.duplicate_of",
        "a.source",
        "a.headline",
        "a.described",
        "a.summary",
        "a.publisher",
        "a.category",
        "a.url",
        "a.published_at",
        "a.fetched_at",
        "a.sentiment_label",
        "a.sentiment_score",
        "a.sentiment_model",
        "a.sentiment_version",
        "a.sentiment_at",
      ])
      .where("a.article_id", "in", missing)
      .execute();
    for (const r of roots) byId.set(r.article_id, r);
  }

  const stories = new Map<string, NewsStory>();
  const link = (a: (typeof tagged)[number]): NewsLink => ({
    id: a.article_id,
    source: ProviderId.parse(a.source),
    publisher: a.publisher,
    url: a.url,
  });
  const ordered = [...byId.values()].sort(
    (x, y) => x.published_at.getTime() - y.published_at.getTime(),
  );
  for (const a of ordered) {
    const rootId = a.duplicate_of && byId.has(a.duplicate_of) ? a.duplicate_of : a.article_id;
    if (rootId === a.article_id) {
      stories.set(a.article_id, {
        ...link(a),
        headline: a.headline,
        described: a.described,
        summary: a.summary,
        category: a.category,
        publishedAt: a.published_at,
        fetchedAt: a.fetched_at,
        copies: stories.get(a.article_id)?.copies ?? [],
        sentiment:
          a.sentiment_label &&
          a.sentiment_score !== null &&
          a.sentiment_model &&
          a.sentiment_version &&
          a.sentiment_at
            ? {
                label: a.sentiment_label as "negative" | "neutral" | "positive",
                score: Number(a.sentiment_score),
                model: a.sentiment_model,
                version: a.sentiment_version,
                at: a.sentiment_at,
              }
            : null,
      });
    }
  }
  for (const a of ordered) {
    const rootId = a.duplicate_of && byId.has(a.duplicate_of) ? a.duplicate_of : a.article_id;
    if (rootId !== a.article_id) stories.get(rootId)?.copies.push(link(a));
  }
  const all = [...stories.values()]
    .filter(
      (s) => opts.filter === "all" || (opts.filter === "press") === (s.source === "sec_edgar"),
    )
    .sort(
      (x, y) => y.publishedAt.getTime() - x.publishedAt.getTime() || Number(y.id) - Number(x.id),
    );
  return { stories: all.slice(0, limit), truncated: all.length > limit };
}
