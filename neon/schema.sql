-- United for Sitges community schema for Neon (Postgres 18, Neon Data API + Neon Auth).
-- Port of supabase/forum-schema.sql plus the 11 Nov 2026 migrations (supabase/migrations/).
-- Applied to Neon project united-for-sitges (shiny-dream-02523490), branch production, 18 Nov 2026.
--
-- Differences from the Supabase version:
--   * user ids reference neon_auth."user"(id) (uuid) instead of auth.users(id).
--   * the Data API role for signed-out visitors is "anonymous" (Supabase: "anon").
--   * auth.uid() and auth.jwt() are provided by Neon's pg_session_jwt extension.
--   * moderator bootstrap: Neon Auth requires a verified email code at sign-up, so the
--     Supabase magic-link (amr) check is replaced by neon_auth."user"."emailVerified".
--   * the reserved display names may be used only by the verified administrator.
-- Never expose a database password or owner role in browser code.

create table if not exists public.ufs_profiles (
  user_id uuid primary key references neon_auth."user"(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 2 and 40),
  is_moderator boolean not null default false,
  is_suspended boolean not null default false,
  joined_at timestamptz not null default now()
);
create table if not exists public.ufs_topics (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references neon_auth."user"(id) on delete cascade,
  author_name text not null check (char_length(trim(author_name)) between 2 and 40),
  category text not null check (category in ('voting','living','issues','questions','official')),
  title text not null check (char_length(trim(title)) between 6 and 140),
  body text not null check (char_length(trim(body)) between 20 and 4000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create table if not exists public.ufs_replies (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.ufs_topics(id) on delete cascade,
  author_id uuid not null references neon_auth."user"(id) on delete cascade,
  author_name text not null check (char_length(trim(author_name)) between 2 and 40),
  body text not null check (char_length(trim(body)) between 3 and 2500),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create table if not exists public.ufs_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references neon_auth."user"(id) on delete cascade,
  topic_id uuid not null references public.ufs_topics(id) on delete cascade,
  reply_id uuid references public.ufs_replies(id) on delete cascade,
  reason text not null check (length(trim(reason)) between 10 and 750),
  status text not null default 'open' check (status in ('open','reviewed','dismissed')),
  created_at timestamptz not null default now(),
  unique nulls not distinct (reporter_id, topic_id, reply_id)
);

create index if not exists ufs_topics_status_created_idx on public.ufs_topics (status, created_at desc);
create index if not exists ufs_topics_author_idx on public.ufs_topics (author_id);
create index if not exists ufs_topics_author_time_idx on public.ufs_topics (author_id, created_at desc);
create index if not exists ufs_replies_topic_status_created_idx on public.ufs_replies (topic_id, status, created_at);
create index if not exists ufs_replies_author_idx on public.ufs_replies (author_id);
create index if not exists ufs_replies_author_time_idx on public.ufs_replies (author_id, created_at desc);
create index if not exists ufs_reports_queue_idx on public.ufs_reports (status, created_at desc);
create index if not exists ufs_reports_reporter_time_idx on public.ufs_reports (reporter_id, created_at desc);

alter table public.ufs_profiles enable row level security;
alter table public.ufs_topics enable row level security;
alter table public.ufs_replies enable row level security;
alter table public.ufs_reports enable row level security;

-- Private schema: not exposed by the Data API, no grants to anonymous/authenticated.
create schema if not exists ufs_internal;
revoke all on schema ufs_internal from public, anonymous, authenticated;
create table if not exists ufs_internal.admin_contact (
  singleton boolean primary key default true check (singleton),
  email text not null check (email = lower(trim(email)))
);
insert into ufs_internal.admin_contact (singleton, email)
values (true, 'hello@unitedforsitges.com')
on conflict (singleton) do update set email = excluded.email;

create or replace function ufs_internal.is_admin_email(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from neon_auth."user" u
    join ufs_internal.admin_contact a on a.singleton and lower(u.email) = a.email
    where u.id = uid and u."emailVerified" = true and coalesce(u.banned, false) = false
  );
$$;
revoke all on function ufs_internal.is_admin_email(uuid) from public, anonymous, authenticated;
-- The profile insert policy calls it as the signed-in member. ufs_internal is not exposed by the Data API.
grant usage on schema ufs_internal to authenticated;
grant execute on function ufs_internal.is_admin_email(uuid) to authenticated;

-- Explicit Data API privileges. Every exposed table also has RLS.
revoke all on public.ufs_profiles, public.ufs_topics, public.ufs_replies, public.ufs_reports
  from public, anonymous, authenticated;
grant usage on schema public to anonymous, authenticated;
-- Note: auth.uid()/auth.jwt() (pg_session_jwt, schema auth owned by cloud_admin) resolve inside
-- policies (bound when the policy is created) but not inside function bodies run as the member.
grant select (user_id, display_name, is_moderator, is_suspended, joined_at) on public.ufs_profiles to authenticated;
grant insert (user_id, display_name) on public.ufs_profiles to authenticated;
-- Needed by anonymous RLS checks on topics and replies; no anonymous policy returns profile rows.
grant select (user_id, is_moderator, is_suspended) on public.ufs_profiles to anonymous;
grant select on public.ufs_topics, public.ufs_replies to anonymous, authenticated;
grant insert (author_id, author_name, category, title, body) on public.ufs_topics to authenticated;
grant insert (topic_id, author_id, author_name, body) on public.ufs_replies to authenticated;
grant update (status) on public.ufs_topics, public.ufs_replies to authenticated;
grant select on public.ufs_reports to authenticated;
grant insert (reporter_id, topic_id, reply_id, reason) on public.ufs_reports to authenticated;
grant update (status) on public.ufs_reports to authenticated;

-- Profiles
drop policy if exists "ufs member sees own profile" on public.ufs_profiles;
create policy "ufs member sees own profile" on public.ufs_profiles
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "ufs member creates own non-moderator profile" on public.ufs_profiles;
create policy "ufs member creates own non-moderator profile" on public.ufs_profiles
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and is_moderator = false and is_suspended = false
    and (
      lower(trim(display_name)) <> all (array[
        'united for sitges','unitedforsitges','ufs admin','admin','administrator',
        'moderator','official information','sitges town hall','ajuntament de sitges'])
      or ufs_internal.is_admin_email((select auth.uid()))
    )
  );

-- Topics
drop policy if exists "ufs public approved topics or own or moderator" on public.ufs_topics;
create policy "ufs public approved topics or own or moderator" on public.ufs_topics
  for select to anonymous, authenticated
  using (
    status = 'approved' or author_id = (select auth.uid())
    or exists (select 1 from public.ufs_profiles p
       where p.user_id = (select auth.uid()) and p.is_moderator and not p.is_suspended)
  );
drop policy if exists "ufs member inserts pending topics" on public.ufs_topics;
create policy "ufs member inserts pending topics" on public.ufs_topics
  for insert to authenticated
  with check (
    author_id = (select auth.uid()) and status = 'pending'
    and author_name = (select p.display_name from public.ufs_profiles p where p.user_id = (select auth.uid()))
    and (category <> 'official' or exists (select 1 from public.ufs_profiles p
       where p.user_id = (select auth.uid()) and p.is_moderator and not p.is_suspended))
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and exists (select 1 from public.ufs_profiles p
       where p.user_id = (select auth.uid()) and not p.is_suspended)
  );
drop policy if exists "ufs moderator sets topic status" on public.ufs_topics;
create policy "ufs moderator sets topic status" on public.ufs_topics
  for update to authenticated
  using (exists (select 1 from public.ufs_profiles p
      where p.user_id = (select auth.uid()) and p.is_moderator and not p.is_suspended))
  with check (exists (select 1 from public.ufs_profiles p
      where p.user_id = (select auth.uid()) and p.is_moderator and not p.is_suspended));

-- Replies
drop policy if exists "ufs approved replies or own or moderator" on public.ufs_replies;
create policy "ufs approved replies or own or moderator" on public.ufs_replies
  for select to anonymous, authenticated
  using (
    (status = 'approved' and exists (
        select 1 from public.ufs_topics t where t.id = topic_id and t.status = 'approved'))
    or author_id = (select auth.uid())
    or exists (select 1 from public.ufs_profiles p
       where p.user_id = (select auth.uid()) and p.is_moderator and not p.is_suspended)
  );
drop policy if exists "ufs member inserts pending replies" on public.ufs_replies;
create policy "ufs member inserts pending replies" on public.ufs_replies
  for insert to authenticated
  with check (
    author_id = (select auth.uid()) and status = 'pending'
    and author_name = (select p.display_name from public.ufs_profiles p where p.user_id = (select auth.uid()))
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and exists (select 1 from public.ufs_topics t where t.id = topic_id and t.status = 'approved')
    and exists (select 1 from public.ufs_profiles p
       where p.user_id = (select auth.uid()) and not p.is_suspended)
  );
drop policy if exists "ufs moderator sets reply status" on public.ufs_replies;
create policy "ufs moderator sets reply status" on public.ufs_replies
  for update to authenticated
  using (exists (select 1 from public.ufs_profiles p
      where p.user_id = (select auth.uid()) and p.is_moderator and not p.is_suspended))
  with check (exists (select 1 from public.ufs_profiles p
      where p.user_id = (select auth.uid()) and p.is_moderator and not p.is_suspended));

-- Reports
drop policy if exists "ufs member reports readable only to reporter or moderator" on public.ufs_reports;
create policy "ufs member reports readable only to reporter or moderator" on public.ufs_reports
  for select to authenticated using (
    reporter_id = (select auth.uid()) or exists (select 1 from public.ufs_profiles p
      where p.user_id = (select auth.uid()) and p.is_moderator and not p.is_suspended));
drop policy if exists "ufs verified member may report public discussions" on public.ufs_reports;
create policy "ufs verified member may report public discussions" on public.ufs_reports
  for insert to authenticated with check (
    reporter_id = (select auth.uid())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and exists (select 1 from public.ufs_profiles p
      where p.user_id = (select auth.uid()) and not p.is_suspended)
    and exists (select 1 from public.ufs_topics t
      where t.id = ufs_reports.topic_id and t.status = 'approved')
    and (ufs_reports.reply_id is null or exists (select 1 from public.ufs_replies r
      where r.id = ufs_reports.reply_id and r.topic_id = ufs_reports.topic_id and r.status = 'approved'))
  );
drop policy if exists "ufs moderator reviews reports" on public.ufs_reports;
create policy "ufs moderator reviews reports" on public.ufs_reports
  for update to authenticated
  using (exists (select 1 from public.ufs_profiles p
    where p.user_id = (select auth.uid()) and p.is_moderator and not p.is_suspended))
  with check (exists (select 1 from public.ufs_profiles p
    where p.user_id = (select auth.uid()) and p.is_moderator and not p.is_suspended));

-- Early-abuse control: at most 3 topics, 12 replies and 5 reports per hour per member.
-- Active moderators are exempt.
create or replace function public.ufs_limit_member_submissions()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid;
  in_last_hour integer;
  limit_per_hour integer;
begin
  if TG_TABLE_NAME = 'ufs_topics' then
    actor := new.author_id; limit_per_hour := 3;
  elsif TG_TABLE_NAME = 'ufs_replies' then
    actor := new.author_id; limit_per_hour := 12;
  elsif TG_TABLE_NAME = 'ufs_reports' then
    actor := new.reporter_id; limit_per_hour := 5;
  else
    raise exception 'Unexpected community submission type';
  end if;
  -- Ownership (actor = auth.uid()) is enforced by the insert policies. The auth schema is
  -- not visible to the member role at run time on Neon, so it is not referenced here.
  if exists (select 1 from public.ufs_profiles p
      where p.user_id = actor and p.is_moderator and not p.is_suspended) then
    return new;
  end if;
  if TG_TABLE_NAME = 'ufs_topics' then
    select count(*) into in_last_hour from public.ufs_topics t
      where t.author_id = actor and t.created_at > now() - interval '1 hour';
  elsif TG_TABLE_NAME = 'ufs_replies' then
    select count(*) into in_last_hour from public.ufs_replies r
      where r.author_id = actor and r.created_at > now() - interval '1 hour';
  else
    select count(*) into in_last_hour from public.ufs_reports r
      where r.reporter_id = actor and r.created_at > now() - interval '1 hour';
  end if;
  if in_last_hour >= limit_per_hour then
    raise exception 'Community posting limit reached. Please try again later.';
  end if;
  return new;
end;
$$;
revoke all on function public.ufs_limit_member_submissions() from public, anonymous, authenticated;
drop trigger if exists ufs_topics_limit_member_submissions on public.ufs_topics;
create trigger ufs_topics_limit_member_submissions before insert on public.ufs_topics
  for each row execute function public.ufs_limit_member_submissions();
drop trigger if exists ufs_replies_limit_member_submissions on public.ufs_replies;
create trigger ufs_replies_limit_member_submissions before insert on public.ufs_replies
  for each row execute function public.ufs_limit_member_submissions();
drop trigger if exists ufs_reports_limit_member_submissions on public.ufs_reports;
create trigger ufs_reports_limit_member_submissions before insert on public.ufs_reports
  for each row execute function public.ufs_limit_member_submissions();

-- Moderator bootstrap: only the verified owner of the reserved admin email becomes moderator.
create or replace function ufs_internal.promote_verified_primary_moderator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if ufs_internal.is_admin_email(new.user_id) then
    update public.ufs_profiles set is_moderator = true where user_id = new.user_id;
  end if;
  return new;
end;
$$;
revoke all on function ufs_internal.promote_verified_primary_moderator() from public, anonymous, authenticated;
drop trigger if exists ufs_promote_verified_primary_moderator on public.ufs_profiles;
create trigger ufs_promote_verified_primary_moderator
  after insert on public.ufs_profiles
  for each row execute function ufs_internal.promote_verified_primary_moderator();
