drop table public.notifications;

-- Alerts of kinds the earlier schema does not know (and their events) cannot be kept.
delete from public.alerts
where kind not in ('price_above', 'price_below', 'pct_move', 'earnings_upcoming');

alter table public.alert_events
  drop constraint alert_events_alert_id_event_key_key,
  drop constraint alert_events_event_key_check,
  add constraint alert_events_alert_id_bar_date_key unique (alert_id, bar_date),
  drop column event_key;
comment on column public.alert_events.bar_date is null;

drop index public.alerts_screen_idx;
alter table public.alerts
  drop constraint alerts_watches_check,
  drop constraint alerts_kind_check,
  add constraint alerts_kind_check
    check (kind in ('price_above', 'price_below', 'pct_move', 'earnings_upcoming')),
  drop column snoozed_until,
  drop column state,
  drop column screen_id,
  alter column security_id set not null;
