-- United for Sitges — isolated community schema v1
-- Apply ONLY to a new, dedicated United for Sitges Supabase project.
-- Review with a data-protection professional before enabling member registration.
-- All posts require moderator approval before public visibility.
-- Never expose a service_role/secret key in browser code.

create extension if not exists pgcrypto;

create table if not exists public.ufs_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 2 and 40),
  is_moderator boolean not null default false,
  is_suspended boolean not null default false,
  joined_at timestamptz not null default now()
);
create table if not exists public.ufs_topics (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
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
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null check (char_length(trim(author_name)) between 2 and 40),
  body text not null check (char_length(trim(body)) between 3 and 2500),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create index if not exists ufs_topics_status_created_idx on public.ufs_topics (status,created_at desc);
create index if not exists ufs_topics_author_idx on public.ufs_topics (author_id);
create index if not exists ufs_replies_topic_status_created_idx on public.ufs_replies(topic_id,status,created_at);
create index if not exists ufs_replies_author_idx on public.ufs_replies(author_id);

alter table public.ufs_profiles enable row level security;
alter table public.ufs_topics enable row level security;
alter table public.ufs_replies enable row level security;

-- Explicit Data API privileges. Exposing a table always also requires RLS.
revoke all on public.ufs_profiles,public.ufs_topics,public.ufs_replies from anon,authenticated;
grant usage on schema public to anon,authenticated;
grant select(user_id,display_name,is_moderator,is_suspended,joined_at) on public.ufs_profiles to authenticated;
grant insert(user_id,display_name) on public.ufs_profiles to authenticated;
grant select on public.ufs_topics,public.ufs_replies to anon,authenticated;
grant insert(author_id,author_name,category,title,body) on public.ufs_topics to authenticated;
grant insert(topic_id,author_id,author_name,body) on public.ufs_replies to authenticated;
grant update(status) on public.ufs_topics,public.ufs_replies to authenticated;

create policy "ufs member sees own profile" on public.ufs_profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy "ufs member creates own non-moderator profile" on public.ufs_profiles
  for insert to authenticated with check (
     user_id = (select auth.uid()) and is_moderator=false and is_suspended=false
  );

-- A verified authenticated member may create a pending topic.
-- Moderators are assigned only by an operator in SQL, never user_metadata.
create policy "ufs public approved topics or own or moderator" on public.ufs_topics
  for select to anon,authenticated
  using (
    status='approved' or author_id = (select auth.uid())
    or exists(select 1 from public.ufs_profiles p
       where p.user_id=(select auth.uid()) and p.is_moderator=true and p.is_suspended=false)
  );
create policy "ufs member inserts pending topics" on public.ufs_topics
  for insert to authenticated
  with check (
    author_id=(select auth.uid()) and status='pending'
    and exists(select 1 from public.ufs_profiles p
      where p.user_id=(select auth.uid()) and p.is_suspended=false)
  );
create policy "ufs moderator sets topic status" on public.ufs_topics
  for update to authenticated
  using (exists(select 1 from public.ufs_profiles p
      where p.user_id=(select auth.uid()) and p.is_moderator=true and p.is_suspended=false))
  with check (exists(select 1 from public.ufs_profiles p
      where p.user_id=(select auth.uid()) and p.is_moderator=true and p.is_suspended=false));

create policy "ufs approved replies or own or moderator" on public.ufs_replies
  for select to anon,authenticated
  using (
    (status='approved' and exists (
        select 1 from public.ufs_topics t where t.id=topic_id and t.status='approved'
    )) or author_id=(select auth.uid())
    or exists(select 1 from public.ufs_profiles p
       where p.user_id=(select auth.uid()) and p.is_moderator=true and p.is_suspended=false)
  );
create policy "ufs member inserts pending replies" on public.ufs_replies
  for insert to authenticated
  with check (
    author_id=(select auth.uid()) and status='pending'
    and exists(select 1 from public.ufs_topics t where t.id=topic_id and t.status='approved')
    and exists(select 1 from public.ufs_profiles p
       where p.user_id=(select auth.uid()) and p.is_suspended=false)
  );
create policy "ufs moderator sets reply status" on public.ufs_replies
  for update to authenticated
  using (exists(select 1 from public.ufs_profiles p
      where p.user_id=(select auth.uid()) and p.is_moderator=true and p.is_suspended=false))
  with check (exists(select 1 from public.ufs_profiles p
      where p.user_id=(select auth.uid()) and p.is_moderator=true and p.is_suspended=false));

-- After Giuseppe registers and confirms his email, assign moderation manually:
-- UPDATE public.ufs_profiles SET is_moderator = true
-- WHERE user_id = (SELECT id FROM auth.users WHERE email = '<verified-admin-email>');
-- Never turn all authenticated users into moderators.
-- Optional future: policy/reporting system and rate limiting before a wider launch.
