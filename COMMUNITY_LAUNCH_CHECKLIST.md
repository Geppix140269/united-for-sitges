# United for Sitges — Community launch checklist

**Status: Public launch code prepared and deployed; Supabase Auth signup switch still OFF. Public UI auto-opens only after Supabase confirms it accepts verified email signups.**
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
- [x] Contact and controller identified in the published policy (Giuseppe Funaro, hello@giuseppefunaro.com). The contact must continue to be monitored.
- [x] Published expanded initial privacy notice with controller, contact, processing purposes/bases, hosting providers, rights, retention, age policy and sensitive-topic restrictions. Independent legal review remains advisable as the service scales.
- [x] Adult-only (18+) registration consent, moderation and no-campaigning rules added. Existing member report feature remains available.
- [ ] Configure and test secure registration, email verification and production SMTP/rate limits in Supabase Auth; set Site URL and approved redirect URLs for the correct production domain.
- [x] Primary moderator email selected: `hello@giuseppefunaro.com` (reserved in Supabase's non-public `ufs_internal.admin_contact` table; this is NOT an Auth account yet).
- [x] Private first-moderator grant trigger added and tested: matching verified email + recent OTP/magic-link sign-in only. Password-only or unverified signups cannot self-promote.
- [x] Administrator invited, email confirmed and account logged in, verified moderator profile created and real welcome post submitted and approved.
- [ ] Ensure guests and members can only read approved topics/replies; authors can see their own pending posts; moderators can see and approve pending content; non-moderators cannot approve/alter post status. Confirm with actual test accounts.
- [x] Member reporting and moderator report review queue implemented and tested in rollback-only SQL. Manual suspension by privileged operator is available; no user-facing suspension controls yet.
- [x] Moderation queue and per-member posting limits (3 topics, 12 replies, 5 reports per hour) applied and tested. Further CAPTCHA and operational monitoring are advised for scale; automatic alerts/backups need review.
- [x] Privacy policy and signed-in forum UI explain email-based deletion/data-access requests, retention review, moderation report and removal procedures.
- [ ] Verify mobile and desktop behavior, browser accessibility, and the site on the final domain.
- [x] Deployed `enabled: true` with client-side fail-closed GET /auth/v1/settings gate: public signup UI remains hidden until Auth reports `disable_signup:false` and email auto-confirm disabled.
- [ ] **REQUIRES DASHBOARD ACTION**: Supabase → Authentication → Sign In / Providers → enable **Allow new users to sign up**, keep **Confirm Email** on, and turn on leaked-password protection if available. The current connected Supabase tools cannot modify hosted Auth general settings.
- [ ] Test one brand-new non-admin account with actual email confirmation, message submission, and moderator approval before broad promotion.

## Notes
- The current `community.html` UI loads public topics and supports registration, sign-in, topic creation, replies and moderation *when* the config is enabled. It is **not yet an operational forum**.
- The `privacy.html` page explicitly states this is pre-launch; replace it with a reviewed final notice before any data collection.
- Existing political-party comparison is intended to remain neutral: equal methodology and source links, no endorsements.
- GoDaddy website DNS now points correctly to Vercel. Resend's notification subdomain passed DKIM and SPF verification. Do not modify existing website or apex mail records.

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

## Added after verification (11 November 2026)

- [x] Resend domain `notify.unitedforsitges.com` verified for email sending; dedicated Resend SMTP API key exists.
- [x] Supabase logs show email send limit changed from 2 to 30/hour; actual SMTP delivery from Supabase still requires a live test.
- [x] Site config `betaEnabled: true` and `enabled: false`: visitors can read approved topics, verified moderators can test forum, no public signup.
- [x] Private administrator onboarding page `admin-setup.html` implemented. First moderator privilege promotion now checks a recent (<=1 hour) email OTP/magic-link authentication method in the Supabase-issued JWT in addition to reserved email ownership.
- [x] User permissions and moderator status changes tested in simulated rolled-back SQL transactions. Supabase Security Advisor returned no findings.
- [ ] Verify explicit Supabase Auth redirect allowlist includes `https://unitedforsitges.com/admin-setup.html`.
- [ ] Verify a real magic-link email arrives and that administrator can log in, create profile and set password.
- [ ] Verify live forum UI with the real moderator and a separate resident account.

## Public opening preparation — 11 November 2026 (latest)

- GitHub frontend and privacy were deployed to production Vercel; public signup only renders after querying GoTrue's public settings endpoint. If backend continues disabling signups, the public UI stays closed and verified moderators can still log in.
- One verified owner account, one public welcome topic, no pending topics at latest DB check.
- Rate-limit / impersonation RLS tests passed in rolled-back transactions.
- Supabase Security Advisor still warns that **leaked-password protection is disabled**. This is an Auth dashboard setting, not a database policy.
- Public launch has not been validated with a resident user; the site must not be represented as fully open until the Auth toggle and live email-confirmation test pass.
