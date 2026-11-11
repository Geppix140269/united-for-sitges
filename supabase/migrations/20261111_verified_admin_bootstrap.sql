-- Deployed on 2026-11-11 to United for Sitges Supabase project tlmkeofpeigkfxdydwqt.
-- Grants moderator privileges ONLY to the verified owner of the email
-- recorded in the private singleton table ufs_internal.admin_contact.
-- Trigger is in a non-exposed schema and is not client-callable.
create or replace function ufs_internal.promote_verified_primary_moderator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare allowed boolean := false;
begin
  select exists (
    select 1 from auth.users u
    join ufs_internal.admin_contact a
      on a.singleton = true and lower(u.email) = a.email
    where u.id = new.user_id
      and u.email_confirmed_at is not null
      and coalesce(u.is_anonymous,false) = false
  ) into allowed;
  if allowed then
    update public.ufs_profiles
    set is_moderator = true
    where user_id = new.user_id;
  end if;
  return new;
end;
$$;
revoke all on function ufs_internal.promote_verified_primary_moderator() from public,anon,authenticated;
drop trigger if exists ufs_promote_verified_primary_moderator on public.ufs_profiles;
create trigger ufs_promote_verified_primary_moderator
after insert on public.ufs_profiles
for each row execute function ufs_internal.promote_verified_primary_moderator();

-- Tested with three simulated users in an explicit rolled-back transaction:
-- Verified exact-match admin email -> promoted.
-- Verified different email -> not promoted.
-- Unverified different email -> not promoted.
-- No real users or profiles created by these tests.
