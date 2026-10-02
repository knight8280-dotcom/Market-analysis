import { sql, type Database } from "@market/db";
import type { NewsItem } from "@market/market-data";
import { DUPLICATE_WINDOW_HOURS, findDuplicate, urlKey } from "@market/news";

export type NewsOutcome = "stored" | "copy" | "known";

/**
 * Stores one news item with the securities it is about (Phase 2 step I1, ADR-035):
 * - the same item from the same source again (a later re-ask, or a re-read press release)
 *   updates its headline and summary;
 * - the same link from elsewhere is the same article: only new securities are added;
 * - a near-identical headline about one of the same securities within two days is stored as a
 *   copy of the first one stored (`duplicate_of`).
 * Null when the link is not one we store (not http(s)).
 */
export async function storeNewsItem(
  db: Database,
  item: NewsItem,
  securityIds: readonly string[],
): Promise<{ articleId: string; outcome: NewsOutcome } | null> {
  const key = urlKey(item.url);
  if (!key) return null;
  return db.transaction().execute(async (trx) => {
    const same = await trx
      .updateTable("market.news_articles")
      .set({
        headline: item.headline,
        described: item.described,
        summary: item.summary,
        publisher: item.publisher,
        category: item.category,
        fetched_at: item.fetched_at,
      })
      .where("source", "=", item.source)
      .where("source_id", "=", item.source_id)
      .returning("article_id")
      .executeTakeFirst();
    const sameLink =
      same ??
      (await trx
        .selectFrom("market.news_articles")
        .select("article_id")
        .where("url_key", "=", key)
        .executeTakeFirst());
    if (sameLink) {
      await tag(trx, sameLink.article_id, securityIds);
      return { articleId: sameLink.article_id, outcome: "known" as const };
    }

    const window = DUPLICATE_WINDOW_HOURS * 3_600_000;
    const candidates =
      securityIds.length === 0 || item.described
        ? []
        : await trx
            .selectFrom("market.news_articles as a")
            .innerJoin("market.news_tickers as t", "t.article_id", "a.article_id")
            .select(["a.article_id", "a.headline", "a.published_at"])
            .distinct()
            .where("t.security_id", "in", securityIds)
            .where("a.duplicate_of", "is", null)
            .where("a.described", "=", false)
            .where("a.published_at", ">=", new Date(item.published_at.getTime() - window))
            .where("a.published_at", "<=", new Date(item.published_at.getTime() + window))
            .execute();
    const copy = findDuplicate(
      { headline: item.headline, publishedAt: item.published_at },
      candidates.map((c) => ({
        id: c.article_id,
        headline: c.headline,
        publishedAt: c.published_at,
      })),
    );
    const row = await trx
      .insertInto("market.news_articles")
      .values({
        source: item.source,
        source_id: item.source_id,
        url: item.url,
        url_key: key,
        headline: item.headline,
        described: item.described,
        summary: item.summary,
        publisher: item.publisher,
        category: item.category,
        published_at: item.published_at,
        fetched_at: item.fetched_at,
        license_tier: item.license_tier,
        duplicate_of: copy?.id ?? null,
      })
      .returning("article_id")
      .executeTakeFirstOrThrow();
    await tag(trx, row.article_id, securityIds);
    return { articleId: row.article_id, outcome: copy ? ("copy" as const) : ("stored" as const) };
  });
}

async function tag(db: Database, articleId: string, securityIds: readonly string[]) {
  if (securityIds.length === 0) return;
  await db
    .insertInto("market.news_tickers")
    .values(
      [...new Set(securityIds)].map((security_id) => ({ article_id: articleId, security_id })),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** 8-Ks with exhibits for our registrants, filed since `since`, not yet read at this version. */
export async function pendingPressReleases(
  db: Database,
  opts: { since: Date; readerVersion: number; ciks?: readonly string[]; limit?: number },
): Promise<{ cik: string; accession_no: string }[]> {
  const rows = await sql<{ cik: string; accession_no: string }>`
    select f.cik, f.accession_no
    from market.filings f
    where f.form_type = '8-K' and '9.01' = any(f.items) and f.filed_at >= ${opts.since}
      and exists (select 1 from market.securities s where s.cik = f.cik)
      and not exists (
        select 1 from market.press_release_checks c
        where c.accession_no = f.accession_no and c.reader_version >= ${opts.readerVersion})
      ${opts.ciks?.length ? sql`and f.cik = any(${[...opts.ciks]}::text[])` : sql``}
    order by f.filed_at desc
    ${opts.limit ? sql`limit ${opts.limit}` : sql``}
  `.execute(db);
  return rows.rows;
}

/** Deletes articles published before `before` (their tags go with them). */
export async function pruneNews(db: Database, before: Date): Promise<number> {
  const result = await db
    .deleteFrom("market.news_articles")
    .where("published_at", "<", before)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
