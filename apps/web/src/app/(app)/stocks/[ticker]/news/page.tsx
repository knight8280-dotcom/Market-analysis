import { DataLabel } from "@market/compliance/client";
import { loadWebEnv } from "@market/config";
import { Badge, Card, CardContent, CardHeader, cn, EmptyState, formatDateTimeET } from "@market/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "../../../../../server/auth/owner";
import { db } from "../../../../../server/db";
import { enabledFlags } from "../../../../../server/flags";
import { assertDisplayable, sourceInfo } from "../../../../../server/market";
import { newsFor, type NewsFilter, type NewsStory } from "../../../../../server/news";
import { securityForTicker, tickerOf } from "../../../../../server/stock";

type Params = Promise<{ ticker: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: `${tickerOf((await params).ticker)} news` };
}

const DAYS = 90;
const FILTERS: { id: NewsFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "press", label: "Press releases" },
  { id: "news", label: "News" },
];

const muted = "text-xs text-muted-foreground";

/**
 * News tab (Phase 2 step I1, spec §5.12): company news from Finnhub and the press releases the
 * company filed with SEC, as each source gives them, with the source, time and a link out.
 */
export default async function NewsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await requireOwner();
  const flags = await enabledFlags();
  if (!flags.news) notFound();
  const ticker = tickerOf((await params).ticker);
  const security = await securityForTicker(ticker);
  if (!security) notFound();
  const q = await searchParams;
  const filter = FILTERS.find((f) => f.id === q.source)?.id ?? "all";

  const appEnv = loadWebEnv().APP_ENV;
  assertDisplayable("finnhub", "news", appEnv);
  assertDisplayable("sec_edgar", "filings", appEnv);
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const { stories, truncated } = await newsFor(db(), security.securityId, { since, filter });
  const base = `/stocks/${encodeURIComponent(security.ticker)}/news`;
  const latest = (source: "finnhub" | "sec_edgar") =>
    stories
      .flatMap((s) => [s, ...s.copies.map((c) => ({ ...s, ...c }))])
      .filter((s) => s.source === source)
      .reduce<NewsStory | null>((m, s) => (m && m.fetchedAt > s.fetchedAt ? m : s), null);
  const fromFinnhub = latest("finnhub");
  const models = [
    ...new Set(
      stories
        .filter((s) => s.sentiment)
        .map((s) => `${s.sentiment!.model} with prompt ${s.sentiment!.version}`),
    ),
  ];
  const fromSec = latest("sec_edgar");

  return (
    <Card aria-labelledby="news-title">
      <CardHeader
        title={<span id="news-title">News</span>}
        description={`Company news and press releases filed with SEC, last ${DAYS} days, newest first`}
      />
      <CardContent className="flex flex-col gap-4">
        <nav aria-label="Show" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Link
              key={f.id}
              href={f.id === "all" ? base : `${base}?source=${f.id}`}
              aria-current={f.id === filter ? "true" : undefined}
              className={cn(
                "flex min-h-8 items-center rounded-md px-2.5 text-sm whitespace-nowrap hover:bg-muted",
                f.id === filter && "bg-muted font-medium",
              )}
            >
              {f.label}
            </Link>
          ))}
        </nav>
        {stories.length === 0 ? (
          <EmptyState
            title={`No ${filter === "press" ? "press releases" : "news"} in the last ${DAYS} days`}
          >
            Press releases come from the company&apos;s 8-K filings on SEC EDGAR (read after the
            evening filings refresh, or <code>pnpm worker press-releases</code>). Company news comes
            from Finnhub once <code>FINNHUB_API_KEY</code> is set, twice a day.
          </EmptyState>
        ) : (
          <ol className="flex flex-col divide-y" aria-label={`${security.ticker} news`}>
            {stories.map((s) => (
              <Story key={s.id} story={s} />
            ))}
          </ol>
        )}
        {truncated ? <p className={muted}>The latest {stories.length} stories.</p> : null}
        <section
          id="about-sentiment"
          aria-labelledby="about-sentiment-title"
          className="flex flex-col gap-1"
        >
          <h3 id="about-sentiment-title" className="text-sm font-medium">
            About model-estimated sentiment
          </h3>
          <p className={muted}>
            An AI model reads each story&apos;s headline and summary, and only those, and estimates
            whether the news is bad (−1) or good (+1) for the company, with 0 for neutral or mixed
            news. It is an estimate: it can be wrong, it knows nothing beyond the text, and it is
            not a signal or advice. Copies of a story and filings without a headline are not rated.
            {models.length > 0
              ? ` Estimates here come from ${models.join(", ")}.`
              : " Estimates appear once an Anthropic API key is set (ANTHROPIC_API_KEY)."}
          </p>
        </section>
        <div className="flex flex-col gap-1">
          <p className={muted}>
            Headlines, summaries and links as each source gives them; the full articles are on the
            publishers&apos; sites. Press releases are what the company filed with SEC as Exhibit 99
            to Form 8-K. A story carried by several outlets is listed once, with the others under
            &quot;Also&quot;. For information only: not investment advice.
          </p>
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            {fromSec ? (
              <DataLabel
                source={sourceInfo("sec_edgar")}
                kind="filing"
                asOf={fromSec.publishedAt.toISOString().slice(0, 10)}
                fetchedAt={fromSec.fetchedAt}
              />
            ) : null}
            {fromFinnhub ? (
              <DataLabel
                source={sourceInfo("finnhub")}
                kind="observation"
                asOf={fromFinnhub.fetchedAt.toISOString().slice(0, 10)}
                fetchedAt={fromFinnhub.fetchedAt}
              />
            ) : null}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

const TONE = {
  positive: { label: "Positive", mark: "▲", tone: "up" },
  neutral: { label: "Neutral", mark: "●", tone: "neutral" },
  negative: { label: "Negative", mark: "▼", tone: "down" },
} as const;

/** The estimate in words, a mark and a score: never color alone. */
function Sentiment({ sentiment }: { sentiment: NonNullable<NewsStory["sentiment"]> }) {
  const t = TONE[sentiment.label];
  const score = `${sentiment.score > 0 ? "+" : sentiment.score < 0 ? "−" : ""}${Math.abs(sentiment.score).toFixed(2)}`;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-2", muted)}>
      <span>Model-estimated sentiment:</span>{" "}
      <Badge tone={t.tone}>
        <span aria-hidden>{t.mark}</span> {t.label} ({score})
      </Badge>{" "}
      <a href="#about-sentiment" className="text-primary underline underline-offset-2">
        What is this?
      </a>
    </p>
  );
}

function Story({ story: s }: { story: NewsStory }) {
  const press = s.source === "sec_edgar";
  return (
    <li className="flex flex-col gap-1 py-3 first:pt-0">
      <a
        href={s.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className={cn(
          "font-medium text-primary underline-offset-2 hover:underline",
          s.described && "font-normal italic",
        )}
      >
        {s.headline}
        <span className="sr-only"> (opens the {press ? "filing" : "article"})</span>
      </a>
      <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", muted)}>
        <Badge tone={press ? "info" : "neutral"}>{press ? "Press release" : "News"}</Badge>
        {s.publisher ? <span>{s.publisher}</span> : null}
        <time dateTime={s.publishedAt.toISOString()}>{formatDateTimeET(s.publishedAt)}</time>
        <span>{press ? "SEC EDGAR, Form 8-K" : "via Finnhub"}</span>
        {s.described ? <span>No headline in the filing; this says what was filed.</span> : null}
      </span>
      {s.summary ? <p className="line-clamp-3 text-sm">{s.summary}</p> : null}
      {s.sentiment ? <Sentiment sentiment={s.sentiment} /> : null}
      {s.copies.length > 0 ? (
        <p className={muted}>
          Also:{" "}
          {s.copies.map((c, i) => (
            <span key={c.id}>
              {i > 0 ? ", " : null}
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-primary underline underline-offset-2"
              >
                {c.publisher ?? (c.source === "sec_edgar" ? "SEC filing" : "Finnhub")}
              </a>
            </span>
          ))}
        </p>
      ) : null}
    </li>
  );
}
