# Community backend: Supabase to Neon (18 Nov 2026)

Owner decision (Giuseppe, 18 Nov 2026): no paid Supabase; United for Sitges moves to Neon Free. The two existing members (Giuseppe and Diana) register again.

## What changed

| Area | Before | After |
|---|---|---|
| Database | Supabase project `tlmkeofpeigkfxdydwqt` (Pro org, eu-west-1) | Neon project `united-for-sitges` (`shiny-dream-02523490`), Free plan, AWS eu-central-1 (Frankfurt), Postgres 18, account g.funaro@1402celsius.com |
| Auth | Supabase Auth, email link confirmation, magic link for the administrator | Neon Auth (Better Auth), email + password, email confirmed with a 6-digit code, password reset by code |
| Browser client | `@supabase/supabase-js` from esm.sh | `@neon/neon-js` 0.10.2, bundled once with esbuild into `js/vendor/neon-js-0.10.2.min.js` (self-hosted, no CDN) |
| Config | `forum-config.js` held the Supabase URL and publishable key | `forum-config.js` holds only the Neon Auth URL and Data API URL (no key) |
| Schema | `supabase/forum-schema.sql` + `supabase/migrations/` | `neon/schema.sql` (same tables, grants, policies, triggers) |

## Neon settings applied (console, 18 Nov 2026)

- Better Auth on: application name "United for Sitges"; trusted domains `https://unitedforsitges.com`, `https://www.unitedforsitges.com`; Allow Localhost OFF; Sign-up with email ON; Verify at sign-up ON (verification code); Sign-in with email ON; Revoke sessions on password reset ON. Email sender: Neon shared (`auth@mail.myneon.app`).
- Data API on, using Neon Auth; "Grant public schema access" NOT ticked (grants are explicit in `neon/schema.sql`).

## Schema differences from Supabase

- User ids reference `neon_auth."user"(id)` (uuid).
- Signed-out visitors use the Data API role `anonymous` (Supabase: `anon`), with an anonymous JWT fetched by the SDK.
- `auth.uid()` / `auth.jwt()` come from Neon's `pg_session_jwt`. They work inside RLS policies, but the `auth` schema (owned by `cloud_admin`) is not usable by the member role inside function bodies, so the rate-limit trigger no longer re-checks the author (the insert policies already enforce it).
- Administrator bootstrap: the moderator flag is set when the verified owner of `ufs_internal.admin_contact` (hello@giuseppefunaro.com) creates a profile. Neon requires the email code before sign-in, so the Supabase magic-link check is replaced by `neon_auth."user"."emailVerified"`. The reserved display names (for example "United for Sitges") are allowed only for that verified administrator.

## Verification (18 Nov 2026)

Against the live Neon project with throwaway test accounts (`claude-test-*@example.com`, email verified by SQL), all deleted afterwards (0 users, 0 rows left):

- Anonymous: reads approved topics and replies only; cannot read profiles or reports; cannot insert; cannot call `ufs_internal` functions.
- Member: cannot sign in before email confirmation (`EMAIL_NOT_VERIFIED`); reserved display name refused; profile for another user refused; topic as another user refused; wrong author name refused; "official" category refused; own pending topic visible only to self; cannot approve own topic or reply; cannot read others' profiles; 4th topic within an hour refused by the limit; duplicate report refused; cannot edit reply body.
- Moderator: approves topics and replies (then visible to anonymous); reads and closes reports; may post "official".
- Administrator bootstrap: verified admin email + "United for Sitges" profile becomes moderator.
- Browser (Chrome, page served as unitedforsitges.com): anonymous load, sign-in of an unverified account shows the code form, verified sign-in, automatic profile creation, new topic submitted as pending, session kept after reload, sign-out.

## After deploy

1. Giuseppe registers on /community.html with hello@giuseppefunaro.com, display name "United for Sitges", enters the code; /admin-setup.html confirms moderator status.
2. Diana registers again.
3. The two existing topics (welcome post, approved; Diana's question, pending) are restored with their original ids and dates by a one-off SQL run by Claude (not committed: it contains a member email).
4. Then the Supabase project is paused (with a backup downloaded first).

## Known limits

- Neon Free (as shown in the console, Nov 2026): 1 GB storage per project, compute scales to zero when idle and autoscales up to 2 CU, so the first request after an idle period is slower.
- Session cookie is set by the Neon Auth domain (third-party from the site's point of view). Works in Chrome; check on Safari/iOS after deploy.
- Verification and reset emails come from Neon's shared sender (`auth@mail.myneon.app`), not from unitedforsitges.com. A custom SMTP can be set later in the Neon console.
