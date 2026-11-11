-- Deployed on the isolated united-for-sitges Supabase project on 2026-11-11.
-- RLS on ufs_profiles has NO anonymous SELECT policy: anonymous role cannot read any profile rows.
-- Required for anon RLS checks on topics and replies to access referenced profile columns.
GRANT SELECT(user_id,is_moderator,is_suspended) ON public.ufs_profiles TO anon;
