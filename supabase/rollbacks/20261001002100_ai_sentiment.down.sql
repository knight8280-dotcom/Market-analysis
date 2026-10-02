alter table market.news_articles
  drop constraint news_articles_sentiment_complete,
  drop column sentiment_at,
  drop column sentiment_version,
  drop column sentiment_model,
  drop column sentiment_score,
  drop column sentiment_label;
drop table ops.ai_requests;
