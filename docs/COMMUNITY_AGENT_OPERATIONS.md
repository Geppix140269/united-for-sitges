# Community Agent: Operations guide

Everything below is preparation. As of 16 November 2026 nothing is deployed, no migration is applied, no credential exists and every outbound path is off.

## 1. Configuration (Vercel environment variables, server side only)

| Variable | Required for | Notes |
| --- | --- | --- |
| `AGENT_DATABASE_URL` | all functions | Supabase transaction pooler URL for role `ufs_agent_worker` (port 6543). Secret. |
| `SUPABASE_URL` | admin API | `https://tlmkeofpeigkfxdydwqt.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | admin API | the browser-safe key already in `forum-config.js`; used only to call `/auth/v1/user`. Never a secret key. |
| `CRON_SECRET` | scheduler | at least 32 random characters. Also stored in Supabase Vault for the cron job. |
| `META_APP_ID`, `META_APP_SECRET` | webhook, token checks | App Secret signs webhooks. Secret. |
| `META_VERIFY_TOKEN` | webhook setup | random string you also type in the Meta dashboard. |
| `META_PAGE_ACCESS_TOKEN` | Facebook channel | referenced by the channel as `env:META_PAGE_ACCESS_TOKEN`. Secret. |
| `META_IG_ACCESS_TOKEN` | Instagram channel | referenced as `env:META_IG_ACCESS_TOKEN`. Secret. |
| `META_GRAPH_VERSION` | optional | default `v27.0`. |
| `AGENT_AUTHOR_PEPPER` | webhook | random secret used to pseudonymise author ids (HMAC). Webhook refuses to run in production without it. |
| `ANTHROPIC_API_KEY` | model | Secret. Without it the agent runs rules-only. |
| `AGENT_MODEL` | optional | default `claude-opus-5-5`. Cheaper models are an owner cost decision. |
| `AGENT_LLM_ENABLED` | model | `true` allows sending public content to the model. Keep unset until the privacy review is signed off. |
| `RESEND_API_KEY` | email | dedicated sending key, restricted to `notify.unitedforsitges.com`. Secret. |
| `AGENT_ADMIN_ORIGIN` | optional | default `https://unitedforsitges.com`. |
| `AGENT_ALLOW_SUPERVISED` | moderation activation | must be `true` before anyone can select SUPERVISED. |
| `AGENT_ALLOW_AUTONOMOUS` | publishing activation | must be `true` before anyone can select AUTONOMOUS. |
| `AGENT_LIVE_META_REPLIES` | live replies | `true` lets SUPERVISED replies reach Facebook/Instagram. |
| `AGENT_LIVE_META_PUBLISHING` | live Facebook posts | `true` lets AUTONOMOUS publications reach Facebook. |
| `AGENT_LIVE_INSTAGRAM_PUBLISHING` | live Instagram posts | as above for Instagram. |
| `AGENT_LIVE_EMAIL` | digest and alerts | `true` lets emails be sent (also needs settings `send_enabled` and a sender on `notify.unitedforsitges.com`). |

Unset means off. Changing a variable requires a redeploy, which is itself an audit trail in Vercel.

## 2. Deployment prerequisites (in order, each needs owner authorisation)

1. Review and merge the pull request (no automation is active after merge: env vars are empty, so functions answer 503 or run in shadow).
2. Reconcile Supabase migration history (`supabase migration fetch`), then apply `20261116120000_community_agent_foundation.sql`.
3. In the SQL editor: `alter role ufs_agent_worker with login password '<strong random>';` and build `AGENT_DATABASE_URL` for the pooler (user `ufs_agent_worker.tlmkeofpeigkfxdydwqt`). Confirm `ufs_agent` is NOT in the Data API exposed schemas.
4. Load seed data: `node scripts/agent-seed.js` and run the output (all inactive).
5. Set the env vars for the features being enabled (start with database, Supabase, `CRON_SECRET`, `AGENT_AUTHOR_PEPPER`).
6. Scheduler: approve enabling `pg_cron` and `pg_net`, store the secret in Vault, run `supabase/proposed/agent_scheduler_supabase_cron.sql`. Vercel Hobby cron (once a day, 59 minute jitter) is not suitable; Vercel Schedules beta (15 minute jitter) is a fallback only.
7. Sign in to `/agent-console.html` with the moderator account; check Overview shows SHADOW / SHADOW.

## 3. Shadow mode

Default for both controls. The agent ingests, classifies, drafts, plans, generates, validates and schedules, and records `simulated` outcomes. Use at least two weeks of shadow operation to review classification quality, false positives, drafts and generated content before any activation request.

## 4. Human approval workflow

1. Cases tab, open a case: original excerpt, channel link, classification, risk, suggested reply, sources, validation notes.
2. To change text, edit and "Save as new version". Every version is immutable and needs its own approval; approval is bound to the exact text fingerprint the reviewer saw, so a concurrent edit forces a reload.
3. Approve, reject, escalate, resolve or dismiss. AI drafts that failed validation cannot be approved until a person edits them.
4. The executor re-checks everything right before sending (mode, kill switch, approval, text, target still exists, no previous reply, token, permissions, limits).
5. Every decision is in the audit log with moderator id, time and exact approved text.

FAQ library: create or edit (saved inactive), set expiry and channels, approve. Any later text change revokes approval automatically (database trigger). Factual FAQs need a source URL and a verification date at approval.

Sources: open each URL yourself, then "Verify". Verification lasts 90 days by default; expired verification blocks factual posts.

## 5. Kill switch

Overview tab, "STOP all outbound actions", with a reason. It is checked by the policy layer and again immediately before every provider call. Scheduled posts held by the stop stay scheduled and expire if their window passes; nothing posts late. Release the stop from the same card. Other levers: pause one channel, disable a category, set a mode to DISABLED, unset the live env switches and redeploy, or unschedule the cron job.

## 6. Monitoring and troubleshooting

- Overview: counts of interactions, awaiting review, urgent, failed events, failed replies, failed posts, today's schedule and usage counters.
- Failures tab: dead-lettered events (requeue), failed/blocked/unknown replies (requeue re-runs every guardrail), failed/unknown/expired publications.
- Vercel runtime logs: structured JSON events (`webhook_accepted`, `webhook_signature_rejected`, `agent_tick`, `admin_error`), no credentials.
- Supabase: `select * from cron.job_run_details order by start_time desc limit 20;` and `net._http_response` for scheduler delivery.

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Webhook 401 | wrong App Secret | check `META_APP_SECRET` |
| Webhook 503 | database unreachable or env missing | check `AGENT_DATABASE_URL`, Meta retries for 36 h |
| Events stay pending | scheduler not running | check cron job and `CRON_SECRET` |
| Channel token `invalid` | expired or revoked token | regenerate, update env, redeploy, "Verify token" |
| Publication `unknown` | crash or network error after the write | check the Page, then "Reconcile" with the URL or "not published" |
| Slot `skipped: source_verification_stale` | source verification older than the window | re-verify the source |
| Slots not planned | topic bank exhausted within duplicate window | add topics to `data/agent/editorial-topics.json` or shorten the window |

## 7. Token renewal and credential rotation

- Page tokens obtained from a long-lived user token normally do not expire, but are invalidated by password changes, role removal or app de-authorisation. The agent marks a channel `invalid` on error 190 and stops using it.
- Use "Verify token" weekly (records validity, scopes, expiry from `debug_token`). Instagram Login tokens expire after about 60 days and must be refreshed (refresh endpoint not implemented; manual rotation).
- Rotation: create the new token, update the Vercel variable, redeploy, Verify token, revoke the old token in Meta. Rotate `CRON_SECRET` (Vercel and Vault together), `AGENT_DATABASE_URL` password, `RESEND_API_KEY` and `ANTHROPIC_API_KEY` at least every 6 months or after any suspected exposure. Rotating `AGENT_AUTHOR_PEPPER` breaks linkage of old author references, which is acceptable.

## 8. Incident recovery

1. Press the emergency stop.
2. Identify the scope in Audit and Failures.
3. If a wrong reply or post went live, remove it manually on the platform and record a case note. The agent has no delete capability by design.
4. Fix the cause (rule, FAQ text, source, setting, credential).
5. Requeue only what should still happen; expired posts stay expired.
6. Release the stop. For data incidents follow the privacy review (72 h breach assessment).

## 9. Rollback

- Functional rollback: set both modes to DISABLED or press the stop; unset live switches and redeploy; unschedule the cron job.
- Code rollback: revert the merge commit; static pages are unaffected.
- Database rollback (only if required, after export): `drop schema ufs_agent cascade; drop role ufs_agent_worker;`. The forum schema is untouched by the agent migration, so forum data and policies survive.

## 10. Local development and tests

```bash
npm ci
```

```bash
export AGENT_TEST_DATABASE_URL=$(bash scripts/agent-test-db.sh start | tail -1)
```

```bash
npm test
```

```bash
node scripts/agent-site-smoke.js
```

The test database is a throwaway local PostgreSQL with Supabase stand-ins (`tests/agent/fixtures/supabase-stubs.sql`). It never connects to Supabase.
