-- Phase 2 step I2: model-estimated news sentiment (spec §5.12, ADR-036), and a log of every AI
-- request with its tokens and cost: the monthly spending cap is checked against it. The log
-- keeps what a request was for and which items it covered, not the prompt text.
create table ops.ai_requests (
  request_id bigint generated always as identity primary key,
  purpose text not null check (purpose in ('sentiment', 'assistant')),
  model text not null,
  prompt_version text,
  status text not null check (status in ('ok', 'error')),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  error text,
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);
create index ai_requests_created_idx on ops.ai_requests (created_at);
alter table ops.ai_requests enable row level security;

-- One estimate per article, with the model and prompt version that made it.
alter table market.news_articles
  add column sentiment_label text check (sentiment_label in ('negative', 'neutral', 'positive')),
  add column sentiment_score numeric(3, 2) check (sentiment_score between -1 and 1),
  add column sentiment_model text,
  add column sentiment_version text,
  add column sentiment_at timestamptz,
  add constraint news_articles_sentiment_complete check (
    (sentiment_label is null) = (sentiment_score is null)
    and (sentiment_label is null) = (sentiment_model is null)
    and (sentiment_label is null) = (sentiment_version is null)
    and (sentiment_label is null) = (sentiment_at is null)
  );
comment on column market.news_articles.sentiment_score is
  'Model-estimated tone for the company, -1 (bad news) to 1 (good news); an estimate, never a signal.';
