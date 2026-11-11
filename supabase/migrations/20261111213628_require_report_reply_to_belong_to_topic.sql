alter policy "ufs verified member may report public discussions"
on public.ufs_reports
with check (
  reporter_id = (select auth.uid())
  and coalesce(((select auth.jwt())->>'is_anonymous')::boolean, false) = false
  and exists (
    select 1 from public.ufs_profiles as profile
    where profile.user_id = (select auth.uid()) and not profile.is_suspended
  )
  and exists (
    select 1 from public.ufs_topics as topic
    where topic.id = ufs_reports.topic_id and topic.status = 'approved'
  )
  and (
    ufs_reports.reply_id is null
    or exists (
      select 1 from public.ufs_replies as reply
      where reply.id = ufs_reports.reply_id
        and reply.topic_id = ufs_reports.topic_id
        and reply.status = 'approved'
    )
  )
);
