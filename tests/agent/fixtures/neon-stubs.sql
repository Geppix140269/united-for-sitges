-- Minimal stand-ins for Neon-managed objects (Neon Auth, Data API roles,
-- pg_session_jwt) so the real forum schema (neon/schema.sql) and the agent
-- schema (neon/agent-schema.sql) can be applied to a local, throwaway
-- PostgreSQL for testing. NEVER apply this file to Neon.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anonymous') then create role anonymous nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;

-- Neon Auth (Better Auth) user table, reduced to the columns the schemas use.
create schema neon_auth;
create table neon_auth."user" (
  id uuid primary key,
  name text,
  email text not null,
  "emailVerified" boolean not null default false,
  banned boolean,
  "createdAt" timestamptz not null default now()
);

-- pg_session_jwt equivalents: request claims come from session settings.
create schema auth;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth to anonymous, authenticated;
grant execute on function auth.uid(), auth.jwt() to anonymous, authenticated;

-- Broad default privileges on public, so tests prove that the explicit
-- revokes (not luck) are what protect the agent schema.
alter default privileges in schema public grant all on tables to anonymous, authenticated;
alter default privileges in schema public grant all on functions to anonymous, authenticated;
grant usage on schema public to anonymous, authenticated;
