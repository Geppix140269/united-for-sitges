// Protected moderator API. Every request: verified Supabase Auth token +
// active moderator in ufs_profiles. Every write is validated server-side and
// written to the audit log with the moderator id and exact content.

import { requireModerator, AuthError } from '../auth.js';
import { getSettings, setSetting, audit } from '../db.js';
import { textFingerprint, contentFingerprint } from '../crypto.js';
import { insertDraft, validateDraftText } from '../moderation.js';
import { runContentGates } from '../editorial/validate.js';
import { storeContentAndSchedule, slotTime, recentContent } from '../editorial/generate.js';
import { loadTopicBank } from '../editorial/calendar.js';
import { buildDailyDigest } from '../digest.js';
import { zonedTimeToUtc, localDateString, isValidTimeZone } from '../time.js';
import { EDITORIAL_CATEGORIES, LANGUAGES, env, liveSwitches } from '../config.js';
import { json, readRawBody, BodyTooLarge } from '../http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FP = /^[a-f0-9]{64}$/;

class BadRequest extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function need(cond, code) {
  if (!cond) throw new BadRequest(code);
}
function uuid(v, name) {
  need(typeof v === 'string' && UUID.test(v), `invalid_${name}`);
  return v;
}
function str(v, name, min, max) {
  need(typeof v === 'string' && v.trim().length >= min && v.length <= max, `invalid_${name}`);
  return v.trim();
}

// ----------------------------------------------------------------- views
const VIEWS = {
  async overview(db) {
    const settings = await getSettings(db);
    const counts = await db.one(`select
      (select count(*)::int from ufs_agent.events where received_at > now() - interval '24 hours') as events_24h,
      (select count(*)::int from ufs_agent.cases where status in ('open','awaiting_approval','escalated')) as awaiting,
      (select count(*)::int from ufs_agent.cases where status in ('open','awaiting_approval','escalated') and risk_level in ('high','critical')) as urgent,
      (select count(*)::int from ufs_agent.events where processing_status in ('failed','dead')) as failed_events,
      (select count(*)::int from ufs_agent.actions where execution_status in ('failed','unknown')) as failed_actions,
      (select count(*)::int from ufs_agent.publications where publication_status in ('failed','unknown')) as failed_publications`);
    const usage = await db.query("select metric, count from ufs_agent.usage_counters where day = (now() at time zone 'utc')::date order by metric");
    const today = localDateString(new Date(), settings.publishing?.timezone || 'Europe/Madrid');
    const schedule = await db.query(
      `select p.id, p.scheduled_slot, p.scheduled_at, p.publication_status, p.status_reason, p.provider_post_url, ch.account_label, ch.provider
       from ufs_agent.publications p join ufs_agent.channels ch on ch.id=p.channel_id where p.scheduled_local_date=$1 order by p.scheduled_at`, [today],
    );
    return { settings, counts, usage, today, schedule, live_switches: liveSwitches(), allow: { supervised: env('AGENT_ALLOW_SUPERVISED') === 'true', autonomous: env('AGENT_ALLOW_AUTONOMOUS') === 'true' } };
  },
  async channels(db) {
    return { channels: await db.query(`select id, provider, external_account_id, account_label, connection_status, capabilities - 'forum_cursor' as capabilities,
      credential_ref, ingest_enabled, auto_reply_enabled, publishing_enabled, paused, language_preference, max_posts_per_day, token_status,
      token_checked_at, permissions_verified, updated_at from ufs_agent.channels order by provider, account_label`) };
  },
  async cases(db, q) {
    const status = q.get('status');
    const rows = await db.query(
      `select c.id, c.category, c.risk_level, c.priority, c.summary, c.status, c.created_at, ch.provider, ch.account_label
       from ufs_agent.cases c join ufs_agent.events e on e.id=c.event_id join ufs_agent.channels ch on ch.id=e.channel_id
       where ($1::text is null or c.status=$1) order by c.priority, c.created_at desc limit 200`, [status || null],
    );
    return { cases: rows };
  },
  async case(db, q) {
    const id = uuid(q.get('id'), 'id');
    const c = await db.one(
      `select c.*, e.content_excerpt, e.permalink, e.event_type, e.external_object_id, e.received_at, e.content_purged_at, ch.provider, ch.account_label
       from ufs_agent.cases c join ufs_agent.events e on e.id=c.event_id join ufs_agent.channels ch on ch.id=e.channel_id where c.id=$1`, [id],
    );
    if (!c) throw new BadRequest('not_found', 404);
    const drafts = await db.query('select * from ufs_agent.drafts where case_id=$1 order by version desc', [id]);
    const actions = await db.query('select id, actor_type, execution_status, status_reason, external_result_id, executed_at, error_code, created_at from ufs_agent.actions where case_id=$1 order by created_at desc', [id]);
    const history = await db.query("select at, actor_type, actor_id, action, detail from ufs_agent.audit_log where (entity_type='case' and entity_id=$1) or (entity_type='draft' and entity_id = any(select id::text from ufs_agent.drafts where case_id=$2)) order by at desc limit 100", [id, id]);
    return { case: c, drafts, actions, history };
  },
  async events(db) {
    return { events: await db.query(`select e.id, e.event_type, e.processing_status, e.attempt_count, e.last_error_code, e.received_at, e.processed_at, ch.provider
      from ufs_agent.events e join ufs_agent.channels ch on ch.id=e.channel_id order by e.received_at desc limit 200`) };
  },
  async faq(db) {
    return { faq: await db.query('select * from ufs_agent.faq order by slug') };
  },
  async sources(db) {
    return { sources: await db.query('select * from ufs_agent.sources order by source_class, slug') };
  },
  async calendar(db) {
    const rows = await db.query(
      `select ec.*, (select row_to_json(c) from (select id, revision, publishability, factual_verification_status, neutrality_validation_status,
           duplication_status, gate_results, source_references, canonical_content, origin, content_hash, approved_by, approved_at from ufs_agent.content
           where editorial_calendar_id=ec.id and not superseded order by revision desc limit 1) c) as content
       from ufs_agent.editorial_calendar ec where ec.planned_date >= current_date - 7 order by ec.planned_date, ec.planned_slot limit 120`,
    );
    return { calendar: rows, categories: EDITORIAL_CATEGORIES };
  },
  async publications(db) {
    return { publications: await db.query(
      `select p.id, p.scheduled_local_date, p.scheduled_slot, p.scheduled_at, p.publication_status, p.status_reason, p.provider_post_url,
         p.attempt_count, p.error_code, p.platform_text, p.media_reference, ch.provider, ch.account_label,
         (select row_to_json(m) from (select impressions, reactions, comments, shares, clicks, metrics_available, unavailable_reason, collected_at
            from ufs_agent.publication_metrics where publication_id=p.id order by collected_at desc limit 1) m) as metrics
       from ufs_agent.publications p join ufs_agent.channels ch on ch.id=p.channel_id order by p.scheduled_at desc limit 200`) };
  },
  async failures(db) {
    return {
      events: await db.query("select id, event_type, processing_status, attempt_count, last_error_code, received_at from ufs_agent.events where processing_status in ('failed','dead') order by received_at desc limit 100"),
      actions: await db.query("select id, case_id, execution_status, status_reason, error_code, attempt_count, updated_at from ufs_agent.actions where execution_status in ('failed','unknown','blocked') order by updated_at desc limit 100"),
      publications: await db.query("select id, scheduled_local_date, scheduled_slot, publication_status, status_reason, error_code, attempt_count from ufs_agent.publications where publication_status in ('failed','unknown','expired','needs_review') order by updated_at desc limit 100"),
    };
  },
  async audit(db) {
    return { audit: await db.query('select id, at, actor_type, actor_id, action, entity_type, entity_id, detail from ufs_agent.audit_log order by at desc limit 300') };
  },
  async digests(db) {
    return { digests: await db.query('select id, kind, period_key, status, subject, body_text, generated_at, sent_at, error_code from ufs_agent.digests order by generated_at desc limit 30') };
  },
  async digest_preview(db) {
    const settings = await getSettings(db);
    const tz = settings.publishing?.timezone || 'Europe/Madrid';
    return buildDailyDigest(db, { periodDate: localDateString(new Date(), tz), settings, tz });
  },
  async external_notes(db) {
    return { notes: await db.query('select * from ufs_agent.external_notes order by created_at desc limit 200') };
  },
};

// --------------------------------------------------------------- actions
const ACTIONS = {
  async set_emergency_stop(db, me, b) {
    need(typeof b.active === 'boolean', 'invalid_active');
    const reason = b.active ? str(b.reason || 'manual stop', 'reason', 3, 300) : null;
    return setSetting(db, 'emergency_stop', { active: b.active, reason, by: me.id, at: new Date().toISOString() }, me.id);
  },

  async set_moderation_mode(db, me, b) {
    need(['DISABLED', 'SHADOW', 'SUPERVISED'].includes(b.mode), 'invalid_mode');
    const cur = (await getSettings(db)).moderation;
    if (b.mode === 'SUPERVISED') {
      need(env('AGENT_ALLOW_SUPERVISED') === 'true', 'supervised_not_authorised_for_this_deployment');
      need(b.confirm === 'ENABLE SUPERVISED MODERATION', 'confirmation_required');
    }
    const autoReply = b.auto_reply_enabled === true && b.mode === 'SUPERVISED';
    return setSetting(db, 'moderation', { ...cur, mode: b.mode, auto_reply_enabled: autoReply }, me.id);
  },

  async set_publishing(db, me, b) {
    const cur = (await getSettings(db)).publishing;
    const next = { ...cur };
    if (b.mode !== undefined) {
      need(['DISABLED', 'SHADOW', 'AUTONOMOUS'].includes(b.mode), 'invalid_mode');
      if (b.mode === 'AUTONOMOUS') {
        need(env('AGENT_ALLOW_AUTONOMOUS') === 'true', 'autonomous_not_authorised_for_this_deployment');
        need(b.confirm === 'ENABLE AUTONOMOUS PUBLISHING', 'confirmation_required');
      }
      next.mode = b.mode;
      next.autonomous_publishing_enabled = b.mode === 'AUTONOMOUS';
    }
    for (const k of ['morning_publish_time', 'evening_publish_time']) {
      if (b[k] !== undefined) { need(/^([01]\d|2[0-3]):[0-5]\d$/.test(b[k]), `invalid_${k}`); next[k] = b[k]; }
    }
    need(next.morning_publish_time < next.evening_publish_time, 'morning_must_precede_evening');
    if (b.timezone !== undefined) { need(isValidTimeZone(b.timezone), 'invalid_timezone'); next.timezone = b.timezone; }
    if (b.permitted_content_categories !== undefined) {
      need(Array.isArray(b.permitted_content_categories) && b.permitted_content_categories.every((c) => EDITORIAL_CATEGORIES.includes(c)), 'invalid_categories');
      next.permitted_content_categories = [...new Set(b.permitted_content_categories)];
    }
    if (b.daily_post_limit !== undefined) { need(Number.isInteger(b.daily_post_limit) && b.daily_post_limit >= 0 && b.daily_post_limit <= 2, 'invalid_daily_post_limit'); next.daily_post_limit = b.daily_post_limit; }
    if (b.duplicate_content_window_days !== undefined) { need(Number.isInteger(b.duplicate_content_window_days) && b.duplicate_content_window_days >= 1 && b.duplicate_content_window_days <= 90, 'invalid_window'); next.duplicate_content_window_days = b.duplicate_content_window_days; }
    if (b.content_generation_budget_per_day !== undefined) { need(Number.isInteger(b.content_generation_budget_per_day) && b.content_generation_budget_per_day >= 0 && b.content_generation_budget_per_day <= 20, 'invalid_budget'); next.content_generation_budget_per_day = b.content_generation_budget_per_day; }
    if (b.minimum_source_verification !== undefined) { need(/^verified_within_(\d{1,3})_days$/.test(b.minimum_source_verification), 'invalid_minimum_source_verification'); next.minimum_source_verification = b.minimum_source_verification; }
    const saved = await setSetting(db, 'publishing', next, me.id);
    // Re-time future scheduled publications when slot times change.
    if (b.morning_publish_time !== undefined || b.evening_publish_time !== undefined || b.timezone !== undefined) {
      const rows = await db.query("select id, scheduled_local_date, scheduled_slot from ufs_agent.publications where publication_status='scheduled' and scheduled_at > now()");
      for (const r of rows) {
        const d = r.scheduled_local_date instanceof Date ? r.scheduled_local_date.toISOString().slice(0, 10) : String(r.scheduled_local_date);
        const at = zonedTimeToUtc(d, slotTime({ publishing: next }, r.scheduled_slot), next.timezone);
        if (at > new Date()) await db.query('update ufs_agent.publications set scheduled_at=$2, updated_at=now() where id=$1', [r.id, at]);
      }
    }
    return saved;
  },

  async set_limits(db, me, b) {
    const cur = (await getSettings(db)).limits;
    const next = { ...cur };
    for (const [k, max] of Object.entries({ model_calls_per_day: 2000, events_per_day: 20000, external_api_ops_per_day: 5000, outbound_per_day: 200, max_attempts: 8 })) {
      if (b[k] !== undefined) { need(Number.isInteger(b[k]) && b[k] >= 0 && b[k] <= max, `invalid_${k}`); next[k] = b[k]; }
    }
    return setSetting(db, 'limits', next, me.id);
  },

  async set_digest(db, me, b) {
    const cur = (await getSettings(db)).digest;
    const next = { ...cur };
    if (b.send_enabled !== undefined) { need(typeof b.send_enabled === 'boolean', 'invalid_send_enabled'); next.send_enabled = b.send_enabled; }
    if (b.sender !== undefined) { need(/^[^<>@\s]{0,60}\s?<?[a-z0-9._-]+@notify\.unitedforsitges\.com>?$/i.test(b.sender), 'sender_must_use_verified_domain'); next.sender = b.sender; }
    return setSetting(db, 'digest', next, me.id);
  },

  async channel_update(db, me, b) {
    const id = uuid(b.id, 'id');
    const ch = await db.one('select * from ufs_agent.channels where id=$1', [id]);
    need(ch, 'not_found');
    const patch = {};
    for (const k of ['paused', 'ingest_enabled', 'auto_reply_enabled', 'publishing_enabled']) {
      if (b[k] !== undefined) { need(typeof b[k] === 'boolean', `invalid_${k}`); patch[k] = b[k]; }
    }
    if (b.language_preference !== undefined) { need(['en', 'es', 'ca', 'en+es', 'en+ca', 'en+es+ca'].includes(b.language_preference), 'invalid_language_preference'); patch.language_preference = b.language_preference; }
    if ((patch.publishing_enabled || patch.auto_reply_enabled) && ch.provider !== 'mock') {
      need(ch.connection_status === 'verified' && ch.token_status === 'valid', 'channel_not_verified');
    }
    const keys = Object.keys(patch);
    need(keys.length, 'nothing_to_update');
    await db.query(`update ufs_agent.channels set ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() where id=$1`, [id, ...keys.map((k) => patch[k])]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'channel_updated', entityType: 'channel', entityId: id, detail: patch });
    return { ok: true };
  },

  async channel_verify(db, me, b, deps) {
    const id = uuid(b.id, 'id');
    const ch = await db.one('select * from ufs_agent.channels where id=$1', [id]);
    need(ch && ch.provider !== 'forum', 'not_found');
    let result;
    try {
      result = await deps.adapterFor(ch).verifyToken();
    } catch (err) {
      result = { valid: false, error: err.code || 'verify_failed', scopes: [] };
    }
    const status = result.valid ? 'valid' : 'invalid';
    await db.query(
      `update ufs_agent.channels set token_status=$2, token_checked_at=now(), permissions_verified=$3,
         connection_status=case when $4 then 'verified' else 'token_invalid' end, updated_at=now() where id=$1`,
      [id, status, JSON.stringify(result.scopes || []), Boolean(result.valid)],
    );
    await audit(db, { actorType: 'human', actorId: me.id, action: 'channel_verified', entityType: 'channel', entityId: id, detail: { valid: Boolean(result.valid), scopes: result.scopes || [], expires_at: result.expiresAt || null, error: result.error || null } });
    return { valid: Boolean(result.valid), scopes: result.scopes || [], expires_at: result.expiresAt || null, error: result.error || null };
  },

  async draft_edit(db, me, b) {
    const caseId = uuid(b.case_id, 'case_id');
    const text = str(b.text, 'text', 1, 2000);
    need(FP.test(b.based_on_fingerprint || ''), 'based_on_fingerprint_required');
    return db.tx(async (t) => {
      const latest = await t.one("select * from ufs_agent.drafts where case_id=$1 order by version desc limit 1 for update", [caseId]);
      need(latest && latest.content_fingerprint === b.based_on_fingerprint, 'draft_changed_reload');
      const c = await t.one('select category from ufs_agent.cases where id=$1', [caseId]);
      const validation = validateDraftText(text, { sources: latest.source_references || [], category: c?.category });
      const d = await insertDraft(t, { caseId, text, origin: 'human', sourceRefs: latest.source_references || [], validation, createdBy: me.id });
      await t.query("update ufs_agent.cases set status='awaiting_approval', updated_at=now() where id=$1", [caseId]);
      await audit(t, { actorType: 'human', actorId: me.id, action: 'draft_edited', entityType: 'draft', entityId: d.id, detail: { case_id: caseId, text, fingerprint: d.content_fingerprint, validation: validation.notes } });
      return { draft: d };
    });
  },

  // Approval binds to the exact fingerprint the reviewer saw.
  async draft_approve(db, me, b) {
    const id = uuid(b.draft_id, 'draft_id');
    need(FP.test(b.fingerprint || ''), 'fingerprint_required');
    return db.tx(async (t) => {
      const d = await t.one('select * from ufs_agent.drafts where id=$1 for update', [id]);
      need(d, 'not_found');
      need(d.status === 'proposed', 'draft_not_pending');
      need(d.content_fingerprint === b.fingerprint && textFingerprint(d.proposed_answer) === b.fingerprint, 'draft_changed_reload');
      need(d.origin === 'human' || d.origin === 'faq' || d.validation_state === 'passed', 'ai_draft_failed_validation_edit_first');
      const latest = await t.one('select id from ufs_agent.drafts where case_id=$1 order by version desc limit 1', [d.case_id]);
      need(latest.id === d.id, 'newer_version_exists');
      const c = await t.one(`select c.*, e.channel_id, e.external_object_id, ch.provider from ufs_agent.cases c join ufs_agent.events e on e.id=c.event_id
        join ufs_agent.channels ch on ch.id=e.channel_id where c.id=$1 for update of c`, [d.case_id]);
      need(['facebook_page', 'instagram', 'mock'].includes(c.provider), 'channel_has_no_reply_capability');
      await t.query("update ufs_agent.drafts set status='approved', approved_by=$2, approved_at=now(), approved_fingerprint=content_fingerprint where id=$1", [id, me.id]);
      const action = await t.one(
        `insert into ufs_agent.actions(case_id, draft_id, actor_type, actor_id, action_type, target_channel_id, external_target_id, payload_text, payload_fingerprint, idempotency_key)
         values ($1,$2,'human',$3,'reply_comment',$4,$5,$6,$7,$8) on conflict (idempotency_key) do nothing returning id`,
        [c.id, d.id, me.id, c.channel_id, c.external_object_id, d.proposed_answer, d.content_fingerprint, `reply:${c.channel_id}:${c.external_object_id}:${d.content_fingerprint.slice(0, 16)}`],
      );
      await t.query("update ufs_agent.cases set status='resolved', updated_at=now() where id=$1", [c.id]);
      await audit(t, { actorType: 'human', actorId: me.id, action: 'draft_approved', entityType: 'draft', entityId: id, detail: { case_id: c.id, approved_text: d.proposed_answer, fingerprint: d.content_fingerprint, action_id: action?.id || null } });
      return { approved: true, action_id: action?.id || null };
    });
  },

  async draft_reject(db, me, b) {
    const id = uuid(b.draft_id, 'draft_id');
    const reason = str(b.reason || 'rejected', 'reason', 3, 300);
    await db.query("update ufs_agent.drafts set status='rejected' where id=$1 and status='proposed'", [id]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'draft_rejected', entityType: 'draft', entityId: id, detail: { reason } });
    return { ok: true };
  },

  async case_update(db, me, b) {
    const id = uuid(b.id, 'id');
    need(['open', 'resolved', 'dismissed', 'escalated'].includes(b.status), 'invalid_status');
    const note = b.note ? str(b.note, 'note', 1, 500) : null;
    await db.query('update ufs_agent.cases set status=$2, assigned_to=coalesce(assigned_to,$3), updated_at=now() where id=$1', [id, b.status, me.id]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'case_status_changed', entityType: 'case', entityId: id, detail: { status: b.status, note } });
    return { ok: true };
  },

  async faq_upsert(db, me, b) {
    const slug = str(b.slug, 'slug', 3, 60);
    need(/^[a-z0-9-]{3,60}$/.test(slug), 'invalid_slug');
    need(LANGUAGES.includes(b.language), 'invalid_language');
    need(Array.isArray(b.match_phrases) && b.match_phrases.length >= 1 && b.match_phrases.length <= 30 && b.match_phrases.every((p) => typeof p === 'string' && p.trim().length >= 6 && p.length <= 200), 'invalid_match_phrases');
    const answer = str(b.approved_answer, 'approved_answer', 10, 1200);
    const question = str(b.canonical_question, 'canonical_question', 5, 300);
    const isFactual = b.is_factual === true;
    const sourceUrl = b.source_url ? str(b.source_url, 'source_url', 10, 500) : null;
    if (sourceUrl) need(/^https:\/\//.test(sourceUrl), 'invalid_source_url');
    const channels = Array.isArray(b.allowed_channels) ? b.allowed_channels.filter((c) => ['facebook_page', 'instagram', 'mock'].includes(c)) : [];
    const expires = b.expires_at ? new Date(b.expires_at) : null;
    if (expires) need(!Number.isNaN(expires.getTime()) && expires > new Date(), 'invalid_expires_at');
    const row = await db.one(
      `insert into ufs_agent.faq(slug, canonical_question, match_phrases, approved_answer, language, source_url, is_factual, allowed_channels, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (slug) do update set canonical_question=excluded.canonical_question, match_phrases=excluded.match_phrases,
         approved_answer=excluded.approved_answer, language=excluded.language, source_url=excluded.source_url, is_factual=excluded.is_factual,
         allowed_channels=excluded.allowed_channels, expires_at=excluded.expires_at
       returning *`,
      [slug, question, b.match_phrases.map((p) => p.trim()), answer, b.language, sourceUrl, isFactual, channels, expires],
    );
    await audit(db, { actorType: 'human', actorId: me.id, action: 'faq_saved', entityType: 'faq', entityId: row.id, detail: { slug, answer, active: row.active } });
    return { faq: row };
  },

  async faq_approve(db, me, b) {
    const id = uuid(b.id, 'id');
    need(FP.test(b.fingerprint || ''), 'fingerprint_required');
    return db.tx(async (t) => {
      const f = await t.one('select * from ufs_agent.faq where id=$1 for update', [id]);
      need(f, 'not_found');
      need(textFingerprint(f.approved_answer) === b.fingerprint, 'faq_changed_reload');
      need(f.expires_at && new Date(f.expires_at) > new Date(), 'expiry_required');
      need((f.allowed_channels || []).length > 0, 'allowed_channels_required');
      if (f.is_factual) {
        const verifiedAt = b.source_verified_at ? new Date(b.source_verified_at) : null;
        need(f.source_url && verifiedAt && !Number.isNaN(verifiedAt.getTime()) && verifiedAt <= new Date(), 'source_verification_required');
        await t.query('update ufs_agent.faq set source_verified_at=$2 where id=$1', [id, verifiedAt]);
      }
      const row = await t.one(
        `update ufs_agent.faq set active=true, approved_by=$2, approved_at=now(), answer_fingerprint=$3 where id=$1 returning *`,
        [id, me.id, b.fingerprint],
      );
      await audit(t, { actorType: 'human', actorId: me.id, action: 'faq_approved', entityType: 'faq', entityId: id, detail: { slug: f.slug, approved_text: f.approved_answer, fingerprint: b.fingerprint, expires_at: f.expires_at } });
      return { faq: row };
    });
  },

  async faq_deactivate(db, me, b) {
    const id = uuid(b.id, 'id');
    await db.query('update ufs_agent.faq set active=false where id=$1', [id]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'faq_deactivated', entityType: 'faq', entityId: id });
    return { ok: true };
  },

  async source_verify(db, me, b) {
    const id = uuid(b.id, 'id');
    need(b.confirm === 'I OPENED AND CHECKED THIS URL', 'confirmation_required');
    const reviewDays = Number.isInteger(b.review_in_days) ? Math.min(Math.max(b.review_in_days, 7), 180) : 90;
    const row = await db.one(
      `update ufs_agent.sources set active=true, verified_by=$2, verified_at=now(), review_by=now() + make_interval(days => $3), updated_at=now()
       where id=$1 returning slug, url`, [id, me.id, reviewDays],
    );
    need(row, 'not_found');
    await audit(db, { actorType: 'human', actorId: me.id, action: 'source_verified', entityType: 'source', entityId: id, detail: row });
    return { ok: true };
  },

  async source_deactivate(db, me, b) {
    const id = uuid(b.id, 'id');
    await db.query('update ufs_agent.sources set active=false, updated_at=now() where id=$1', [id]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'source_deactivated', entityType: 'source', entityId: id });
    return { ok: true };
  },

  async calendar_cancel(db, me, b) {
    const id = uuid(b.id, 'id');
    await db.tx(async (t) => {
      await t.query("update ufs_agent.editorial_calendar set status='cancelled', status_reason='cancelled_by_moderator', updated_at=now() where id=$1", [id]);
      await t.query(`update ufs_agent.publications set publication_status='cancelled', status_reason='cancelled_by_moderator', updated_at=now()
        where content_id in (select id from ufs_agent.content where editorial_calendar_id=$1) and publication_status in ('scheduled','needs_review')`, [id]);
      await audit(t, { actorType: 'human', actorId: me.id, action: 'calendar_cancelled', entityType: 'editorial_calendar', entityId: id });
    });
    return { ok: true };
  },

  // Only a moderator may attest that a factual post was read against all
  // original sources. A copied excerpt alone cannot validate its meaning.
  async content_approve(db, me, b) {
    const id = uuid(b.content_id, 'content_id');
    need(FP.test(b.content_hash || ''), 'content_hash_required');
    need(b.confirm === 'I VERIFIED ALL FACTUAL CLAIMS AGAINST THE SOURCES', 'source_review_confirmation_required');
    return db.tx(async (t) => {
      const c = await t.one('select * from ufs_agent.content where id=$1 for update', [id]);
      need(c && !c.superseded, 'content_not_current');
      need(c.content_hash === b.content_hash && contentFingerprint(c.canonical_content) === b.content_hash, 'content_changed_reload');
      need(c.publishability === 'publishable' && c.factual_verification_status === 'passed'
        && c.neutrality_validation_status === 'passed' && c.duplication_status === 'unique', 'content_not_eligible');
      need(Array.isArray(c.gate_results) && c.gate_results.every((g) => g.severity !== 'hard' || g.result === 'pass'), 'hard_gate_failed');
      need(Array.isArray(c.source_references) && c.source_references.length > 0, 'source_required');
      const cal = await t.one('select * from ufs_agent.editorial_calendar where id=$1', [c.editorial_calendar_id]);
      need(cal && !['cancelled', 'published', 'skipped'].includes(cal.status), 'slot_not_editable');
      need(cal.source_requirements?.factual === true, 'not_factual_slot');
      const slugs = c.source_references.map((ref) => ref.slug);
      const sources = await t.query('select slug, active, verified_at, review_by from ufs_agent.sources where slug = any($1::text[])', [slugs]);
      const now = new Date();
      need(slugs.every((slug) => sources.some((src) => src.slug === slug && src.active && src.verified_at
        && now - new Date(src.verified_at) < 90 * 86400000 && (!src.review_by || new Date(src.review_by) >= now))), 'source_verification_stale');
      await t.query('update ufs_agent.content set approved_by=$2, approved_at=now() where id=$1', [id, me.id]);
      await t.query(
        `update ufs_agent.publications set publication_status='scheduled', status_reason='source_review_approved', next_attempt_at=null, updated_at=now()
         where content_id=$1 and publication_status='needs_review' and scheduled_at > now() - interval '45 minutes'`,
        [id],
      );
      await audit(t, { actorType: 'human', actorId: me.id, action: 'factual_content_approved',
        entityType: 'content', entityId: id, detail: { content_hash: c.content_hash, sources: slugs } });
      return { approved: true, content_id: id };
    });
  },

  // Human-written replacement content for a future slot. It still passes the
  // same deterministic gates; a moderator approval replaces the review gate only.
  async content_replace(db, me, b, deps) {
    const id = uuid(b.calendar_id, 'calendar_id');
    const cal = await db.one('select * from ufs_agent.editorial_calendar where id=$1', [id]);
    need(cal && !['published', 'cancelled'].includes(cal.status), 'slot_not_editable');
    const settings = await getSettings(db);
    const pub = settings.publishing;
    const plannedDate = cal.planned_date instanceof Date ? cal.planned_date.toISOString().slice(0, 10) : String(cal.planned_date);
    const scheduledAt = zonedTimeToUtc(plannedDate, slotTime(settings, cal.planned_slot), pub.timezone);
    need(scheduledAt > new Date(), 'slot_in_past');
    const content = {
      title: str(b.title, 'title', 3, 120),
      body: str(b.body, 'body', 40, 1200),
      claims: [],
      discussion_question: b.discussion_question ? str(b.discussion_question, 'discussion_question', 3, 300) : '',
      facebook_text: str(b.facebook_text, 'facebook_text', 40, 2000),
      instagram_caption: str(b.instagram_caption, 'instagram_caption', 20, 1800),
      es_summary: b.es_summary ? str(b.es_summary, 'es_summary', 3, 400) : '',
      ca_summary: b.ca_summary ? str(b.ca_summary, 'ca_summary', 3, 400) : '',
      category: cal.category,
      source_urls: [],
    };
    const topic = loadTopicBank().find((t) => t.key === cal.topic_key) || { key: cal.topic_key, category: cal.category, factual: Boolean(cal.source_requirements?.factual), sources: [] };
    // Manual replacement without verified claim/excerpt mapping is not an
    // exception to the factual verification rules.
    need(!topic.factual && cal.source_requirements?.factual !== true, 'factual_replacement_requires_source_review');
    const humanTopic = { ...topic, factual: false };
    const today = localDateString(new Date(), pub.timezone);
    const recent = (await recentContent(db, { today, windowDays: pub.duplicate_content_window_days || 10 }))
      .filter((r) => r.text && r.topic_key !== cal.topic_key);
    const verdict = runContentGates(content, { topic: humanTopic, sources: [], recent, similarityThreshold: pub.duplicate_similarity_threshold, allowedHosts: ['unitedforsitges.com', 'www.unitedforsitges.com'] });
    // A moderator's explicit approval resolves 'review' gates (never hard gates).
    if (verdict.publishability === 'needs_review' && b.approve === true) verdict.publishability = 'publishable';
    const res = await storeContentAndSchedule(db, deps, { cal, content, verdict, sources: [], scheduledAt, plannedDate, origin: 'human', workerId: null, topic: humanTopic, approvedBy: b.approve === true ? me.id : null });
    return { ...res, gates: verdict.gates };
  },

  async publication_retry(db, me, b) {
    const id = uuid(b.id, 'id');
    const p = await db.one('select * from ufs_agent.publications where id=$1', [id]);
    need(p && ['failed'].includes(p.publication_status), 'not_retryable');
    need(!['token_invalid', 'permission_denied', 'unknown_outcome'].includes(p.error_code), 'fix_credentials_first');
    await db.query("update ufs_agent.publications set publication_status='scheduled', next_attempt_at=null, status_reason='manual_retry', updated_at=now() where id=$1", [id]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'publication_retry', entityType: 'publication', entityId: id });
    return { ok: true, note: 'Retried only if still inside the publication window; otherwise it will expire.' };
  },

  async publication_mark_reconciled(db, me, b) {
    const id = uuid(b.id, 'id');
    need(['published', 'not_published'].includes(b.outcome), 'invalid_outcome');
    const url = b.outcome === 'published' ? str(b.url, 'url', 10, 500) : null;
    if (url) need(/^https:\/\//.test(url), 'invalid_url');
    await db.query(`update ufs_agent.publications set publication_status=$2, provider_post_url=coalesce($3, provider_post_url), status_reason='reconciled_by_moderator', updated_at=now()
      where id=$1 and publication_status='unknown'`, [id, b.outcome === 'published' ? 'published' : 'failed', url]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'publication_reconciled_manually', entityType: 'publication', entityId: id, detail: { outcome: b.outcome, url } });
    return { ok: true };
  },

  async publication_cancel(db, me, b) {
    const id = uuid(b.id, 'id');
    await db.query("update ufs_agent.publications set publication_status='cancelled', status_reason='cancelled_by_moderator', updated_at=now() where id=$1 and publication_status in ('scheduled','needs_review','failed')", [id]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'publication_cancelled', entityType: 'publication', entityId: id });
    return { ok: true };
  },

  async action_requeue(db, me, b) {
    const id = uuid(b.id, 'id');
    const a = await db.one('select * from ufs_agent.actions where id=$1', [id]);
    need(a && ['failed', 'blocked'].includes(a.execution_status), 'not_requeueable');
    await db.query("update ufs_agent.actions set execution_status='pending', next_attempt_at=now(), attempt_count=0, status_reason='manual_requeue', updated_at=now() where id=$1", [id]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'action_requeued', entityType: 'action', entityId: id });
    return { ok: true, note: 'All guardrails are re-checked before execution.' };
  },

  async event_requeue(db, me, b) {
    const id = uuid(b.id, 'id');
    await db.query("update ufs_agent.events set processing_status='pending', attempt_count=0, next_attempt_at=now(), last_error_code=null where id=$1 and processing_status in ('failed','dead')", [id]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'event_requeued', entityType: 'event', entityId: id });
    return { ok: true };
  },

  async external_note_create(db, me, b) {
    if (b.source_url) need(typeof b.source_url === 'string' && /^https:\/\//.test(b.source_url), 'invalid_source_url');
    const row = await db.one(
      'insert into ufs_agent.external_notes(source_label, source_url, summary, topic_category, follow_up, created_by) values ($1,$2,$3,$4,$5,$6) returning id',
      [str(b.source_label, 'source_label', 3, 160), b.source_url ? str(b.source_url, 'source_url', 10, 500) : null,
        str(b.summary, 'summary', 3, 1000), b.topic_category && EDITORIAL_CATEGORIES.includes(b.topic_category) ? b.topic_category : null,
        ['none', 'faq_candidate', 'editorial_candidate', 'escalate'].includes(b.follow_up) ? b.follow_up : 'none', me.id],
    );
    await audit(db, { actorType: 'human', actorId: me.id, action: 'external_note_created', entityType: 'external_note', entityId: row.id });
    return { id: row.id };
  },

  // Data subject request: redact stored content for a given external object.
  async redact_event_content(db, me, b) {
    const id = uuid(b.event_id, 'event_id');
    await db.query("update ufs_agent.events set content_excerpt=null, author_ref=null, permalink=null, content_purged_at=now() where id=$1", [id]);
    await db.query("update ufs_agent.cases set summary='[redacted on request]', classification = classification - 'model', updated_at=now() where event_id=$1", [id]);
    await audit(db, { actorType: 'human', actorId: me.id, action: 'event_content_redacted', entityType: 'event', entityId: id, detail: { reason: b.reason ? String(b.reason).slice(0, 200) : null } });
    return { ok: true };
  },
};

export async function handleAdmin(request, deps) {
  try {
    const db = deps.getDb();
    const me = await requireModerator(db, request, deps);
    if (request.method === 'GET') {
      const q = new URL(request.url).searchParams;
      const view = VIEWS[q.get('view') || 'overview'];
      if (!view) throw new BadRequest('unknown_view', 404);
      return json(200, await view(db, q, me));
    }
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const origin = request.headers.get('origin');
    const allowedOrigin = env('AGENT_ADMIN_ORIGIN') || 'https://unitedforsitges.com';
    if (origin && origin !== allowedOrigin) throw new BadRequest('origin_not_allowed', 403);
    let body;
    try {
      body = JSON.parse((await readRawBody(request, 32 * 1024)).toString('utf8'));
    } catch (err) {
      throw new BadRequest(err instanceof BodyTooLarge ? 'payload_too_large' : 'invalid_json', err instanceof BodyTooLarge ? 413 : 400);
    }
    const fn = body && typeof body.action === 'string' ? ACTIONS[body.action] : null;
    if (!fn) throw new BadRequest('unknown_action');
    return json(200, await fn(db, me, body, deps));
  } catch (err) {
    if (err instanceof AuthError) return json(err.status, { error: err.code });
    if (err instanceof BadRequest) return json(err.status, { error: err.code });
    if (err.code === 'unknown_setting') return json(400, { error: err.code });
    if (err.code === 'config_missing') return json(503, { error: 'not_configured' });
    console.error(JSON.stringify({ event: 'admin_error', code: err.code || 'internal', pgcode: err.code }));
    return json(500, { error: 'internal_error' });
  }
}

