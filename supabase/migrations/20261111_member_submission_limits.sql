-- Deployed on United for Sitges project tlmkeofpeigkfxdydwqt.
-- Early-abuse control for public member signups, supplementing Supabase Auth rate limits.
-- A normal member may create at most 3 topics, 12 replies, and 5 reports per hour.
-- Verified active moderators are exempt. Never expose service-role credentials in browser code.
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
  if TG_TABLE_NAME='ufs_topics' then
    actor:=new.author_id;
    limit_per_hour:=3;
  elsif TG_TABLE_NAME='ufs_replies' then
    actor:=new.author_id;
    limit_per_hour:=12;
  elsif TG_TABLE_NAME='ufs_reports' then
    actor:=new.reporter_id;
    limit_per_hour:=5;
  else
    raise exception 'Unexpected community submission type';
  end if;
  if actor is distinct from (select auth.uid()) then
    raise exception 'A member can only submit their own content';
  end if;
  if exists(
    select 1 from public.ufs_profiles p
    where p.user_id=actor and p.is_moderator and not p.is_suspended
  ) then return new; end if;
  if TG_TABLE_NAME='ufs_topics' then
    select count(*) into in_last_hour
    from public.ufs_topics t
    where t.author_id=actor and t.created_at>now()-interval '1 hour';
  elsif TG_TABLE_NAME='ufs_replies' then
    select count(*) into in_last_hour
    from public.ufs_replies r
    where r.author_id=actor and r.created_at>now()-interval '1 hour';
  else
    select count(*) into in_last_hour
    from public.ufs_reports r
    where r.reporter_id=actor and r.created_at>now()-interval '1 hour';
  end if;
  if in_last_hour >= limit_per_hour then
    raise exception 'Community posting limit reached. Please try again later.';
  end if;
  return new;
end;
$$;
revoke all on function public.ufs_limit_member_submissions() from public,anon,authenticated;
drop trigger if exists ufs_topics_limit_member_submissions on public.ufs_topics;
create trigger ufs_topics_limit_member_submissions before insert on public.ufs_topics
for each row execute function public.ufs_limit_member_submissions();
drop trigger if exists ufs_replies_limit_member_submissions on public.ufs_replies;
create trigger ufs_replies_limit_member_submissions before insert on public.ufs_replies
for each row execute function public.ufs_limit_member_submissions();
drop trigger if exists ufs_reports_limit_member_submissions on public.ufs_reports;
create trigger ufs_reports_limit_member_submissions before insert on public.ufs_reports
for each row execute function public.ufs_limit_member_submissions();

alter policy "ufs member creates own non-moderator profile"
on public.ufs_profiles
with check(
  user_id=(select auth.uid())
  and is_moderator=false and is_suspended=false
  and lower(trim(display_name)) not in(
    'united for sitges','unitedforsitges','ufs admin','admin','administrator',
    'moderator','official information','sitges town hall','ajuntament de sitges'
  )
);
create index if not exists ufs_topics_author_time_idx on public.ufs_topics(author_id,created_at desc);
create index if not exists ufs_replies_author_time_idx on public.ufs_replies(author_id,created_at desc);
create index if not exists ufs_reports_reporter_time_idx on public.ufs_reports(reporter_id,created_at desc);

-- Verified in a rolled-back SQL test: first 3 topics accepted; 4th within
-- an hour rejected. Reserved-name sign-up denied, ordinary name accepted.
