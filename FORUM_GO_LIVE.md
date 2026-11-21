# United for Sitges: community forum, how it runs

Status (21 November 2026): **forum open to public registration**. Site hosted on Cloudflare Workers. Backend on Neon. Sixteen opening discussions published by the administrator account.
Public page: https://unitedforsitges.com/community.html

History: the forum first ran on Supabase and Vercel. It moved to Neon on 18 November 2026 (see `docs/2026-11-18-neon-migration.md`) and the site moved to Cloudflare Workers the same week. The `supabase/` folder and older notes are kept only as history.

## Architecture

| Part | Service | Notes |
|---|---|---|
| Website and API route | Cloudflare Workers (static assets + `worker/index.js`) | `wrangler.jsonc`; headers in `_headers`, redirects in `_redirects` |
| Accounts | Neon Auth (email + password, 6-digit email code) | trusted domains `unitedforsitges.com` and `www.unitedforsitges.com` |
| Database | Neon project `united-for-sitges` (`shiny-dream-02523490`), Frankfurt | schema in `neon/schema.sql`, access enforced by row-level security |
| Translation | Cloudflare Workers AI via `POST /api/translate` | on demand, per message, cached 30 days |
| Account emails | Neon shared sender `auth@mail.myneon.app` | custom sender can be set later in the Neon console |

`forum-config.js` holds only public URLs (no keys). Never put a database password or API key in browser code or in the repository.

## Roles and moderation

- Administrator: `hello@unitedforsitges.com`, display name "United for Sitges". The moderator flag is granted automatically when that verified email creates its profile (`ufs_internal.admin_contact`). Reserved display names can be used only by this account.
- Members post topics and replies. Everything starts as `pending` and is public only after a moderator approves it in the moderation panel on `community.html`.
- Members can report posts privately. Limits per member: 3 topics, 12 replies, 5 reports per hour.
- Category `official` is reserved for moderators.

## Opening discussions

Sixteen discussions, one per policy theme (economy, planning, housing, tourism, safety, mobility, environment, public services, finances, governance, international community, culture, education, health, sport, other), were published on 21 November 2026 by the administrator account. They are in the category "Local issues" ("Questions" for the last one). Replies are written in any language; readers use the "Translate" button.

## Translation

- Worker route `/api/translate`: JSON `{text, target}`, target in en/es/ca/it/fr/de/nl, up to 4000 characters, same-origin only.
- Check it is live: opening `https://unitedforsitges.com/api/translate` in a browser must show `{"error":"Method not allowed"}` (confirmed 21 November 2026).
- Uses the Workers AI free daily allowance. If that is exceeded, translation fails gracefully ("not available right now") and the rest of the forum is unaffected.
- The privacy policy states that message text is sent to Cloudflare Workers AI when a reader presses Translate.

## Routine tasks

- Check the moderation queue daily in the first weeks.
- Keep `hello@unitedforsitges.com` monitored (privacy requests, deletions, reports).
- Review the Neon console now and then: storage (Free plan, 1 GB) and auth logs.

## Open items

- [ ] Independent legal review of `privacy.html` (the current text is a full draft, published 21 November 2026, review pending).
- [ ] Test a fresh non-admin account end to end on the production domain: sign-up, email code, topic, reply, moderator approval, report, sign-out, password reset. Check Safari and iOS (the session cookie is set by the Neon Auth domain).
- [ ] Optional: custom SMTP in Neon so account emails come from `unitedforsitges.com` (Resend domain `notify.unitedforsitges.com` is already verified; do not change apex DNS records).
- [ ] Optional: Cloudflare Web Analytics (cookieless). Enable in the Cloudflare dashboard under the Worker's Metrics / Web Analytics, then add one line to the privacy policy.
- [ ] Optional: CAPTCHA or extra rate limiting before large promotion.

## Redeploy

Push to `main` on GitHub; Cloudflare builds and deploys the Worker and assets. Netlify and Vercel are no longer used (Netlify disconnected 21 November 2026).
