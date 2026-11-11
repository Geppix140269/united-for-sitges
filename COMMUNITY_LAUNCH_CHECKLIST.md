# United for Sitges — Community launch checklist

**Status: Backend provisioned; public signups intentionally DISABLED.**
Last checked: 2026-11-11.

## Infrastructure
- [x] Dedicated Supabase project: `tlmkeofpeigkfxdydwqt` (`eu-west-1`), separate from every other business project.
- [x] Database tables `public.ufs_profiles`, `public.ufs_topics`, `public.ufs_replies`, with RLS.
- [x] Pending/approved/rejected moderation statuses; public sees approved topics/replies only.
- [x] Only authenticated members can insert; ordinary members cannot grant themselves moderator status.
- [x] Posts require the author's saved display name; only moderators can publish in `official` category.
- [x] Public Supabase publishable key and URL added to `forum-config.js`; `enabled: false`.
- [x] Supabase security advisors returned no findings immediately after migration.
- [x] Deploy from GitHub `main` to Vercel automatically.

## Required before allowing public registrations
- [ ] Name a designated community controller/contact for privacy and moderation; provide an actively monitored address (not an unverified domain mailbox).
- [ ] Draft and review a privacy notice complying with GDPR including processing purpose, data categories, retention, international processors, member rights, contact details, lawful basis and special category political opinions risks.
- [ ] Define member age policy, no candidate/party promotion rules and how to report harmful content.
- [ ] Configure and test secure registration, email verification and production SMTP/rate limits in Supabase Auth; set Site URL and approved redirect URLs for the correct production domain.
- [x] Primary moderator email selected: `hello@giuseppefunaro.com` (reserved in Supabase's non-public `ufs_internal.admin_contact` table; this is NOT an Auth account yet).
- [ ] Have the designated administrator sign up using `hello@giuseppefunaro.com`, confirm mailbox ownership, then assign `is_moderator=true` to that verified Supabase user via a privileged database operation. Never infer admin access solely from editable user metadata, and never use a shared password.
- [ ] Ensure guests and members can only read approved topics/replies; authors can see their own pending posts; moderators can see and approve pending content; non-moderators cannot approve/alter post status. Confirm with actual test accounts.
- [ ] Add/report a post and suspend a member; test moderator controls and response workflow before promoting the forum publicly.
- [ ] Add anti-abuse protections, moderation queue alerts and a backup/recovery policy; post approval alone does not stop spam from filling a queue.
- [ ] Provide a member deletion/withdrawal request process, retention schedule and moderation removal policy.
- [ ] Verify mobile and desktop behavior, browser accessibility, and the site on the final domain.
- [ ] Only then change `window.UFS_FORUM_CONFIG.enabled` from `false` to `true`, publish via GitHub and test again.

## Notes
- The current `community.html` UI loads public topics and supports registration, sign-in, topic creation, replies and moderation *when* the config is enabled. It is **not yet an operational forum**.
- The `privacy.html` page explicitly states this is pre-launch; replace it with a reviewed final notice before any data collection.
- Existing political-party comparison is intended to remain neutral: equal methodology and source links, no endorsements.
- GoDaddy `unitedforsitges.com` requires DNS updates for the Vercel deployment; Vercel project association alone does not point the domain.

## Primary administrator provisioned contact

The private database setting `ufs_internal.admin_contact` has been set to `hello@giuseppefunaro.com` on 2026-11-11. This is an **account designation**, not proof the email receives mail or an active Supabase Auth account. No admin privileges exist until the mailbox is verified and the matching user is securely granted moderator status. The public forum remains disabled in `forum-config.js` until the launch gates above pass.

After the admin account has been registered and email confirmation independently verified, an authorised operator may run a one-time, scoped moderation grant:

```sql
UPDATE public.ufs_profiles AS p
SET is_moderator = true
FROM auth.users AS u
WHERE p.user_id = u.id
  AND lower(u.email) = (SELECT email FROM ufs_internal.admin_contact WHERE singleton = true)
  AND u.email_confirmed_at IS NOT NULL
RETURNING p.user_id, p.display_name, p.is_moderator;
```

Stop without changing roles if no verified matching account exists. Review email-confirmation settings first.
