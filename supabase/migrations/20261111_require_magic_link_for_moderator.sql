-- Deployed on 2026-11-11 after the verified-email-only trigger.
-- Only a fresh verified email Magic Link/OTP session can bootstrap the moderator.
-- A password signup with email auto-confirmed (if accidentally enabled)
-- cannot make itself a moderator simply by claiming the reserved email.
create or replace function ufs_internal.promote_verified_primary_moderator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed boolean := false;
  proved_mailbox_control boolean := false;
begin
  select exists (
    select 1
    from jsonb_array_elements(coalesce((select auth.jwt())->'amr','[]'::jsonb)) as method
    where method->>'method' in ('magiclink','otp')
      and (method->>'timestamp')::numeric >= extract(epoch from now() - interval '1 hour')
  ) into proved_mailbox_control;
  if proved_mailbox_control then
    select exists (
      select 1 from auth.users u
      join ufs_internal.admin_contact a on a.singleton=true and lower(u.email)=a.email
      where u.id=new.user_id and u.email_confirmed_at is not null
        and coalesce(u.is_anonymous,false)=false
    ) into allowed;
  end if;
  if allowed then
    update public.ufs_profiles set is_moderator=true where user_id=new.user_id;
  end if;
  return new;
end;
$$;
revoke all on function ufs_internal.promote_verified_primary_moderator() from public,anon,authenticated;

-- Tested in ROLLBACK transactions:
-- 1) matching admin email + password claim = NOT moderator
-- 2) matching admin email + recent magiclink claim = moderator
-- 3) different verified email + magiclink = NOT moderator
-- The real project still had zero registered users at the time of testing.
