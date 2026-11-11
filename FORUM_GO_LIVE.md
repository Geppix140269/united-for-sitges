# United for Sitges — make the forum operational

Status (11 November 2026): **frontend and database prepared; public signups remain OFF**.
Project: `tlmkeofpeigkfxdydwqt`, region `eu-west-1`. Public site: https://unitedforsitges.com/community.html
Moderator contact designated: `hello@giuseppefunaro.com` (must still register and verify email).

## 1. Authorize notification sender in GoDaddy DNS

A Resend sender was created for `notify.unitedforsitges.com`, Resend domain id `1c4c06fb-e25f-427c-9016-8e2943d3408a`.
It is currently NOT VERIFIED. GoDaddy manages the zone `unitedforsitges.com`.

**Add** these records under the existing GoDaddy zone, using the labels in the Host column; do not replace unrelated records. In particular, the MX below is for **send.notify**, *not* the apex `@` record.

| Type | Host | Value | MX priority |
|---|---|---|---|
| TXT | `resend._domainkey.notify` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC/3JKDtFCIdAbE+OMFeJZt0fbY0rCvpKsZFlZAXbdjqp9ZK8Br/jgbxBPYleIc79QYbHinXQUtpZDE+ew4w/gy8sZUhq3UmbM1/cy0Q5uTTi8w4lZ3pXM97dMsWk9mW/J+Bp2DK+Eqrsdi2yw2xAbsNZHutqWQaIDgOmkjYlBhVwIDAQAB` | — |
| MX | `send.notify` | `feedback-smtp.eu-west-1.amazonses.com` | 10 |
| TXT | `send.notify` | `v=spf1 include:amazonses.com ~all` | — |
| CNAME | `rsend.notify` | `send.forge.rmta.net` | — |

Do not modify apex MX, TXT, existing SPF, DKIM or DMARC, website A records or `www` CNAME.
After saving, run Resend Verify domain and check all records. Sending must become `verified` before proceeding.

## 2. Auth URL configuration (Supabase Dashboard)

Project → Authentication → URL Configuration.
- **Site URL**: `https://unitedforsitges.com`
- Add exact Redirect URL `https://unitedforsitges.com/community.html`
- If users are actually served on www, add `https://www.unitedforsitges.com/community.html`
- Add `https://united-for-sitges.vercel.app/community.html` only if that legacy Vercel alias is still used for authentication testing.
- Avoid unconstrained URL wildcards.

## 3. Auth sending: Resend custom SMTP

Project → Authentication → Email → SMTP Settings (wording can vary by dashboard).
- Make a **sending-only** Resend API key scoped to the verified notification domain, and use it privately for Supabase SMTP. Do not put it in GitHub, public JavaScript, browser dev tools or chat text.
- Server: `smtp.resend.com`.
- Port: `465` (TLS) or `587` (STARTTLS).
- Username: `resend`.
- Password: the sending-only Resend key (secret).
- Sender: `no-reply@notify.unitedforsitges.com`.
- Sender name: `United for Sitges`.
- Confirm Email: **ON**. Anonymous sign-in: **OFF**.
- Enable anti-abuse (CAPTCHA, rate limits) before public launch.
- Ensure confirmation and password-reset links return to `/community.html` on the allowed site.

## 4. Confirm moderator

- The owner creates their own email/password account on the **live** community page after the guarded config is switched on in controlled testing.
- The owner personally follows the verification link at `hello@giuseppefunaro.com`.
- Confirm a matching verified account exists in `auth.users`.
- Insert profile is handled by the frontend on first sign-in.
- A privileged operator then assigns `is_moderator=true` to that verified user's `ufs_profiles` row. Details and SQL are in `COMMUNITY_LAUNCH_CHECKLIST.md`. Never set moderator based on user-controlled signup metadata.

## 5. GDPR notice and moderation launch gate

The current `privacy.html` is a pre-launch notice, not a complete forum notice.
Before collecting accounts, publish a reviewed notice identifying the actual controller and contact, purpose and lawful basis, data retention/deletion process, user rights, hosting provider, potential international transfers, and political-opinion/sensitive-content handling. Community terms need to cover age, prohibited political campaigning, content reporting and moderation appeal.

## 6. End-to-end tests

- New user registers, receives email, confirms via site URL, signs in, signs out, password reset.
- Profile created with display name; ordinary user is NOT a moderator.
- Unauthenticated reader sees only approved topics/replies. Pending posts remain private.
- Member posts topic/reply, both pending moderation.
- Moderator approves, rejects, views private reports.
- Ordinary user cannot approve/reject or read other users' pending posts, nor change `is_moderator`.
- Member can report approved post privately.
- Report and other moderation processes checked with independent test accounts.
- Run Supabase security advisors and retest responsive UI after deployment.

## 7. Enable only after all the above

In `forum-config.js` set `enabled: true` when verified (only the publishable key is exposed to browser, not any secret). Commit and deploy through GitHub `main`. Recheck end-to-end on the production domain. **Do not enable until SMTP, URL redirects, privacy, moderator and end-to-end tests are verified.**
