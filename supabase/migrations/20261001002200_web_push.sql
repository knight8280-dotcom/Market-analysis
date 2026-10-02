-- Web Push (Phase 2 step J2, ADR-038): one row per browser that turned push notifications on;
-- alerts choose email, push or both; each alert event records its push delivery beside its
-- email delivery (delivery_status).

create table public.push_subscriptions (
  subscription_id bigint generated always as identity primary key,
  user_id uuid not null,
  -- The push service's address for this browser. It works as a capability: it is never shown
  -- or logged in full.
  endpoint text not null unique check (length(endpoint) between 1 and 2048),
  -- The browser's P-256 public key (65 bytes) and authentication secret (16 bytes), base64url.
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{22}$'),
  -- "Chrome on Android": from the browser's user agent when it subscribed.
  device text not null check (length(device) between 1 and 100),
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  failures integer not null default 0 check (failures >= 0),
  last_error text check (length(last_error) <= 500)
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
create policy push_subscriptions_own_rows on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Existing alerts keep sending email only; new ones choose.
alter table public.alerts
  add column channels text[] not null default '{email}'
    constraint alerts_channels_check
    check (channels in ('{email}'::text[], '{push}'::text[], '{email,push}'::text[]));

-- The short text shown by in-app and push notifications, and the push delivery. Events from
-- before push existed are marked so and never pushed; new events start pending.
alter table public.alert_events
  add column summary text check (length(summary) <= 4000),
  add column push_status text not null default 'suppressed'
    constraint alert_events_push_status_check
    check (push_status in ('pending', 'sent', 'failed', 'suppressed')),
  add column push_sent_at timestamptz,
  add column push_error text check (length(push_error) <= 500);
update public.alert_events set push_error = 'fired before push notifications existed';
alter table public.alert_events alter column push_status set default 'pending';
