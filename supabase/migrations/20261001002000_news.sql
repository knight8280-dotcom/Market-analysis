-- Phase 2 step I1: news (spec §5.12, ADR-035). Articles from a licensed feed (Finnhub, on the
-- owner's personal key) and company press releases filed with SEC as 8-K exhibits. Headline,
-- summary and link are stored as the source gives them; the full text of articles is not.
-- A copy of a story (same link, or a near-identical headline within two days) is kept and
-- marked, never deleted, so every source still shows.
create table market.news_articles (
  article_id bigint generated always as identity primary key,
  source text not null references market.data_providers,
  source_id text not null check (length(source_id) between 1 and 200),
  url text not null check (url ~ '^https?://' and length(url) <= 2000),
  url_key text not null unique,
  headline text not null check (length(headline) between 1 and 500),
  described boolean not null default false,
  summary text check (length(summary) between 1 and 5000),
  publisher text check (length(publisher) between 1 and 200),
  category text check (length(category) between 1 and 100),
  published_at timestamptz not null,
  fetched_at timestamptz not null,
  license_tier text not null,
  duplicate_of bigint references market.news_articles on delete set null
    check (duplicate_of <> article_id),
  unique (source, source_id)
);
create index news_articles_published_idx on market.news_articles (published_at desc);
comment on column market.news_articles.described is
  'True when the headline is our description of what was filed (an exhibit without a readable headline), not the item''s own words.';
comment on column market.news_articles.duplicate_of is
  'The earlier article this one copies (a near-identical headline within two days); copies are hidden behind it, not deleted.';

-- Which of our securities an article is about: the feed's tags, or the filer's CIK.
create table market.news_tickers (
  article_id bigint not null references market.news_articles on delete cascade,
  security_id bigint not null references market.securities on delete cascade,
  primary key (article_id, security_id)
);
create index news_tickers_security_idx on market.news_tickers (security_id, article_id desc);

-- Each 8-K is looked at once for a press release (found or not), until the reader changes.
create table market.press_release_checks (
  accession_no text primary key check (accession_no ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  cik text not null check (cik ~ '^[0-9]{10}$'),
  outcome text not null check (outcome in ('stored', 'copy', 'none')),
  article_id bigint references market.news_articles on delete set null,
  reader_version integer not null check (reader_version > 0),
  checked_at timestamptz not null
);

alter table market.news_articles enable row level security;
alter table market.news_tickers enable row level security;
alter table market.press_release_checks enable row level security;
