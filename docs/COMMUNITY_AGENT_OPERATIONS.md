# Community Agent: Operations guide

Everything below is preparation. As of 20 November 2026 the site runs on Cloudflare Workers (static assets) with the community forum on Neon. The agent is not activated: no agent schema on Neon, no Worker secrets, no Cron Trigger, every outbound path off.

Platform: one Cloudflare Worker (`worker/index.js`) handles only `/api/agent/*`; every other path is served from static assets without running it (`run_worker_first: ["/api/*"]` in `wrangler.jsonc`). Agent data lives in Neon (`neon/agent-schema.sql`), reached with node-postgres over TCP (Workers `nodejs_compat`). Moderators sign in with their Neon Auth forum account.

## 1. Configuration (Cloudflare Worker secrets and variables, server side only)

Set secrets with `npx wrangler secret put NAME` (or the Cloudflare dashboard, Worker, Settings, Variables and Secrets). Never put them in `wrangler.jsonc` or the repository.

| Name | Type | Required for | Notes |
| --- | --- | --- | --- |
| `AGENT_DATABASE_URL` | secret | all endpoints | Neon connection string for role `ufs_agent_worker` (pooled host, `sslmode=require`). |
| `NEON_AUTH_URL` | variable | admin API | the `authUrl` already in `forum-config.js`; the API verifies session JWTs against `<NEON_AUTH_URL>/.well-known/jwks.json` (EdDSA). |
| `NEON_AUTH_ISSUER`, `NEON_AUTH_AUDIENCE` | variable, optional | admin API | enforce `iss` / `aud` once their values are confirmed from a real token. |
| `CRON_SECRET` | secret | manual tick | at least 32 random characters; only for `POST /api/agent/cron`. |
| `AGENT_SCHEDULER_ENABLED` | variable | scheduler | `true` lets the Cron Trigger run the tick. Unset means the scheduled handler does nothing. |
| `META_APP_ID`, `META_APP_SECRET` | secret | webhook, token checks | App Secret signs webhooks. |
| `META_VERIFY_TOKEN` | secret | webhook setup | random string you also type in the Meta dashboard. |
| `META_PAGE_ACCESS_TOKEN` | secret | Facebook channel | referenced by the channel as `env:META_PAGE_ACCESS_TOKEN`. |
| `META_IG_ACCESS_TOKEN` | secret | Instagram channel | referenced as `env:META_IG_ACCESS_TOKEN`. |
| `META_GRAPH_VERSION` | variable, optional | | default `v27.0`. |
| `AGENT_AUTHOR_PEPPER` | secret | webhook | pseudonymises author ids (HMAC). The webhook refuses to run without it. |
| `ANTHROPIC_API_KEY` | secret | model | without it the agent runs rules-only. |
| `AGENT_MODEL` | variable, optional | | default `claude-opus-5-5`. Cheaper models are an owner cost decision. |
| `AGENT_LLM_ENABLED` | variable | model | `true` allows sending public content to the model. Keep unset until the privacy review is signed off. |
| `RESEND_API_KEY` | secret | email | dedicated sending key restricted to `notify.unitedforsitges.com`. |
| `AGENT_ADMIN_ORIGIN` | variable, optional | | default `https://unitedforsitges.com`. |
| `AGENT_ALLOW_SUPERVISED` / `AGENT_ALLOW_AUTONOMOUS` | variable | activation | must be `true` before anyone can select SUPERVISED / AUTONOMOUS. |
| `AGENT_LIVE_META_REPLIES` / `AGENT_LIVE_META_PUBLISHING` / `AGENT_LIVE_INSTAGRAM_PUBLISHING` / `AGENT_LIVE_EMAIL` | variable | live outbound | `true` lets the matching outbound path reach the provider. |

Unset means off. Every change creates a new Worker version, visible in the Cloudflare dashboard.

## 2. Deployment prerequisites (in order, each needs owner authorisation)

1. Review and merge the pull request. After merge, the next Workers build deploys the Worker script with the site. With no secrets set, `/api/agent/*` answers 503 and nothing runs. Confirm the Workers build installs npm dependencies (`npm ci`) before `wrangler deploy`; the bundle needs `pg` and `@anthropic-ai/sdk`.
2. Apply `neon/agent-schema.sql` to the Neon production branch (SQL editor or `psql` as the owner role), after `neon/schema.sql`. Consider testing on a Neon branch first.
3. In the SQL editor: `alter role ufs_agent_worker with login password '<strong random, 60+ bits>';` then build `AGENT_DATABASE_URL` with that role and the pooled host. Confirm `ufs_agent` is not exposed by the Neon Data API.
4. Load seed data: `node scripts/agent-seed.js` and run the output (all inactive).
5. Set the Worker secrets for the features being enabled (start with `AGENT_DATABASE_URL`, `NEON_AUTH_URL`, `AGENT_AUTHOR_PEPPER`).
6. Scheduler: add `"triggers": { "crons": ["*/5 * * * *"] }` to `wrangler.jsonc` and set `AGENT_SCHEDULER_ENABLED=true`. Cloudflare Cron Triggers are minute-level and included in the Free plan. Neon Free scales to zero when idle, so the first tick after a pause is slower; that is expected.
7. Sign in to `/agent-console.html` with the moderator forum account; check Overview shows SHADOW / SHADOW.

Cloudflare Free plan limits to watch (verify current values in the dashboard): 10 ms CPU per invocation (network waits do not count), 50 external subrequests per invocation, 100,000 requests per day. A long tick (model generation plus several sources) could exceed the CPU limit; if it does, the tick fails closed and the next one retries. Moving to Workers Paid is an owner cost decision.

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

Factual editorial posts require an additional source-attestation approval in the calendar slot's Review panel. Read the full post and both social captions, compare each factual statement with the linked original source, then click **Approve factual content**. This approval is fingerprint-bound to the exact content. Until approval, publication stays in NEEDS_REVIEW, including in AUTONOMOUS mode. Manual replacement of factual topics without evidence-backed claim mapping is disabled.

Erasure requests: open the case, choose "Erase stored data" (this item, or all items by this author), pick the reason code and type `ERASE STORED DATA`. The Privacy tab lists requests with their counts; a failed request changed nothing and can be retried there (the scheduler also retries it). Erasure is local only: remove the original comment or our reply on the platform separately. See `COMMUNITY_AGENT_DATA_MAP.md`.

## 5. Kill switch

Overview tab, "STOP all outbound actions", with a reason. It is checked by the policy layer and again immediately before every provider call. Scheduled posts held by the stop stay scheduled and expire if their window passes; nothing posts late. Release the stop from the same card. Other levers: pause one channel, disable a category, set a mode to DISABLED, unset the live variables, or remove the Cron Trigger / unset `AGENT_SCHEDULER_ENABLED`.

## 6. Monitoring and troubleshooting

- Overview: counts of interactions, awaiting review, urgent, failed events, failed replies, failed posts, today's schedule and usage counters.
- Failures tab: dead-lettered events (requeue), failed/blocked/unknown replies (requeue re-runs every guardrail), failed/unknown/expired publications.
- Cloudflare Worker logs (dashboard Observability, or `npx wrangler tail`): structured JSON events (`webhook_accepted`, `webhook_signature_rejected`, `agent_tick`, `agent_tick_skipped`, `api_unhandled_error`), no credentials.
- Cron Trigger history: Cloudflare dashboard, Worker, Settings, Triggers (past executions).

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Webhook 401 | wrong App Secret | check `META_APP_SECRET` |
| Webhook 503 | database unreachable or env missing | check `AGENT_DATABASE_URL`, Meta retries for 36 h |
| Events stay pending | scheduler not running | check the Cron Trigger and `AGENT_SCHEDULER_ENABLED` |
| Channel token `invalid` | expired or revoked token | regenerate, update the Worker secret, "Verify token" |
| Publication `unknown` | crash or network error after the write | check the Page, then "Reconcile" with the URL or "not published" |
| Slot `skipped: source_verification_stale` | source verification older than the window | re-verify the source |
| Slots not planned | topic bank exhausted within duplicate window | add topics to `data/agent/editorial-topics.json` or shorten the window |

## 7. Token renewal and credential rotation

- Page tokens obtained from a long-lived user token normally do not expire, but are invalidated by password changes, role removal or app de-authorisation. The agent marks a channel `invalid` on error 190 and stops using it.
- Use "Verify token" weekly (records validity, scopes, expiry from `debug_token`). Instagram Login tokens expire after about 60 days and must be refreshed (refresh endpoint not implemented; manual rotation).
- Rotation: create the new token, update the Worker secret, Verify token, revoke the old token in Meta. Rotate `CRON_SECRET`, `AGENT_DATABASE_URL` password, `RESEND_API_KEY` and `ANTHROPIC_API_KEY` at least every 6 months or after any suspected exposure. Rotating `AGENT_AUTHOR_PEPPER` breaks linkage of old author references, which is acceptable.

## 8. Incident recovery

1. Press the emergency stop.
2. Identify the scope in Audit and Failures.
3. If a wrong reply or post went live, remove it manually on the platform and record a case note. The agent has no delete capability by design.
4. Fix the cause (rule, FAQ text, source, setting, credential).
5. Requeue only what should still happen; expired posts stay expired.
6. Release the stop. For data incidents follow the privacy review (72 h breach assessment).

## 9. Rollback

- Functional rollback: set both modes to DISABLED or press the stop; unset the live variables; remove the Cron Trigger.
- Code rollback: roll back to the previous Worker version in the Cloudflare dashboard, or revert the merge commit; static pages are served by assets either way.
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

```bash
npm run check
```

```bash
npm run worker:build
```

```bash
npm run worker:smoke
```

`worker:build` bundles the Worker with `wrangler deploy --dry-run` (no account, no upload). `worker:smoke` starts the real Worker in workerd with `wrangler dev` (local mode) against the test database and checks static pages, hidden server files, fail-closed endpoints, a signed webhook stored once, the manual tick and the idle scheduler.

CI: `.github/workflows/agent-ci.yml` runs `npm run check`, the programme data validator, the schema build, `npm test`, `worker:build` and `worker:smoke` against a PostgreSQL 18 service container (Neon production runs 18) with `AGENT_REQUIRE_DB=1` (database tests may not silently skip), plus the site smoke test in a separate job. It uses no secrets and deploys nothing. Against a disposable server, `AGENT_TESTDB_ADMIN_URL=postgresql://postgres:pw@host:5432 bash scripts/agent-test-db.sh apply` builds the test schema.

The test database is a throwaway local PostgreSQL with Neon stand-ins (`tests/agent/fixtures/neon-stubs.sql`: Data API roles, a reduced `neon_auth."user"`, `auth.uid()`), the real `neon/schema.sql` and `neon/agent-schema.sql`. It never connects to Neon.
