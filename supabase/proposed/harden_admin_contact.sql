-- PROPOSED hardening for ufs_internal.admin_contact. NOT APPLIED.
-- Finding (2026-11-16, read-only inspection): RLS is disabled on this table,
-- but anon and authenticated have no USAGE on schema ufs_internal and no
-- table privileges, and ufs_internal is not a Data API schema. Effective
-- exposure is therefore none. This script adds defence in depth only.
--
-- Safety: the only reader is ufs_internal.promote_verified_primary_moderator(),
-- a SECURITY DEFINER function owned by the table owner. Table owners bypass
-- RLS unless FORCE is set, so we enable RLS but do NOT force it, and keep the
-- moderator bootstrap working. Verified in a local rehearsal (tests/agent/db).
begin;
alter table ufs_internal.admin_contact enable row level security;
revoke all on schema ufs_internal from public, anon, authenticated;
revoke all on all tables in schema ufs_internal from public, anon, authenticated;
revoke all on all functions in schema ufs_internal from public, anon, authenticated;
commit;
