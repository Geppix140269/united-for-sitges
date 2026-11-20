-- United for Sitges Community Agent: schema for Neon (Postgres 18, Neon Auth).
-- STATUS: NOT APPLIED. Review only. Do not run against the production Neon
-- project (united-for-sitges, shiny-dream-02523490) without explicit owner
-- authorisation. Apply after neon/schema.sql (forum schema).
--
-- Design summary
-- * All agent data lives in the private schema ufs_agent. It is NOT exposed by
--   the Neon Data API and the Data API roles (anonymous, authenticated) get no
--   USAGE, so no browser session can reach it. RLS is also enabled and forced
--   on every table (defence in depth) with policies only for the worker role.
-- * The backend (Cloudflare Worker) connects as ufs_agent_worker (NOLOGIN
--   here; the owner enables LOGIN with a strong password out of band, never
--   committed). It is not a superuser, does not bypass RLS and cannot read
--   neon_auth or write forum tables.
-- * Existing forum tables, policies and grants (neon/schema.sql) are NOT
--   modified. The worker reads forum items only through one SECURITY DEFINER
--   function returning the minimum columns needed for moderation triage.
-- * Exactly-once business rules are enforced with unique constraints
--   (events, actions, publications per channel/local date/slot, digests).
-- * No column stores access tokens. Channels hold a credential_ref naming a
--   server-side secret (for example env:META_PAGE_ACCESS_TOKEN).

create schema if not exists ufs_agent;
revoke all on schema ufs_agent from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anonymous') then
    execute 'revoke all on schema ufs_agent from anonymous';
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on schema ufs_agent from authenticated';
  end if;
  if not exists (select 1 from pg_roles where rolname='ufs_agent_worker') then
    create role ufs_agent_worker nologin noinherit nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
grant usage on schema ufs_agent to ufs_agent_worker;

-- Prevent default privileges from leaking future objects to other roles.
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
 ('retention', jsonb_build_object('event_content_days',90,'audit_days',730,'metrics_days',400,
    'identifier_days',400,'suppression_days',400,'digest_days',90,'external_note_days',365,'batch_size',200));

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
  -- The only permitted text change is a one-time privacy redaction to the
  -- fixed marker (see ufs_agent.redact_events); fingerprints never change, so
  -- the accountability record of what was approved is kept as a hash.
  if new.proposed_answer is distinct from old.proposed_answer
     and new.proposed_answer = '[redacted]' and old.redacted_at is null and new.redacted_at is not null
     and new.content_fingerprint is not distinct from old.content_fingerprint
     and new.case_id is not distinct from old.case_id then
    return new;
  end if;
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
declare
  k text;
  v jsonb;
begin
  if tg_op='UPDATE' then
    -- Single narrow exception: a one-time privacy redaction of `detail` in
    -- which every existing value is either unchanged or replaced by the
    -- marker "[redacted]", no key is removed or invented, and a `_redaction`
    -- stamp is added. Every other column must be identical.
    if old.detail ? '_redaction' or not (new.detail ? '_redaction')
       or new.id is distinct from old.id or new.at is distinct from old.at
       or new.actor_type is distinct from old.actor_type or new.actor_id is distinct from old.actor_id
       or new.action is distinct from old.action or new.entity_type is distinct from old.entity_type
       or new.entity_id is distinct from old.entity_id then
      raise exception 'audit_log is append-only';
    end if;
    for k, v in select * from jsonb_each(old.detail) loop
      if not (new.detail ? k) or (new.detail -> k <> v and new.detail -> k <> to_jsonb('[redacted]'::text)) then
        raise exception 'audit_log is append-only';
      end if;
    end loop;
    for k in select jsonb_object_keys(new.detail) loop
      if k <> '_redaction' and not (old.detail ? k) then
        raise exception 'audit_log is append-only';
      end if;
    end loop;
    return new;
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
-- Neon Auth session JWT; never from token metadata). The account must also be
-- email-verified and not banned in neon_auth.
create function ufs_agent.is_active_moderator(uid uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.ufs_profiles p
    join neon_auth."user" u on u.id = p.user_id
    where p.user_id = uid and p.is_moderator and not p.is_suspended
      and u."emailVerified" = true and coalesce(u.banned, false) = false);
$$;
revoke all on function ufs_agent.is_active_moderator(uuid) from public;

-- ---------------------------------------------------------------------------
-- Personal data: erasure requests, redaction of every derived copy,
-- suppression of re-ingestion, retention (issue #5).
-- Data map: docs/COMMUNITY_AGENT_DATA_MAP.md
-- ---------------------------------------------------------------------------
alter table ufs_agent.events
  add column derived_redacted_at timestamptz,
  add column redaction_reason text check (redaction_reason is null or redaction_reason in ('data_subject_request','retention')),
  add column identifiers_purged_at timestamptz;
alter table ufs_agent.cases add column redacted_at timestamptz;
alter table ufs_agent.drafts add column redacted_at timestamptz;
alter table ufs_agent.actions add column redacted_at timestamptz;
alter table ufs_agent.digests add column redacted_at timestamptz;
create index events_retention_idx on ufs_agent.events(received_at) where derived_redacted_at is null;

-- Accountability record of a request. No free text and no identifiers of the
-- person: only internal ids, a reason code, counts and timestamps.
create table ufs_agent.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'erasure' check (kind in ('erasure')),
  scope text not null check (scope in ('item','author')),
  seed_event_id uuid references ufs_agent.events(id) on delete set null,
  suppress_future boolean not null default false,
  reason_code text not null check (reason_code in ('data_subject_request','objection','legal_request','moderator_decision')),
  requested_by uuid not null,
  status text not null default 'pending' check (status in ('pending','completed','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or length(last_error) <= 80),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index privacy_requests_status_idx on ufs_agent.privacy_requests(status, created_at);

-- Identifiers that must not be stored again (an edited or redelivered
-- comment would otherwise bring the erased text back). Kept for
-- retention.suppression_days, then deleted by the retention job.
create table ufs_agent.privacy_suppressions (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references ufs_agent.channels(id) on delete cascade,
  kind text not null check (kind in ('object','author')),
  value text not null check (length(value) between 1 and 128),
  request_id uuid references ufs_agent.privacy_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (channel_id, kind, value)
);

-- Audit details that stay readable after redaction: structural, non-personal.
create function ufs_agent.redacted_detail(d jsonb, p_request uuid, p_reason text) returns jsonb
language sql immutable set search_path='' as $$
  select coalesce((
    select jsonb_object_agg(e.key,
      case when e.key = any(array['case_id','action_id','fingerprint','validation','category','risk','model_note','signals',
                                  'status','error','attempt','reasons','actor','outcome','external_result_id','valid'])
                or e.value = 'null'::jsonb
           then e.value else to_jsonb('[redacted]'::text) end)
    from jsonb_each(d) e), '{}'::jsonb)
  || jsonb_build_object('_redaction', jsonb_build_object('request_id', p_request, 'reason', p_reason, 'at', now()));
$$;

-- Redacts every local copy derived from the given events in ONE transaction
-- (the caller's). Idempotent: already-redacted rows are skipped. Returns counts.
create function ufs_agent.redact_events(p_event_ids uuid[], p_reason text, p_request uuid default null)
returns jsonb language plpgsql set search_path='' as $$
declare
  v_events uuid[];
  v_cases uuid[];
  v_drafts uuid[];
  v_actions uuid[];
  v_summaries text[];
  s text;
  n_actions_cancelled integer := 0;
  n_actions integer := 0;
  n_drafts integer := 0;
  n_cases integer := 0;
  n_events integer := 0;
  n_audit integer := 0;
  n_digests integer := 0;
  n integer;
begin
  if p_reason not in ('data_subject_request','retention') then
    raise exception 'invalid redaction reason';
  end if;
  select coalesce(array_agg(id), '{}') into v_events from ufs_agent.events where id = any(p_event_ids);
  select coalesce(array_agg(id), '{}') into v_cases from ufs_agent.cases where event_id = any(v_events);
  select coalesce(array_agg(summary), '{}') into v_summaries from ufs_agent.cases
    where id = any(v_cases) and redacted_at is null and length(summary) >= 12;
  select coalesce(array_agg(id), '{}') into v_drafts from ufs_agent.drafts where case_id = any(v_cases);
  select coalesce(array_agg(a.id), '{}') into v_actions from ufs_agent.actions a
    where a.case_id = any(v_cases) or a.draft_id = any(v_drafts)
       or exists (select 1 from ufs_agent.events e where e.id = any(v_events)
                  and e.channel_id = a.target_channel_id and e.external_object_id = a.external_target_id);

  -- 1. Stop anything outbound that is still pending or in flight.
  update ufs_agent.actions set execution_status = 'cancelled', status_reason = 'privacy_redaction',
         lease_owner = null, lease_expires_at = null, updated_at = now()
   where id = any(v_actions) and execution_status in ('pending','executing','blocked','failed');
  get diagnostics n_actions_cancelled = row_count;
  update ufs_agent.actions set payload_text = '[redacted]', redacted_at = now(), updated_at = now()
   where id = any(v_actions) and redacted_at is null;
  get diagnostics n_actions = row_count;

  -- 2. Drafts: text replaced, approvals can no longer be used.
  update ufs_agent.drafts set proposed_answer = '[redacted]', source_references = '[]'::jsonb, validation_notes = '[]'::jsonb,
         status = case when status in ('proposed','approved') then 'rejected' else status end, redacted_at = now()
   where id = any(v_drafts) and redacted_at is null;
  get diagnostics n_drafts = row_count;

  -- 3. Cases: summary removed; open work closed.
  update ufs_agent.cases set summary = '[redacted]', redacted_at = now(), updated_at = now(),
         status = case when status in ('open','awaiting_approval','escalated') then 'dismissed' else status end
   where id = any(v_cases) and redacted_at is null;
  get diagnostics n_cases = row_count;

  -- 4. Events: text, author reference and link removed; never processed again.
  update ufs_agent.events set content_excerpt = null, author_ref = null, permalink = null,
         content_purged_at = coalesce(content_purged_at, now()), derived_redacted_at = now(), redaction_reason = p_reason,
         processing_status = case when processing_status in ('pending','processing','failed') then 'ignored' else processing_status end,
         lease_owner = null, lease_expires_at = null
   where id = any(v_events) and derived_redacted_at is null;
  get diagnostics n_events = row_count;

  -- 5. Audit details for the affected entities (scoped, trigger-checked).
  update ufs_agent.audit_log a set detail = ufs_agent.redacted_detail(a.detail, p_request, p_reason)
   where not (a.detail ? '_redaction')
     and ((a.entity_type = 'event' and a.entity_id = any(v_events::text[]))
       or (a.entity_type = 'case' and a.entity_id = any(v_cases::text[]))
       or (a.entity_type = 'draft' and a.entity_id = any(v_drafts::text[]))
       or (a.entity_type = 'action' and a.entity_id = any(v_actions::text[]))
       or (a.detail ->> 'case_id') = any(v_cases::text[]));
  get diagnostics n_audit = row_count;

  -- 6. Administrative emails stored locally: remove the case summaries.
  foreach s in array v_summaries loop
    update ufs_agent.digests
       set body_text = replace(body_text, left(s, 160), '[redacted]'),
           content_hash = encode(sha256(convert_to(replace(body_text, left(s, 160), '[redacted]'), 'UTF8')), 'hex'),
           redacted_at = now()
     where body_text is not null and strpos(body_text, left(s, 160)) > 0;
    get diagnostics n = row_count;
    n_digests := n_digests + n;
  end loop;

  return jsonb_build_object('events', n_events, 'cases', n_cases, 'drafts', n_drafts, 'actions', n_actions,
    'actions_cancelled', n_actions_cancelled, 'audit_entries', n_audit, 'digests', n_digests);
end $$;

-- Processes one erasure request atomically. Safe to call again: a completed
-- request returns its stored result; a failed one can be retried.
create function ufs_agent.process_privacy_request(p_id uuid)
returns jsonb language plpgsql set search_path='' as $$
declare
  r ufs_agent.privacy_requests%rowtype;
  v_author text;
  v_channel uuid;
  v_events uuid[];
  v_days integer;
  v_counts jsonb;
  n_supp integer := 0;
  n integer;
begin
  select * into r from ufs_agent.privacy_requests where id = p_id for update;
  if not found then raise exception 'privacy request not found'; end if;
  if r.status = 'completed' then return r.result; end if;
  select author_ref, channel_id into v_author, v_channel from ufs_agent.events where id = r.seed_event_id;
  if r.scope = 'author' and v_author is not null then
    select coalesce(array_agg(id), '{}') into v_events from ufs_agent.events
     where author_ref = v_author and channel_id = v_channel;
  else
    v_events := array_remove(array[r.seed_event_id], null);
  end if;
  select coalesce((value ->> 'suppression_days')::int, 400) into v_days from ufs_agent.settings where key = 'retention';

  -- Suppress re-ingestion of the same comments (edits, redeliveries).
  insert into ufs_agent.privacy_suppressions(channel_id, kind, value, request_id, expires_at)
  select e.channel_id, 'object', e.external_object_id, r.id, now() + make_interval(days => v_days)
    from ufs_agent.events e where e.id = any(v_events) and e.external_object_id not like 'purged:%'
  on conflict (channel_id, kind, value) do update set expires_at = greatest(ufs_agent.privacy_suppressions.expires_at, excluded.expires_at);
  get diagnostics n_supp = row_count;
  if r.suppress_future and v_author is not null then
    insert into ufs_agent.privacy_suppressions(channel_id, kind, value, request_id, expires_at)
    values (v_channel, 'author', v_author, r.id, now() + make_interval(days => v_days))
    on conflict (channel_id, kind, value) do update set expires_at = greatest(ufs_agent.privacy_suppressions.expires_at, excluded.expires_at);
    get diagnostics n = row_count;
    n_supp := n_supp + n;
  end if;

  v_counts := ufs_agent.redact_events(v_events, 'data_subject_request', r.id)
              || jsonb_build_object('matched_events', coalesce(array_length(v_events, 1), 0), 'suppressions', n_supp);
  update ufs_agent.privacy_requests
     set status = 'completed', attempts = attempts + 1, last_error = null, result = v_counts, completed_at = now()
   where id = r.id;
  insert into ufs_agent.audit_log(actor_type, actor_id, action, entity_type, entity_id, detail)
  values ('system', null, 'privacy_request_completed', 'privacy_request', r.id::text, v_counts);
  return v_counts;
end $$;

-- ---------------------------------------------------------------------------
-- RLS on every table, worker-only policies, explicit least-privilege grants.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['settings','channels','events','cases','faq','drafts','sources','editorial_calendar',
    'content','publications','publication_metrics','actions','audit_log','usage_counters','digests','external_notes',
    'privacy_requests','privacy_suppressions']
  loop
    execute format('alter table ufs_agent.%I enable row level security', t);
    execute format('alter table ufs_agent.%I force row level security', t);
    execute format('revoke all on ufs_agent.%I from public', t);
    if exists (select 1 from pg_roles where rolname='anonymous') then
      execute format('revoke all on ufs_agent.%I from anonymous, authenticated', t);
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
-- Privacy: requests, suppressions, scoped audit redaction (trigger-checked),
-- retention of moderator notes.
grant select, insert, update on ufs_agent.privacy_requests to ufs_agent_worker;
grant select, insert, update, delete on ufs_agent.privacy_suppressions to ufs_agent_worker;
grant update (detail) on ufs_agent.audit_log to ufs_agent_worker;
grant update (summary) on ufs_agent.external_notes to ufs_agent_worker;
grant execute on function ufs_agent.redacted_detail(jsonb,uuid,text), ufs_agent.redact_events(uuid[],text,uuid),
  ufs_agent.process_privacy_request(uuid) to ufs_agent_worker;
-- Retention purge of old audit rows and metrics (trigger still enforces the floor).
grant delete on ufs_agent.audit_log, ufs_agent.publication_metrics to ufs_agent_worker;
grant execute on function ufs_agent.forum_items_since(timestamptz,uuid,integer), ufs_agent.is_active_moderator(uuid) to ufs_agent_worker;
-- No DELETE on events/cases/drafts/actions/publications: retention redacts content in place.
revoke all on function ufs_agent.redacted_detail(jsonb,uuid,text), ufs_agent.redact_events(uuid[],text,uuid), ufs_agent.process_privacy_request(uuid) from public;
