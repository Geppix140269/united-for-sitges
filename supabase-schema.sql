-- =====================================================================
--  UNITED FOR SITGES — Community / discussion board
--  Supabase schema + Row Level Security (pre-approval moderation)
-- =====================================================================
--  HOW TO RUN
--  1. Create a free project at https://supabase.com  (choose an EU region,
--     e.g. "West EU (Ireland)" or "Central EU (Frankfurt)" for GDPR).
--  2. Open the project → SQL Editor → New query.
--  3. Paste this whole file and click "Run".
--  This is safe to re-run: it uses IF NOT EXISTS / CREATE OR REPLACE.
-- =====================================================================

-- ---------- 1. PROFILES (one row per registered member) --------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  neighborhood text,
  is_admin    boolean not null default false,   -- moderators: set true manually
  is_blocked  boolean not null default false,   -- ban abusive users
  created_at  timestamptz not null default now()
);

-- ---------- 2. POSTS (comments / discussion messages) ----------------
create table if not exists public.posts (
  id          bigint generated always as identity primary key,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  body        text not null check (char_length(body) between 2 and 4000),
  topic       text default 'general',
  approved    boolean not null default false,   -- PRE-APPROVAL: hidden until a moderator approves
  created_at  timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.profiles(id)
);

create index if not exists posts_approved_idx on public.posts (approved, created_at desc);

-- ---------- 3. Auto-create a profile when someone signs up -----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 4. Helper: is the current user an admin? -----------------
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- =====================================================================
--  ROW LEVEL SECURITY
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.posts    enable row level security;

-- ---- PROFILES policies ----
drop policy if exists "profiles_select_all"  on public.profiles;
create policy "profiles_select_all"
  on public.profiles for select
  using (true);                                 -- display names are public

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id and is_admin = (select is_admin from public.profiles where id = auth.uid()));
  -- a user can edit their own profile but cannot grant themselves admin

-- ---- POSTS policies ----

-- READ: everyone (even logged-out visitors) sees APPROVED posts.
--       authors see their own pending posts. admins see everything.
drop policy if exists "posts_select_visible" on public.posts;
create policy "posts_select_visible"
  on public.posts for select
  using (
    approved = true
    or author_id = auth.uid()
    or public.is_admin()
  );

-- INSERT: only logged-in, non-blocked members. Forces approved=false.
drop policy if exists "posts_insert_members" on public.posts;
create policy "posts_insert_members"
  on public.posts for insert
  with check (
    auth.uid() = author_id
    and approved = false
    and not coalesce((select is_blocked from public.profiles where id = auth.uid()), true)
  );

-- UPDATE: only admins (used to approve / unapprove / edit).
drop policy if exists "posts_update_admin" on public.posts;
create policy "posts_update_admin"
  on public.posts for update
  using (public.is_admin());

-- DELETE: authors can delete their own; admins can delete any.
drop policy if exists "posts_delete_own_or_admin" on public.posts;
create policy "posts_delete_own_or_admin"
  on public.posts for delete
  using (author_id = auth.uid() or public.is_admin());

-- =====================================================================
--  MAKE YOURSELF AN ADMIN (run AFTER you have signed up once)
--  Replace the email with the address you registered with.
-- =====================================================================
-- update public.profiles set is_admin = true
-- where id = (select id from auth.users where email = 'g.funaro@1402celsius.com');

-- =====================================================================
--  MODERATION CHEAT SHEET (run in SQL Editor)
-- =====================================================================
-- See pending posts:
--   select p.id, pr.display_name, p.body, p.created_at
--   from posts p join profiles pr on pr.id = p.author_id
--   where p.approved = false order by p.created_at;
--
-- Approve a post:
--   update posts set approved = true, approved_at = now(),
--     approved_by = (select id from auth.users where email='g.funaro@1402celsius.com')
--   where id = <POST_ID>;
--
-- Block an abusive user:
--   update profiles set is_blocked = true where id = '<USER_UUID>';
