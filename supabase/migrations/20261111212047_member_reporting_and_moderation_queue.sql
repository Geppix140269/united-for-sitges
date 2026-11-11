-- User-report queue for a member forum. Reports are private to the reporter
-- and verified moderator. All public posts remain approval-gated.
create table if not exists public.ufs_reports(
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  topic_id uuid not null references public.ufs_topics(id) on delete cascade,
  reply_id uuid references public.ufs_replies(id) on delete cascade,
  reason text not null check(length(trim(reason)) between 10 and 750),
  status text not null default 'open' check(status in ('open','reviewed','dismissed')),
  created_at timestamptz not null default now(),
  unique nulls not distinct (reporter_id,topic_id,reply_id)
);
create index if not exists ufs_reports_queue_idx on public.ufs_reports(status,created_at desc);
alter table public.ufs_reports enable row level security;
revoke all on public.ufs_reports from anon,authenticated;
grant select on public.ufs_reports to authenticated;
grant insert(reporter_id,topic_id,reply_id,reason) on public.ufs_reports to authenticated;
grant update(status) on public.ufs_reports to authenticated;
create policy "ufs member reports readable only to reporter or moderator" on public.ufs_reports
 for select to authenticated using(
 reporter_id=(select auth.uid()) or exists(
  select 1 from public.ufs_profiles p where p.user_id=(select auth.uid())
   and p.is_moderator=true and p.is_suspended=false
 ));
create policy "ufs verified member may report public discussions" on public.ufs_reports
 for insert to authenticated with check(
  reporter_id=(select auth.uid())
  and coalesce(((select auth.jwt())->>'is_anonymous')::boolean,false)=false
  and exists(select 1 from public.ufs_profiles p where p.user_id=(select auth.uid()) and not p.is_suspended)
  and exists(select 1 from public.ufs_topics t where t.id=topic_id and t.status='approved')
  and (reply_id is null or exists(select 1 from public.ufs_replies r where r.id=reply_id and r.topic_id=topic_id and r.status='approved'))
 );
create policy "ufs moderator reviews reports" on public.ufs_reports
 for update to authenticated
 using(exists(select 1 from public.ufs_profiles p where p.user_id=(select auth.uid()) and p.is_moderator=true and not p.is_suspended))
 with check(exists(select 1 from public.ufs_profiles p where p.user_id=(select auth.uid()) and p.is_moderator=true and not p.is_suspended));
