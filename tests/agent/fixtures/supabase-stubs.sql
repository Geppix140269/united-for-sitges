-- Minimal stand-ins for Supabase-managed objects so the real forum schema,
-- existing migrations and the agent migration can be applied to a local,
-- throwaway PostgreSQL for testing. NEVER apply this file to Supabase.
-- Roles are cluster-wide, so create them only once (supports reset).
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  is_anonymous boolean default false
);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
-- Supabase grants broad default privileges on public to API roles; mimic it
-- so tests prove our explicit revokes are what protect the agent schema.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Production object created by an unrecorded migration
-- (reserve_primary_forum_administrator_email).
create schema ufs_internal;
create table ufs_internal.admin_contact (
  singleton boolean primary key default true check (singleton),
  email text not null,
  updated_at timestamptz not null default now()
);
insert into ufs_internal.admin_contact(email) values ('admin@example.test');
