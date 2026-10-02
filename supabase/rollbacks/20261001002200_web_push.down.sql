alter table public.alert_events
  drop column push_error,
  drop column push_sent_at,
  drop column push_status,
  drop column summary;

alter table public.alerts drop column channels;

drop table public.push_subscriptions;
