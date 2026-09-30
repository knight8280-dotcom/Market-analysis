-- LOCAL AND CI ONLY. Never apply this to a Supabase project.
--
-- Stand-ins for objects a Supabase project already has, so migrations and row-level-security
-- tests run against stock Postgres: the anon/authenticated/service_role roles, the auth and
-- extensions schemas, auth.uid()/auth.role(), and Supabase's default grants on schema public
-- (which make any table in public reachable by client roles unless RLS is enabled).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists extensions;
create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.role', true),
      current_setting('request.jwt.claims', true)::jsonb ->> 'role'
    ),
    ''
  )
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
