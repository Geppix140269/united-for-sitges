# United for Sitges Community Agent: Technical Specification

Version 1.1 (brief 1.0 plus Addendum 1.1, autonomous editorial publishing). Date: 16 November 2026.
Status: implemented on branch `feat/u4s-community-agent-mvp`, all outbound behaviour OFF.

Deployment status (verified 16 November 2026):
- **Preview deployments exist.** Vercel and Netlify build every push to this pull request automatically. The Vercel preview is behind Vercel SSO protection; the Netlify preview is public and serves files statically only (Netlify does not run the `api/` functions). The Vercel project has no environment variables in any environment, so preview functions fail closed (503 `not_configured`). Previews are not test evidence; automated testing is the `Agent CI` GitHub Actions workflow.
- **No production deployment of this branch.** Production is `main` (`f845176`).
- **No activation.** No migration applied to live Supabase (no `ufs_agent` schema, no `ufs_agent_worker` role, no `pg_cron`/`pg_net`), no credentials, no scheduler, no outbound calls.

## 1. Phase 0 audit (verified facts, 16 November 2026)

| Area | Verified state | How verified |
| --- | --- | --- |
| Repository | Static site (no framework, no build, no package.json before this branch). `main` at `e3ecc85`. Open PR [Geppix140269/united-for-sitges#2](https://github.com/Geppix140269/united-for-sitges/pull/2) touches only `programmes.html` and research docs, no overlap. Branch `feat/u4s-community-agent-mvp` did not exist; created from `main`. Other branches (`claude/magical-faraday-pf65xx`, `community-features`) unrelated. | git, GitHub API |
| Vercel | Project `united-for-sitges` (`prj_h3KKSQUDQNtUeBfEkSzpRhoWsTQT`), framework none, Node 26.x, latest production deployment READY. **No environment variables set.** Deployment protection (SSO) on all non-custom domains, so preview URLs cannot receive Meta webhooks. | Vercel API (read only) |
| Supabase | Project `tlmkeofpeigkfxdydwqt`, eu-west-1, Postgres 17, ACTIVE_HEALTHY. 9 migrations recorded remotely. 2 auth users, 2 profiles, 1 moderator, 3 topics, 0 replies, 0 reports. No Edge Functions. Extensions installed: pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault. **pg_cron and pg_net are NOT installed.** | Supabase MCP, read-only SQL |
| Forum RLS | RLS enabled on `ufs_profiles`, `ufs_topics`, `ufs_replies`, `ufs_reports`. Column-level grants match the repository SQL. | `pg_class`, `information_schema.column_privileges` |
| `ufs_internal.admin_contact` | RLS **disabled**. anon and authenticated have **no USAGE** on `ufs_internal` and no table privileges; schema not exposed. Effective exposure: none. Hardening proposed in `supabase/proposed/harden_admin_contact.sql` (rehearsed locally, moderator bootstrap still works). Not applied. | `has_schema_privilege`, `has_table_privilege` |
| Security Advisor | One warning: leaked password protection disabled. Not changed (Auth settings change needs owner approval). | Supabase advisors |
| Resend | Domain `notify.unitedforsitges.com` verified per repo records (`FORUM_GO_LIVE.md`). The Resend connector in this session needs authorisation, so the account itself was not inspected. No Resend API key exists in Vercel. | Repo docs |
| Meta | No Meta credentials, App ID, Page ID or token available anywhere in the repo, Vercel or this session. The Facebook Page created in an earlier browser session is **unverified**. No Instagram Professional account confirmed. | Inspection; nothing assumed |

Repository drift noted: remote migration versions (`20261111200553` and others) do not match the file names in `supabase/migrations/` (several use `20261111_` prefixes) and `reserve_primary_forum_administrator_email` has no file. Our local test harness applies files in the remote order and stubs `admin_contact`. Recommend reconciling with `supabase migration fetch` before any `db push`.

Other observations:
- The GitHub repository description reads "Political campaign platform for the 2027 Sitges municipal elections", which contradicts the non-partisan positioning. Owner decision.
- `public.ufs_topics.author_id` and `ufs_replies.author_id` are readable by anon (auth user UUIDs exposed with approved posts). Low risk, worth a separate review.

## 2. Architecture

```
Meta Webhooks ──> /api/agent/meta-webhook  (verify HMAC, dedupe, store, 200)
                         │
                         ▼
                  ufs_agent.events (durable queue, private schema)
                         │  leased by
Supabase Cron ──> /api/agent/cron  (CRON_SECRET) ── runTick():
   every 5 min        forum ingest ─ events ─ actions ─ plan ─ generate ─ publish ─ metrics ─ alerts ─ digest ─ retention
                         │                              │                 │
                 classification (rules + Claude)   editorial engine   publication controller
                         │                              │                 │
                 cases / drafts / actions        content + gates     policy.authorizePublication
                         │                                                │
                 executor (policy.authorizeReply) ─────> adapters (Facebook, Instagram, mock) ─> Graph API
                         │
Moderators ──> /agent-console.html ──> /api/agent/admin (Supabase Auth token + ufs_profiles moderator check)
```

Runtime: Vercel Node.js functions using the Web `Request`/`Response` handler signature, so the webhook can read the raw body for HMAC verification. Three functions only (`api/agent/meta-webhook.js`, `api/agent/cron.js`, `api/agent/admin.js`); all logic lives in `lib/agent/`. Dependencies: `pg` (database) and `@anthropic-ai/sdk` (model), pinned. The static site is untouched apart from the new `agent-console.html`, `js/agent-console.js` and `assets/agent/cards/`.

Separation of duties:
- **Read/classify** (`moderation.js`, `classify/`, `editorial/generate.js`): may call the model, may write cases, drafts and pending actions. Has no reference to any provider write method.
- **Policy** (`policy.js`): pure, deterministic functions. Every outbound call is authorised here against freshly read state.
- **Execute** (`executor.js`, `editorial/publisher.js`): the only code that calls `replyToComment` / `publishPost`, after a lease, a fresh settings read, the policy check, target and duplicate reconciliation, and a last-instant emergency-stop read.
- **Adapters** (`adapters/`): know HTTP details only, never decide.

The model has no tools. It returns JSON that must pass a closed schema (`schema.js`, unknown keys rejected). It never constructs an API request.

## 3. Operating modes

| Control | States | Initial | Effect |
| --- | --- | --- | --- |
| Moderation | DISABLED, SHADOW, SUPERVISED | SHADOW | SHADOW: ingest, classify, draft, audit; replies only simulated. SUPERVISED: approved FAQ auto replies (if also enabled per channel) and human-approved replies are sent. |
| Editorial publishing | DISABLED, SHADOW, AUTONOMOUS | SHADOW | SHADOW: plan, generate, validate, schedule, simulate. AUTONOMOUS: eligible content posts without per-post approval. |
| Emergency stop | on/off | off | Blocks every outbound action; re-read immediately before every provider call. |

Defence in depth for activation. A live call needs ALL of:
1. the database mode (SUPERVISED / AUTONOMOUS) set by a moderator with a typed confirmation;
2. the deployment allowing that mode (`AGENT_ALLOW_SUPERVISED`, `AGENT_ALLOW_AUTONOMOUS`);
3. the provider live switch (`AGENT_LIVE_META_REPLIES`, `AGENT_LIVE_META_PUBLISHING`, `AGENT_LIVE_INSTAGRAM_PUBLISHING`);
4. a verified channel with a valid token, verified permissions, capability flag, not paused;
5. all content, approval, limit and duplicate checks.
All env switches default to off, so a fresh deployment can never post. There is no fully autonomous moderation mode.

## 4. Data model (`supabase/migrations/20261116120000_community_agent_foundation.sql`)

Private schema `ufs_agent` (not exposed to the Data API; no USAGE for anon/authenticated). RLS enabled and forced on every table; only role `ufs_agent_worker` has policies. The worker is `NOLOGIN` in the migration; the owner enables login out of band.

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `settings` | modes, kill switch, limits, digest, retention | closed key set, mode enums checked |
| `channels` | authorised accounts and capabilities | `unique(provider, external_account_id)`; `credential_ref` must match `env:NAME` so no token can be stored |
| `events` | durable inbound queue | `unique(idempotency_key)`, lease columns, bounded excerpt (2000), author stored only as HMAC |
| `cases` | one review case per event | `unique(event_id)` |
| `faq` | human-approved templates | active requires approver, approval time, expiry, fingerprint; trigger revokes approval on any text change |
| `drafts` | versioned replies | `unique(case_id, version)`; text immutable (trigger); approval must equal content fingerprint |
| `actions` | outbound replies | `unique(idempotency_key)`; partial unique index: one executing/succeeded/unknown reply per target |
| `sources` | approved source registry | active requires verifier and verification time |
| `editorial_calendar` | rolling plan | `unique(planned_date, planned_slot)`, slot in (morning, evening) |
| `content` | generated or human content with gate results | revisioned, content hash |
| `publications` | per channel posts | `unique(channel_id, scheduled_local_date, scheduled_slot)` and `unique(idempotency_key)` |
| `publication_metrics` | platform metrics | `metrics_available` with reason when not |
| `audit_log` | append-only history | trigger blocks updates and deletes younger than 365 days |
| `usage_counters` | daily quotas and cost visibility | atomic conditional upsert |
| `digests` | daily, weekly, alert emails | `unique(kind, period_key)` makes reports idempotent |
| `external_notes` | manual review of third-party groups | human-entered only |

Forum access goes through `ufs_agent.forum_items_since()` (SECURITY DEFINER, minimum columns); moderator checks through `ufs_agent.is_active_moderator()`. Existing forum tables, policies and grants are unchanged.

## 5. Endpoints

| Endpoint | Auth | Behaviour |
| --- | --- | --- |
| `GET /api/agent/meta-webhook` | `hub.verify_token` (constant-time) | Returns `hub.challenge`. |
| `POST /api/agent/meta-webhook` | `X-Hub-Signature-256` over the raw body, constant time | 415 non-JSON, 413 over 256 KB, 401 bad signature, 400 bad JSON, 200 for valid (including signed-but-malformed, dropped), 503 if storage fails so Meta retries (up to 36 h). Never replies or publishes. |
| `GET/POST /api/agent/cron?jobs=...` | `Authorization: Bearer CRON_SECRET` (min 32 chars) | Runs the idempotent tick. |
| `GET /api/agent/admin?view=...` | Supabase Auth access token verified by `/auth/v1/user`, then `is_active_moderator` | Views: overview, channels, cases, case, events, faq, sources, calendar, publications, failures, audit, digests, digest_preview, external_notes. |
| `POST /api/agent/admin` | same, plus Origin check, 32 KB limit | Actions listed in `lib/agent/handlers/admin.js` (emergency stop, modes, schedule, limits, channels, drafts, FAQ, sources, calendar, content replacement, retries, reconciliation, notes, redaction). |

Admin authorisation never reads `user_metadata` or client flags.

## 6. Inbound decision pipeline

1. Webhook verified, parsed into minimal events (comment id, parent, bounded excerpt, author HMAC, page-authored flag), deduplicated by idempotency key (edits get a new key).
2. Worker leases events (`FOR UPDATE SKIP LOCKED`, 120 s lease). Expired leases are reclaimed; each event gets at most one case.
3. Deterministic rules (`classify/rules.js`): threats, personal data (phone, email, DNI/NIE, IBAN, addresses), personal attacks (insult plus a person target; criticism of policies is not harassment), electoral and political vocabulary (party names from `data/parties.json`), allegations, spam, prompt-injection patterns, language.
4. Optional model classification (only if `AGENT_LLM_ENABLED=true`, within the daily model budget): closed schema, untrusted content inside a random per-request boundary. Rules can only raise risk; model output cannot lower it. Invalid output is discarded and recorded.
5. FAQ: only if no rule signal at all, the model (if used) agrees on a low-risk platform question, and exactly one approved, unexpired, channel-allowed FAQ matches. The reply is the stored text plus an automated-reply disclosure.
6. Otherwise: AI draft for answerable categories (never for spam, harassment, personal data, threats, or when injection is detected), validated deterministically (registry-only links, no advocacy, no party mentions, no human-identity claims, no personal data, dates flagged, electoral answers must cite an official source). Drafts that fail validation must be edited by a person before approval.
7. High and critical cases are escalated and trigger an urgent alert (dry run until email is enabled).

## 7. Editorial pipeline

1. `planCalendar` fills a 7-day rolling calendar, two slots per local date, from `data/agent/editorial-topics.json`. Morning prefers informative topics, evening prefers open questions. Disabled categories and topics used within the duplicate window are skipped; when no topic fits, the slot stays empty (nothing invented).
2. `generateUpcoming` leases slots due in the next 36 h. Factual topics need every listed source to be active, human-verified within the configured window (default 90 days) and retrievable now (status, hash, Last-Modified recorded).
3. Model output (closed schema) must include, for each factual claim, a supporting excerpt that is found verbatim in the retrieved source text.
4. Gates (`editorial/validate.js`): excerpt support, numbers present in excerpts, no advocacy, no party or candidate mentions, no comparative political claims, sensitive electoral wording goes to review, no fabricated community voices, no human-identity claims, no personal data, registry-only links, primary language, duplicate topic and text similarity, platform limits. Hard failure blocks; review failure holds for a person.
5. Publishable content becomes one publication per enabled channel (Facebook text with sources and an AI-assistance note; Instagram caption plus a first-party branded JPEG card validated for format, size, width and aspect ratio).
6. `publishDue` leases due rows, re-reads settings, applies `authorizePublication`, enforces the 45-minute window (late posts expire, never post late), the per-channel daily limit (max 2), quotas, reconciliation against recent posts, and a final kill-switch read before the call. Instagram containers are resumed by id, never recreated.
7. Metrics are collected once per ~20 h for 14 days using documented metrics (`post_media_view`, `post_clicks`, `post_reactions_by_type_total`); unavailable metrics are recorded as unavailable, never estimated.

## 8. Reliability

| Risk | Control |
| --- | --- |
| Duplicate webhooks | unique idempotency key |
| Worker restart mid-event | lease expiry and reclaim; `unique(event_id)` on cases |
| Crash after a provider write | lease expiry turns the row into `unknown`; no automatic retry; reconciliation in the console |
| Concurrent schedulers | `FOR UPDATE SKIP LOCKED`, one action per target in flight (partial unique index), unique slot per channel/day |
| Retries | bounded exponential backoff (1 m to 6 h), honouring Meta `estimated_time_to_regain_access`; dead-letter after max attempts |
| DST | slot identity is local date plus slot name; `zonedTimeToUtc` returns exactly one instant per slot |
| Missed windows | expire instead of late posting |
| Expired token / missing permission | channel flagged, action failed, no retry loop |
| Provider outage | retryable only with an explicit provider error; network errors on writes become `unknown` |

## 9. Security design summary

- Secrets only in Vercel environment variables; the database stores `env:NAME` references (enforced by a CHECK constraint). Logs strip keys whose names look like secrets.
- Webhook: raw-body HMAC, constant-time comparison, size and shape limits, prompt acknowledgement, durable queue.
- Admin: verified Supabase session, server-side moderator check, Origin check, fingerprint-bound approvals, full audit with actor and exact text.
- Model: no tools, closed schemas, untrusted boundaries, deterministic overrides.
- Outbound retrieval (`lib/agent/net/safe-get.js`, used for source pages and card images): HTTPS on port 443 only, no credentials or IP literals in URLs, exact host allowlist (active registry hosts; `unitedforsitges.com` for images), redirects followed manually (max 3) and fully re-validated, every DNS answer must be public unicast (private, loopback, link-local, metadata, CGNAT, multicast, reserved, NAT64/6to4/Teredo and mapped ranges refused), the same guarded lookup is used by the socket at connect time so a rebinding answer is refused, no connection reuse, identity encoding, 2 MB (8 MB for images) streamed limit, 12 s timeout. Provider API clients (Graph, Supabase Auth, Resend, Anthropic) only call fixed hosts built in code.
- Database: private schema, forced RLS, least-privilege worker, append-only audit, no deletes of operational records.
- Browser: console renders all public content with `textContent`; no service keys in the browser.

## 10. Testing

`npm run check` (static checks, default-off assertions, secret scan), `npm test` with `AGENT_TEST_DATABASE_URL` from `bash scripts/agent-test-db.sh start` (throwaway local PostgreSQL with Supabase stubs, real forum schema, existing migrations and the agent migration), and `node scripts/agent-site-smoke.js`. Mocked Meta, Claude, sources and Resend; no real provider call is made by any test. GitHub Actions workflow `.github/workflows/agent-ci.yml` runs the same checks against a PostgreSQL 17 service (the production major version) plus the smoke test. Results are listed in the pull request.
