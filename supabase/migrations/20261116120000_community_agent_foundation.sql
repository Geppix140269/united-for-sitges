-- United for Sitges Community Agent: foundation schema (version 1.1).
-- STATUS: NOT APPLIED. Review only. Do not run against production
-- (tlmkeofpeigkfxdydwqt) without explicit owner authorisation.
--
-- Design summary
-- * All agent data lives in the private schema ufs_agent. It is NOT in the
--   Data API exposed schemas and anon/authenticated get no USAGE, so no
--   browser key can reach it. RLS is also enabled on every table (defence in
--   depth) with explicit policies only for the backend worker role.
-- * The backend connects as ufs_agent_worker (NOLOGIN here; the owner enables
--   LOGIN with a password out of band, never committed). It is not a
--   superuser, does not bypass RLS and cannot touch auth.* or forum writes.
-- * Existing forum tables, policies and grants are NOT modified. The worker
--   reads forum items only through one SECURITY DEFINER function returning
--   the minimum columns needed for moderation triage.
-- * Exactly-once business rules are enforced with unique constraints
--   (events, actions, publications per channel/local date/slot, digests).
-- * No column stores access tokens. Channels hold a credential_ref naming a
--   server-side secret (for example env:META_PAGE_ACCESS_TOKEN).

create schema if not exists ufs_agent;
revoke all on schema ufs_agent from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on schema ufs_agent from anon';
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on schema ufs_agent from authenticated';
  end if;
  if not exists (select 1 from pg_roles where rolname='ufs_agent_worker') then
    create role ufs_agent_worker nologin noinherit nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
grant usage on schema ufs_agent to ufs_agent_worker;

-- Prevent Supabase default privileges from leaking future objects.
alter default privileges in schema ufs_agent revoke all on tables from public;
alter default privileges in schema ufs_agent revoke all on functions from public;
alter default privileges in schema ufs_agent revoke all on sequences from public;

-- ---------------------------------------------------------------------------
-- Settings (operating modes, kill switch, limits). Keys are a closed set.
-- ---------------------------------------------------------------------------
create table ufs_agent.settings (
  key text primary key check (key in ('moderation','publishing','emergency_stop','limits','digest','retention')),
  value jsonb not null check (jsonb_typeof(value)='object'),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint moderation_mode_valid check (key<>'moderation' or value->>'mode' in ('DISABLED','SHADOW','SUPERVISED')),
  constraint publishing_mode_valid check (key<>'publishing' or value->>'mode' in ('DISABLED','SHADOW','AUTONOMOUS')),
  constraint emergency_stop_valid check (key<>'emergency_stop' or jsonb_typeof(value->'active')='boolean')
);

insert into ufs_agent.settings(key,value) values
 ('moderation', jsonb_build_object('mode','SHADOW','auto_reply_enabled',false)),
 ('publishing', jsonb_build_object(
    'mode','SHADOW',
    'autonomous_publishing_enabled',false,
    'morning_publish_time','09:00',
    'evening_publish_time','18:00',
    'timezone','Europe/Madrid',
    'permitted_content_categories', jsonb_build_array(
      'civic_information','local_government','electoral_resources','urban_planning',
      'mobility','tourism','local_economy','community_wellbeing','environment',
      'international_integration','platform_updates','community_questions'),
    'daily_post_limit',2,
    'minimum_source_verification','verified_within_90_days',
    'duplicate_content_window_days',10,
    'duplicate_similarity_threshold',0.6,
    'publish_window_minutes',45,
    'planning_horizon_days',7,
    'content_generation_budget_per_day',6,
    'forum_publishing_enabled',false)),
 ('emergency_stop', jsonb_build_object('active',false)),
 ('limits', jsonb_build_object(
    'model_calls_per_day',200,
    'events_per_day',1000,
    'external_api_ops_per_day',300,
    'outbound_per_day',20,
    'max_attempts',5)),
 ('digest', jsonb_build_object('send_enabled',false,'recipient','hello@giuseppefunaro.com','sender',null,'dashboard_url','https://unitedforsitges.com/agent-console.html')),
 ('retention', jsonb_build_object('event_content_days',90,'audit_days',730,'metrics_days',400));

-- ---------------------------------------------------------------------------
-- Channels: authorised accounts. Publishing and moderation default OFF.
-- ---------------------------------------------------------------------------
create table ufs_agent.channels (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('facebook_page','instagram','forum','mock')),
  external_account_id text not null check (length(external_account_id) between 1 and 64),
  account_label text not null check (length(account_label) between 1 and 120),
  connection_status text not null default 'unverified'
    check (connection_status in ('unverified','verified','token_invalid','disconnected')),
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities)='object'),
  credential_ref text check (credential_ref is null or credential_ref ~ '^env:[A-Z][A-Z0-9_]{2,63}$'),
  ingest_enabled boolean not null default false,
  auto_reply_enabled boolean not null default false,
  publishing_enabled boolean not null default false,
  paused boolean not null default false,
  language_preference text not null default 'en' check (language_preference in ('en','es','ca','en+es','en+ca','en+es+ca')),
  max_posts_per_day smallint not null default 2 check (max_posts_per_day between 0 and 2),
  token_status text not null default 'unknown' check (token_status in ('unknown','valid','expired','invalid','missing_permissions')),
  token_checked_at timestamptz,
  permissions_verified jsonb not null default '[]'::jsonb check (jsonb_typeof(permissions_verified)='array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_account_id)
);

-- ---------------------------------------------------------------------------
-- Inbound events (durable queue). Minimal content only.
-- ---------------------------------------------------------------------------
create table ufs_agent.events (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references ufs_agent.channels(id) on delete restrict,
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 200),
  external_object_id text not null check (length(external_object_id) between 1 and 128),
  external_parent_id text check (external_parent_id is null or length(external_parent_id)<=128),
  event_type text not null check (event_type in ('comment_added','comment_edited','comment_removed','post_added','forum_topic','forum_reply','forum_report','manual_external')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'pending'
    check (processing_status in ('pending','processing','processed','ignored','failed','dead')),
  attempt_count integer not null default 0 check (attempt_count>=0),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text check (last_error_code is null or length(last_error_code)<=80),
  content_excerpt text check (content_excerpt is null or length(content_excerpt)<=2000),
  author_ref text check (author_ref is null or author_ref ~ '^[a-f0-9]{64}$'),
  author_is_page boolean not null default false,
  permalink text check (permalink is null or (permalink ~ '^https://' and length(permalink)<=500)),
  language text check (language is null or language in ('en','es','ca','other')),
  payload_checksum text not null check (payload_checksum ~ '^[a-f0-9]{64}$'),
  content_purged_at timestamptz
);
create index events_queue_idx on ufs_agent.events(processing_status, next_attempt_at);
create index events_received_idx on ufs_agent.events(received_at desc);

-- ---------------------------------------------------------------------------
-- Review cases (one per event).
-- ---------------------------------------------------------------------------
create table ufs_agent.cases (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references ufs_agent.events(id) on delete cascade,
  category text not null check (category in (
    'platform_info','approved_faq','civic_information','electoral_procedure','political_discussion',
    'community_feedback','complaint','spam','harassment','personal_information','threat_or_unlawful','unclear')),
  risk_level text not null check (risk_level in ('low','medium','high','critical')),
  priority smallint not null default 3 check (priority between 1 and 5),
  summary text not null check (length(summary) between 1 and 400),
  status text not null default 'open' check (status in ('open','awaiting_approval','auto_handled','resolved','dismissed','escalated')),
  classification jsonb not null default '{}'::jsonb,
  faq_id uuid,
  assigned_to uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cases_status_idx on ufs_agent.cases(status, priority, created_at desc);

-- ---------------------------------------------------------------------------
-- Human-approved FAQ templates. Never promoted from AI output automatically.
-- ---------------------------------------------------------------------------
create table ufs_agent.faq (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,60}$'),
  canonical_question text not null check (length(canonical_question) between 5 and 300),
  match_phrases text[] not null check (cardinality(match_phrases) between 1 and 30),
  approved_answer text not null check (length(approved_answer) between 10 and 1200),
  language text not null check (language in ('en','es','ca')),
  source_url text check (source_url is null or source_url ~ '^https://'),
  source_verified_at timestamptz,
  is_factual boolean not null default false,
  approved_by uuid,
  approved_at timestamptz,
  expires_at timestamptz,
  allowed_channels text[] not null default '{}'::text[],
  active boolean not null default false,
  answer_fingerprint text,
  origin text not null default 'human' check (origin in ('human')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint faq_active_requires_approval check (not active or (approved_by is not null and approved_at is not null and expires_at is not null and answer_fingerprint is not null)),
  constraint faq_factual_requires_source check (not is_factual or not active or (source_url is not null and source_verified_at is not null))
);
alter table ufs_agent.cases add constraint cases_faq_fk foreign key (faq_id) references ufs_agent.faq(id) on delete set null;

-- Any change to the answer or matching rules revokes approval unless the
-- same statement records a fresh approval with the matching fingerprint.
create function ufs_agent.faq_revoke_on_change() returns trigger
language plpgsql set search_path='' as $$
begin
  -- Every field affecting who may receive a response, its factual basis,
  -- the approved wording or its validity period requires fresh approval.
  if (new.approved_answer is distinct from old.approved_answer
      or new.canonical_question is distinct from old.canonical_question
      or new.match_phrases is distinct from old.match_phrases
      or new.language is distinct from old.language
      or new.source_url is distinct from old.source_url
      or new.source_verified_at is distinct from old.source_verified_at
      or new.is_factual is distinct from old.is_factual
      or new.allowed_channels is distinct from old.allowed_channels
      or new.expires_at is distinct from old.expires_at)
     and new.approved_at is not distinct from old.approved_at then
    new.active := false;
    new.approved_by := null;
    new.approved_at := null;
    new.answer_fingerprint := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger faq_revoke_on_change before update on ufs_agent.faq
for each row execute function ufs_agent.faq_revoke_on_change();

-- ---------------------------------------------------------------------------
-- Drafts: versioned, approval bound to an exact content fingerprint.
-- ---------------------------------------------------------------------------
create table ufs_agent.drafts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references ufs_agent.cases(id) on delete cascade,
  version integer not null check (version>=1),
  proposed_answer text not null check (length(proposed_answer) between 1 and 2000),
  source_references jsonb not null default '[]'::jsonb check (jsonb_typeof(source_references)='array'),
  validation_state text not null default 'unvalidated' check (validation_state in ('unvalidated','passed','failed')),
  validation_notes jsonb not null default '[]'::jsonb,
  origin text not null check (origin in ('ai','human','faq')),
  status text not null default 'proposed' check (status in ('proposed','approved','rejected','superseded','published','failed')),
  content_fingerprint text not null check (content_fingerprint ~ '^[a-f0-9]{64}$'),
  approved_by uuid,
  approved_at timestamptz,
  approved_fingerprint text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (case_id, version),
  constraint draft_approval_complete check (status not in ('approved','published') or (approved_by is not null and approved_at is not null and approved_fingerprint = content_fingerprint))
);
create index drafts_case_idx on ufs_agent.drafts(case_id, version desc);

-- Draft text is immutable: edits create a new version.
create function ufs_agent.drafts_immutable_text() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.proposed_answer is distinct from old.proposed_answer
     or new.content_fingerprint is distinct from old.content_fingerprint
     or new.case_id is distinct from old.case_id then
    raise exception 'draft text is immutable; create a new version';
  end if;
  return new;
end $$;
create trigger drafts_immutable_text before update on ufs_agent.drafts
for each row execute function ufs_agent.drafts_immutable_text();

-- ---------------------------------------------------------------------------
-- Approved source registry for factual content.
-- ---------------------------------------------------------------------------
create table ufs_agent.sources (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,60}$'),
  title text not null check (length(title) between 3 and 200),
  url text not null unique check (url ~ '^https://' and length(url)<=500),
  publisher text not null,
  source_class text not null check (source_class in ('official_municipal','official_regional','official_national','electoral_authority','first_party')),
  languages text[] not null default '{}'::text[],
  categories text[] not null default '{}'::text[],
  verified_by text,
  verified_at timestamptz,
  review_by timestamptz,
  active boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_active_requires_verification check (not active or (verified_at is not null and verified_by is not null))
);

-- ---------------------------------------------------------------------------
-- Editorial calendar, content, publications, metrics.
-- ---------------------------------------------------------------------------
create table ufs_agent.editorial_calendar (
  id uuid primary key default gen_random_uuid(),
  planned_date date not null,
  planned_slot text not null check (planned_slot in ('morning','evening')),
  category text not null check (category in (
    'civic_information','local_government','electoral_resources','urban_planning','mobility','tourism',
    'local_economy','community_wellbeing','environment','international_integration','platform_updates','community_questions')),
  topic text not null check (length(topic) between 3 and 200),
  topic_key text not null check (topic_key ~ '^[a-z0-9-]{3,80}$'),
  source_requirements jsonb not null default '{}'::jsonb,
  priority smallint not null default 3 check (priority between 1 and 5),
  status text not null default 'planned' check (status in ('planned','generating','ready','needs_review','skipped','published','partially_published','failed','cancelled')),
  status_reason text,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (planned_date, planned_slot)
);
create index calendar_status_idx on ufs_agent.editorial_calendar(status, planned_date);

create table ufs_agent.content (
  id uuid primary key default gen_random_uuid(),
  editorial_calendar_id uuid not null references ufs_agent.editorial_calendar(id) on delete cascade,
  revision integer not null default 1 check (revision>=1),
  canonical_content jsonb not null check (jsonb_typeof(canonical_content)='object'),
  source_references jsonb not null default '[]'::jsonb check (jsonb_typeof(source_references)='array'),
  factual_verification_status text not null check (factual_verification_status in ('passed','failed','not_required')),
  neutrality_validation_status text not null check (neutrality_validation_status in ('passed','failed')),
  duplication_status text not null check (duplication_status in ('unique','duplicate')),
  publishability text not null check (publishability in ('publishable','needs_review','blocked')),
  gate_results jsonb not null default '[]'::jsonb,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  origin text not null check (origin in ('ai','human')),
  approved_by uuid,
  approved_at timestamptz,
  superseded boolean not null default false,
  created_at timestamptz not null default now(),
  unique (editorial_calendar_id, revision)
);
create index content_hash_idx on ufs_agent.content(content_hash);

create table ufs_agent.publications (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references ufs_agent.content(id) on delete restrict,
  channel_id uuid not null references ufs_agent.channels(id) on delete restrict,
  scheduled_at timestamptz not null,
  scheduled_local_date date not null,
  scheduled_slot text not null check (scheduled_slot in ('morning','evening')),
  platform_text text not null check (length(platform_text) between 1 and 5000),
  media_reference text check (media_reference is null or media_reference ~ '^https://'),
  text_fingerprint text not null check (text_fingerprint ~ '^[a-f0-9]{64}$'),
  publication_status text not null default 'scheduled'
    check (publication_status in ('scheduled','publishing','published','simulated','failed','skipped','needs_review','expired','cancelled','unknown')),
  status_reason text,
  provider_post_id text,
  provider_post_url text,
  provider_container_id text,
  attempt_count integer not null default 0 check (attempt_count>=0),
  next_attempt_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  published_at timestamptz,
  error_code text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Core exactly-once rule: one publication per channel per local day per slot.
  unique (channel_id, scheduled_local_date, scheduled_slot)
);
create index publications_due_idx on ufs_agent.publications(publication_status, scheduled_at);

create table ufs_agent.publication_metrics (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references ufs_agent.publications(id) on delete cascade,
  collected_at timestamptz not null default now(),
  impressions integer check (impressions is null or impressions>=0),
  reach integer check (reach is null or reach>=0),
  reactions integer check (reactions is null or reactions>=0),
  comments integer check (comments is null or comments>=0),
  shares integer check (shares is null or shares>=0),
  clicks integer check (clicks is null or clicks>=0),
  metrics_available boolean not null,
  unavailable_reason text
);
create index metrics_pub_idx on ufs_agent.publication_metrics(publication_id, collected_at desc);

-- ---------------------------------------------------------------------------
-- Outbound actions (replies). Only the deterministic executor runs these.
-- ---------------------------------------------------------------------------
create table ufs_agent.actions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references ufs_agent.cases(id) on delete set null,
  draft_id uuid references ufs_agent.drafts(id) on delete set null,
  actor_type text not null check (actor_type in ('system','human')),
  actor_id text,
  action_type text not null check (action_type in ('reply_comment')),
  target_channel_id uuid not null references ufs_agent.channels(id) on delete restrict,
  external_target_id text not null check (length(external_target_id) between 1 and 128),
  payload_text text not null check (length(payload_text) between 1 and 2000),
  payload_fingerprint text not null check (payload_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique,
  execution_status text not null default 'pending'
    check (execution_status in ('pending','executing','succeeded','simulated','failed','blocked','cancelled','unknown')),
  status_reason text,
  attempt_count integer not null default 0 check (attempt_count>=0),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  external_result_id text,
  executed_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- At most one successful reply per target comment, whatever the key.
create unique index actions_one_success_per_target on ufs_agent.actions(target_channel_id, external_target_id, action_type)
  where execution_status in ('succeeded','executing','unknown');
create index actions_queue_idx on ufs_agent.actions(execution_status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Audit log (append only), usage counters, digests.
-- ---------------------------------------------------------------------------
create table ufs_agent.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('system','human','ai','provider')),
  actor_id text,
  action text not null check (length(action) between 3 and 80),
  entity_type text not null,
  entity_id text,
  detail jsonb not null default '{}'::jsonb
);
create index audit_at_idx on ufs_agent.audit_log(at desc);
create index audit_entity_idx on ufs_agent.audit_log(entity_type, entity_id);

create function ufs_agent.audit_append_only() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' then
    raise exception 'audit_log is append-only';
  end if;
  -- Deletes are permitted only for rows older than the retention floor (365 days).
  if tg_op='DELETE' and old.at > now() - interval '365 days' then
    raise exception 'audit rows younger than 365 days cannot be deleted';
  end if;
  return old;
end $$;
create trigger audit_append_only before update or delete on ufs_agent.audit_log
for each row execute function ufs_agent.audit_append_only();

create table ufs_agent.usage_counters (
  day date not null,
  metric text not null check (metric in ('model_calls','events','external_api_ops','outbound','retries','model_input_tokens','model_output_tokens')),
  count bigint not null default 0 check (count>=0),
  primary key (day, metric)
);

create table ufs_agent.digests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('daily','weekly','alert')),
  period_key text not null check (length(period_key) between 8 and 64),
  status text not null default 'generating' check (status in ('generating','generated','dry_run','sending','sent','failed')),
  subject text,
  body_text text,
  content_hash text,
  provider_message_id text,
  generated_at timestamptz not null default now(),
  sent_at timestamptz,
  error_code text,
  unique (kind, period_key)
);

-- ---------------------------------------------------------------------------
-- Manual review of external discussions (no scraping, no automation).
-- ---------------------------------------------------------------------------
create table ufs_agent.external_notes (
  id uuid primary key default gen_random_uuid(),
  source_label text not null check (length(source_label) between 3 and 160),
  source_url text check (source_url is null or source_url ~ '^https://'),
  summary text not null check (length(summary) between 3 and 1000),
  topic_category text,
  follow_up text check (follow_up is null or follow_up in ('none','faq_candidate','editorial_candidate','escalate')),
  created_by uuid not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Forum read bridge: minimum fields for triage, without altering forum RLS.
-- Returns no email. author_id is returned only so the application can store a
-- one-way HMAC reference; the raw id is never persisted in ufs_agent tables.
-- ---------------------------------------------------------------------------
-- Stable composite cursor prevents rows sharing a timestamp from being
-- permanently skipped when the result is paginated in batches of 100.
create function ufs_agent.forum_items_since(since timestamptz, since_id uuid, max_rows integer default 100)
returns table(kind text, id uuid, topic_id uuid, author_id uuid, title text, body text, status text, created_at timestamptz)
language sql stable security definer set search_path='' as $forum_body$
  (select 'topic'::text, t.id, t.id, t.author_id, t.title, t.body, t.status, t.created_at
     from public.ufs_topics t where (t.created_at, t.id) > (since, since_id))
  union all
  (select 'reply'::text, r.id, r.topic_id, r.author_id, null::text, r.body, r.status, r.created_at
     from public.ufs_replies r where (r.created_at, r.id) > (since, since_id))
  union all
  (select 'report'::text, rp.id, rp.topic_id, rp.reporter_id, null::text, rp.reason, rp.status, rp.created_at
     from public.ufs_reports rp where (rp.created_at, rp.id) > (since, since_id))
  order by 8 asc, 2 asc
  limit least(greatest(max_rows,1),500);
$forum_body$;
revoke all on function ufs_agent.forum_items_since(timestamptz,uuid,integer) from public;

-- Moderator check used by the admin API (identity comes from a verified
-- Supabase Auth access token; never from user_metadata).
create function ufs_agent.is_active_moderator(uid uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.ufs_profiles p where p.user_id=uid and p.is_moderator and not p.is_suspended);
$$;
revoke all on function ufs_agent.is_active_moderator(uuid) from public;

-- ---------------------------------------------------------------------------
-- RLS on every table, worker-only policies, explicit least-privilege grants.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['settings','channels','events','cases','faq','drafts','sources','editorial_calendar',
    'content','publications','publication_metrics','actions','audit_log','usage_counters','digests','external_notes']
  loop
    execute format('alter table ufs_agent.%I enable row level security', t);
    execute format('alter table ufs_agent.%I force row level security', t);
    execute format('revoke all on ufs_agent.%I from public', t);
    if exists (select 1 from pg_roles where rolname='anon') then
      execute format('revoke all on ufs_agent.%I from anon, authenticated', t);
    end if;
    execute format('create policy %I on ufs_agent.%I for all to ufs_agent_worker using (true) with check (true)', 'worker_'||t, t);
  end loop;
end $$;

grant select, insert, update on
  ufs_agent.settings, ufs_agent.channels, ufs_agent.events, ufs_agent.cases, ufs_agent.faq,
  ufs_agent.drafts, ufs_agent.sources, ufs_agent.editorial_calendar, ufs_agent.content,
  ufs_agent.publications, ufs_agent.actions, ufs_agent.digests, ufs_agent.usage_counters
to ufs_agent_worker;
grant select, insert on ufs_agent.audit_log, ufs_agent.publication_metrics, ufs_agent.external_notes to ufs_agent_worker;
-- Retention purge of old audit rows and metrics (trigger still enforces the floor).
grant delete on ufs_agent.audit_log, ufs_agent.publication_metrics to ufs_agent_worker;
grant execute on function ufs_agent.forum_items_since(timestamptz,uuid,integer), ufs_agent.is_active_moderator(uuid) to ufs_agent_worker;
-- No DELETE on events/cases/drafts/actions/publications: retention redacts content in place.
