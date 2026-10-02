-- Phase 2 group E: more alert kinds, alerts on a saved screen, snoozing, event keys and in-app
-- notifications.
--
-- An alert watches one security or, for screen_membership, one of the owner's saved screens
-- (deleting the screen deletes its alerts). `state` is what an alert remembers between
-- evaluations: how far it has read through stored filings, a screen's last reported results.
-- `snoozed_until` keeps an alert quiet until then. 'insider_purchase' is reserved for step H4,
-- which brings the Form 4 data it needs.
alter table public.alerts
  alter column security_id drop not null,
  add column screen_id bigint references public.saved_screens on delete cascade,
  add column state jsonb not null default '{}' check (jsonb_typeof(state) = 'object'),
  add column snoozed_until timestamptz,
  drop constraint alerts_kind_check,
  add constraint alerts_kind_check check (kind in (
    'price_above', 'price_below', 'pct_move', 'earnings_upcoming', 'rsi_below', 'rsi_above',
    'sma_cross', 'volume_spike', 'new_filing', 'screen_membership', 'insider_purchase')),
  add constraint alerts_watches_check check (
    case when kind = 'screen_membership' then security_id is null and screen_id is not null
    else security_id is not null and screen_id is null end);
create index alerts_screen_idx on public.alerts (screen_id) where screen_id is not null;

-- An event is unique per alert and key: the bar or report date as before, a filing's accession
-- number, or a screener snapshot date with a fingerprint of the screen's results.
alter table public.alert_events add column event_key text;
update public.alert_events set event_key = bar_date::text;
alter table public.alert_events
  alter column event_key set not null,
  add constraint alert_events_event_key_check check (length(event_key) between 1 and 100),
  drop constraint alert_events_alert_id_bar_date_key,
  add constraint alert_events_alert_id_event_key_key unique (alert_id, event_key);
comment on column public.alert_events.bar_date is
  'Date of the data behind the event: the session, earnings report, filing or screener snapshot.';

-- In-app notifications (step E3): one per alert event, written with it while the notifications
-- flag is on. `href` is where it leads: a path in the app, or a filing on www.sec.gov.
create table public.notifications (
  notification_id bigint generated always as identity primary key,
  user_id uuid not null,
  event_id bigint not null unique references public.alert_events on delete cascade,
  title text not null check (length(title) between 1 and 300),
  body text not null default '' check (length(body) <= 4000),
  href text check (href ~ '^(/[^/\\]|https://www\.sec\.gov/)'),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;
revoke all on public.notifications from anon;
create policy notifications_own_rows on public.notifications for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
