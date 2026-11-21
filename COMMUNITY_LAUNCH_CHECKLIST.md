# United for Sitges: community launch checklist

**Status (21 November 2026): forum open, public registration on.** Operating notes are in `FORUM_GO_LIVE.md`. This file tracks the launch gates.

## Infrastructure
- [x] Hosting on Cloudflare Workers (static assets), deployed from GitHub `main`. Vercel and Netlify retired.
- [x] Backend on Neon (project `united-for-sitges`, Frankfurt): tables `ufs_profiles`, `ufs_topics`, `ufs_replies`, `ufs_reports` with row-level security (`neon/schema.sql`).
- [x] Accounts through Neon Auth: email + password, email confirmed with a 6-digit code, reset by code.
- [x] `forum-config.js` has `enabled: true` and `betaEnabled: true`; it contains public URLs only.
- [x] Moderation statuses (pending, approved, rejected). The public sees approved content only.
- [x] Only authenticated, non-suspended members can post. Moderators can publish in the `official` category.
- [x] Member reporting and moderator report queue.
- [x] Posting limits: 3 topics, 12 replies, 5 reports per hour per member.
- [x] Reserved display names usable only by the verified administrator.
- [x] Database policies tested on 18 November 2026 with throwaway accounts (see `docs/2026-11-18-neon-migration.md`).

## Content and features
- [x] Administrator account `hello@unitedforsitges.com` registered and verified.
- [x] Sixteen opening discussions published on 21 November 2026, one per policy theme.
- [x] On-demand translation of discussions and replies (Cloudflare Workers AI, `/api/translate`), live and confirmed.
- [x] Community rules shown on the forum page: respect, official sources, no campaigning, equal treatment, privacy.

## Legal and privacy
- [x] Full privacy notice published (`privacy.html`, 21 November 2026): controller, purposes and legal bases, providers, translation, retention, rights, age (18+), sensitive topics.
- [ ] Independent legal review of the privacy notice and community rules.
- [ ] Decide whether to add a short community terms page (moderation appeal, content licence).

## Testing still open
- [ ] One brand-new non-admin account end to end on the production domain (sign-up, code, post, approval, report, deletion request).
- [ ] Safari and iOS check (session cookie from the Neon Auth domain).
- [ ] Mobile and desktop accessibility pass on the live forum.

## Later
- [ ] Custom SMTP for account emails (optional).
- [ ] Cloudflare Web Analytics, cookieless (optional; add a privacy policy line when enabled).
- [ ] CAPTCHA before large promotion.
- [ ] Pause or delete the old Supabase project `tlmkeofpeigkfxdydwqt` after a backup, if not already done.

## Notes
- Programme comparison stays neutral: equal methodology and source links, no endorsements.
- Do not modify apex MX, TXT, SPF, DKIM, DMARC or `www` DNS records. The Resend sender `notify.unitedforsitges.com` is verified and its records are already installed (see Resend dashboard).
