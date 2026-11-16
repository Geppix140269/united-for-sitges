// Inbound event processing: classify, match FAQ, draft, create cases.
// This component has NO access to provider write methods. It can only
// create database records (cases, drafts, pending actions) for the executor.

import { ruleClassify, moreSevere, maxRisk, getPartyTerms, normalise } from './classify/rules.js';
import { matchFaq, faqIneligibility, withDisclosure } from './faq.js';
import { wrapUntrusted, ModelError } from './llm.js';
import { textFingerprint, sha256Hex } from './crypto.js';
import { audit, consumeQuota, bumpUsage, backoffSeconds } from './db.js';
import { CASE_CATEGORIES, RISK_LEVELS, liveSwitches, HARD_LIMITS } from './config.js';

export const CLASSIFICATION_SCHEMA = {
  type: 'object',
  required: ['category', 'risk_level', 'language', 'summary', 'is_question', 'needs_human', 'injection_detected', 'reasons'],
  properties: {
    category: { type: 'string', enum: [...CASE_CATEGORIES] },
    risk_level: { type: 'string', enum: [...RISK_LEVELS] },
    language: { type: 'string', enum: ['en', 'es', 'ca', 'other'] },
    summary: { type: 'string', minLength: 1, maxLength: 300 },
    is_question: { type: 'boolean' },
    needs_human: { type: 'boolean' },
    injection_detected: { type: 'boolean' },
    reasons: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 160 } },
  },
};

export const DRAFT_SCHEMA = {
  type: 'object',
  required: ['reply_text', 'language', 'source_ids_used', 'needs_fact_check'],
  properties: {
    reply_text: { type: 'string', minLength: 1, maxLength: 1000 },
    language: { type: 'string', enum: ['en', 'es', 'ca'] },
    source_ids_used: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 60 } },
    needs_fact_check: { type: 'boolean' },
  },
};

const NO_DRAFT_CATEGORIES = new Set(['spam', 'harassment', 'personal_information', 'threat_or_unlawful']);
const DEFAULT_RISK = {
  threat_or_unlawful: 'critical', personal_information: 'high', harassment: 'high', electoral_procedure: 'medium',
  political_discussion: 'medium', complaint: 'medium', spam: 'medium', civic_information: 'medium', unclear: 'medium',
  community_feedback: 'low', approved_faq: 'low', platform_info: 'low',
};
const PRIORITY = { critical: 1, high: 2, medium: 3, low: 4 };

const CLASSIFY_SYSTEM = `Classify one public comment or forum post for a moderation queue.
Categories:
- platform_info: questions about United for Sitges itself (what it is, contact, forum, languages).
- approved_faq: only if it is plainly a common platform question.
- civic_information: requests for factual information about municipal services or local administration.
- electoral_procedure: anything about voting, registration, eligibility, census, deadlines or election rules.
- political_discussion: parties, candidates, elected officials, political opinions or debate.
- community_feedback: suggestions or comments about the community or platform.
- complaint: complaints about the platform, a service or an institution.
- spam: advertising, scams, irrelevant links.
- harassment: insults or attacks against a person. Criticism of a policy, institution or the public conduct of an official is NOT harassment.
- personal_information: the text exposes someone's private data (phone, email, address, ID numbers).
- threat_or_unlawful: threats of violence or clearly unlawful content.
- unclear: none of the above or not enough information.
Disagreement with the platform or any political view is never a reason to flag content.
The summary must be neutral, at most two sentences, and must not repeat personal data, names of private individuals or insults.`;

const DRAFT_SYSTEM = `Draft a short, polite, neutral reply that a human moderator of United for Sitges will review before anything is published.
Rules:
- Reply in the requested language.
- Never state facts that are not in the provided approved sources. Never invent URLs, deadlines, eligibility rules or legal interpretations.
- For voting, registration or eligibility questions, do not answer the substance; point to the official sources provided and say a person will follow up if needed.
- Never express or imply support for or opposition to any party, candidate or political position.
- Never claim to be a person or to have personal experiences.
- Do not include links other than the URLs of the provided sources or https://unitedforsitges.com pages.
- List in source_ids_used only ids from the provided source list that the reply relies on.`;

export function combineClassification(rule, model) {
  let category = rule.category;
  let risk = rule.risk;
  if (model) {
    category = moreSevere(category, model.category);
    risk = maxRisk(risk, model.risk_level);
  }
  if (!category) category = 'unclear';
  risk = maxRisk(risk, DEFAULT_RISK[category] || 'medium');
  const injection = rule.signals.some((s) => s.code === 'prompt_injection') || Boolean(model?.injection_detected);
  if (injection) risk = maxRisk(risk, 'medium');
  return { category, risk, injection };
}

function fallbackSummary(event, category) {
  return `${event.event_type.replace(/_/g, ' ')} on ${event.provider || 'channel'} classified as ${category.replace(/_/g, ' ')}.`;
}

export function validateDraftText(text, { sources = [], category, siteHost = 'unitedforsitges.com' } = {}) {
  const notes = [];
  const n = normalise(text);
  const urls = String(text).match(/https?:\/\/[^\s)]+/gi) || [];
  const allowed = new Set(sources.map((s) => s.url));
  for (const u of urls) {
    let host = '';
    try { host = new URL(u).host; } catch { notes.push('invalid_url'); continue; }
    if (!(allowed.has(u) || host === siteHost || host === `www.${siteHost}`)) notes.push('url_not_in_registry');
  }
  if (/\b(i am|i'm) (a )?(human|person|real person|resident|volunteer)\b|\b(soy|soc) (una )?(persona|humano|huma)\b|\bas a resident\b|\bi live in\b/.test(n)) notes.push('claims_human_identity');
  const parties = getPartyTerms().filter((t) => t.length >= 3 && new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(n));
  if (parties.length) notes.push('mentions_party');
  if (/\b(vote for|vote against|support (the )?(party|candidate)|vota a|vota per|votad|don't vote|no votes)\b/.test(n)) notes.push('political_advocacy');
  if (ruleClassify(text).signals.some((s) => s.code === 'personal_information')) notes.push('contains_personal_data');
  if (/\b\d{1,2} (de )?(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|gener|febrer|marc|maig|juny|juliol|agost|setembre|octubre|novembre|desembre)\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(n)) notes.push('contains_date_check_source');
  if (category === 'electoral_procedure' && !sources.length) notes.push('electoral_without_official_source');
  return { passed: notes.length === 0, notes };
}

async function nextDraftVersion(t, caseId) {
  const row = await t.one('select coalesce(max(version),0)+1 as v from ufs_agent.drafts where case_id=$1', [caseId]);
  return Number(row.v);
}

export async function insertDraft(t, { caseId, text, origin, sourceRefs = [], validation, createdBy = null, approval = null }) {
  await t.query("update ufs_agent.drafts set status='superseded' where case_id=$1 and status in ('proposed','approved')", [caseId]);
  const version = await nextDraftVersion(t, caseId);
  const fp = textFingerprint(text);
  return t.one(
    `insert into ufs_agent.drafts(case_id, version, proposed_answer, source_references, validation_state, validation_notes, origin, status,
       content_fingerprint, approved_by, approved_at, approved_fingerprint, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [caseId, version, text, JSON.stringify(sourceRefs), validation.passed ? 'passed' : 'failed', JSON.stringify(validation.notes), origin,
      approval ? 'approved' : 'proposed', fp, approval?.by ?? null, approval?.at ?? null, approval ? fp : null, createdBy],
  );
}

// Process a single claimed event. deps: { model, now, settings, faqs, sources }
export async function processEvent(db, deps, event) {
  const { settings, now = new Date() } = deps;
  const text = event.content_excerpt || '';

  if (event.event_type === 'comment_removed') {
    await db.query(
      `update ufs_agent.actions set execution_status='cancelled', status_reason='target_removed', updated_at=now()
       where target_channel_id=$1 and external_target_id=$2 and execution_status='pending'`,
      [event.channel_id, event.external_object_id],
    );
    return { status: 'processed', outcome: 'target_removed' };
  }
  if (event.author_is_page) return { status: 'ignored', outcome: 'own_content' };
  if (!text.trim()) return { status: 'ignored', outcome: 'empty' };

  const rule = ruleClassify(text);
  let model = null;
  let modelNote = 'model_not_used';
  const modelAllowed = deps.model && liveSwitches().llm && settings?.moderation?.mode !== 'DISABLED' && !settings?.emergency_stop?.active;
  if (modelAllowed) {
    if (await consumeQuota(db, 'model_calls', Number(settings?.limits?.model_calls_per_day) || 0, 1, now)) {
      try {
        const res = await deps.model.structured({
          system: CLASSIFY_SYSTEM,
          user: `Channel: ${event.provider}. Classify this content.\n${wrapUntrusted('public_comment', text)}`,
          schema: CLASSIFICATION_SCHEMA,
          maxTokens: 1500,
          effort: 'low',
        });
        model = res.value;
        modelNote = 'model_ok';
        await bumpUsage(db, 'model_input_tokens', res.usage?.input || 0, now);
        await bumpUsage(db, 'model_output_tokens', res.usage?.output || 0, now);
      } catch (err) {
        modelNote = err instanceof ModelError ? err.code : 'model_error';
        if (err.retryable) throw Object.assign(new Error('Model temporarily unavailable'), { code: modelNote, retryable: true });
      }
    } else {
      modelNote = 'model_budget_exhausted';
    }
  }

  const combined = combineClassification(rule, model);
  const language = rule.language !== 'other' ? rule.language : (model?.language || 'other');
  const faqs = deps.faqs || [];
  let faqHit = null;
  let faqBlock = null;
  const quietRules = !rule.blocksAutomation;
  const modelAgrees = !model || (['platform_info', 'approved_faq', 'community_feedback'].includes(model.category) && model.risk_level === 'low' && !model.injection_detected);
  if (quietRules && modelAgrees && ['unclear', 'platform_info', 'approved_faq', 'community_feedback'].includes(combined.category)) {
    const m = matchFaq(text, faqs, { language });
    if (m) {
      faqBlock = faqIneligibility(m.faq, { now, channelProvider: event.provider });
      if (!faqBlock) faqHit = m;
    }
  }

  const category = faqHit ? 'approved_faq' : combined.category;
  const risk = faqHit ? 'low' : combined.risk;
  const classification = {
    rule_signals: rule.signals.map((s) => s.code),
    model: model ? { category: model.category, risk_level: model.risk_level, needs_human: model.needs_human, injection_detected: model.injection_detected } : null,
    model_note: modelNote,
    injection: combined.injection,
    faq_match: faqHit ? { slug: faqHit.faq.slug, exact: faqHit.exact } : null,
    faq_blocked_reason: faqBlock,
    language,
  };
  const summary = (model?.summary && !ruleClassify(model.summary).signals.some((s) => s.code === 'personal_information'))
    ? model.summary : fallbackSummary(event, category);

  return db.tx(async (t) => {
    const caseRow = await t.one(
      `insert into ufs_agent.cases(event_id, category, risk_level, priority, summary, status, classification, faq_id)
       values ($1,$2,$3,$4,$5,'open',$6,$7)
       on conflict (event_id) do nothing returning *`,
      [event.id, category, risk, PRIORITY[risk], summary.slice(0, 400), JSON.stringify(classification), faqHit?.faq.id ?? null],
    );
    if (!caseRow) return { status: 'processed', outcome: 'case_exists' };
    await audit(t, { actorType: model ? 'ai' : 'system', action: 'case_created', entityType: 'case', entityId: caseRow.id, detail: { category, risk, model_note: modelNote, signals: classification.rule_signals } });

    if (faqHit) {
      const answer = withDisclosure(faqHit.faq.approved_answer, faqHit.faq.language);
      const draft = await insertDraft(t, {
        caseId: caseRow.id, text: answer, origin: 'faq',
        sourceRefs: faqHit.faq.source_url ? [{ url: faqHit.faq.source_url, verified_at: faqHit.faq.source_verified_at }] : [],
        validation: { passed: true, notes: [] },
        approval: { by: faqHit.faq.approved_by, at: faqHit.faq.approved_at },
      });
      const autoEligible = settings?.moderation?.auto_reply_enabled === true && deps.channel?.auto_reply_enabled === true;
      if (autoEligible) {
        await t.query(
          `insert into ufs_agent.actions(case_id, draft_id, actor_type, actor_id, action_type, target_channel_id, external_target_id,
             payload_text, payload_fingerprint, idempotency_key)
           values ($1,$2,'system','faq-auto','reply_comment',$3,$4,$5,$6,$7) on conflict (idempotency_key) do nothing`,
          [caseRow.id, draft.id, event.channel_id, event.external_object_id, answer, draft.content_fingerprint,
            `reply:${event.channel_id}:${event.external_object_id}`],
        );
        await t.query("update ufs_agent.cases set status='auto_handled', updated_at=now() where id=$1", [caseRow.id]);
      } else {
        await t.query("update ufs_agent.cases set status='awaiting_approval', updated_at=now() where id=$1", [caseRow.id]);
      }
      return { status: 'processed', outcome: autoEligible ? 'faq_auto_queued' : 'faq_draft', caseId: caseRow.id };
    }

    if (!NO_DRAFT_CATEGORIES.has(category) && model && deps.model && !combined.injection) {
      return { status: 'processed', outcome: 'needs_draft', caseId: caseRow.id, category, language };
    }
    const status = risk === 'critical' || risk === 'high' ? 'escalated' : 'open';
    await t.query('update ufs_agent.cases set status=$2, updated_at=now() where id=$1', [caseRow.id, status]);
    return { status: 'processed', outcome: status === 'escalated' ? 'escalated' : 'human_review', caseId: caseRow.id, risk };
  });
}

// AI draft for a case (outside the classification transaction).
export async function draftForCase(db, deps, { caseId, category, language, text }) {
  const { settings, now = new Date() } = deps;
  const sources = (deps.sources || []).filter((s) => s.active && (s.categories || []).includes(category === 'electoral_procedure' ? 'electoral_resources' : 'civic_information'));
  if (!(await consumeQuota(db, 'model_calls', Number(settings?.limits?.model_calls_per_day) || 0, 1, now))) {
    await db.query("update ufs_agent.cases set status='open', updated_at=now() where id=$1", [caseId]);
    return { outcome: 'model_budget_exhausted' };
  }
  let value;
  try {
    const res = await deps.model.structured({
      system: DRAFT_SYSTEM,
      user: [
        `Reply language: ${language === 'other' ? 'en' : language}. Case category: ${category}.`,
        `Approved sources (id, title, url):\n${sources.map((s) => `- ${s.slug} | ${s.title} | ${s.url}`).join('\n') || '- none'}`,
        wrapUntrusted('public_comment', text),
      ].join('\n\n'),
      schema: DRAFT_SCHEMA,
      maxTokens: 2000,
      effort: 'low',
    });
    value = res.value;
  } catch (err) {
    await db.query("update ufs_agent.cases set status='open', updated_at=now() where id=$1", [caseId]);
    await audit(db, { actorType: 'ai', action: 'draft_failed', entityType: 'case', entityId: caseId, detail: { error: err.code || 'model_error' } });
    return { outcome: 'draft_failed' };
  }
  const used = sources.filter((s) => value.source_ids_used.includes(s.slug));
  const unknownIds = value.source_ids_used.filter((id) => !sources.some((s) => s.slug === id));
  const validation = validateDraftText(value.reply_text, { sources: used, category });
  if (unknownIds.length) validation.notes.push('unknown_source_id');
  if (value.needs_fact_check) validation.notes.push('model_requested_fact_check');
  validation.passed = validation.notes.length === 0;
  await db.tx(async (t) => {
    const d = await insertDraft(t, {
      caseId, text: value.reply_text, origin: 'ai', validation,
      sourceRefs: used.map((s) => ({ slug: s.slug, url: s.url, title: s.title, verified_at: s.verified_at })),
    });
    await t.query("update ufs_agent.cases set status='awaiting_approval', updated_at=now() where id=$1", [caseId]);
    await audit(t, { actorType: 'ai', action: 'draft_created', entityType: 'draft', entityId: d.id, detail: { case_id: caseId, validation: validation.notes } });
  });
  return { outcome: 'draft_created', validation };
}

// Queue worker: claim pending events with a lease, process, record result.
export async function processEventQueue(db, deps, { workerId, limit = 20 } = {}) {
  const now = deps.now || new Date();
  const leaseSec = HARD_LIMITS.leaseSeconds;
  const claimed = await db.tx((t) => t.query(
    `with picked as (
       select e.id from ufs_agent.events e
       where (e.processing_status='pending' and e.next_attempt_at <= $1)
          or (e.processing_status='processing' and e.lease_expires_at < $1)
       order by e.received_at asc
       limit $2 for update skip locked)
     update ufs_agent.events e set processing_status='processing', lease_owner=$3,
       lease_expires_at=$1::timestamptz + make_interval(secs => $4), attempt_count=e.attempt_count+1
     from picked where e.id=picked.id
     returning e.*`,
    [now, limit, workerId, leaseSec],
  ));
  const results = [];
  if (claimed.length) {
    deps = {
      ...deps,
      faqs: deps.faqs || await db.query('select * from ufs_agent.faq where active'),
      sources: deps.sources || await db.query('select * from ufs_agent.sources where active'),
    };
  }
  for (const event of claimed) {
    const channel = await db.one('select * from ufs_agent.channels where id=$1', [event.channel_id]);
    event.provider = channel?.provider;
    const maxAttempts = Math.min(Number(deps.settings?.limits?.max_attempts) || 5, HARD_LIMITS.maxAttempts);
    try {
      const r = await processEvent(db, { ...deps, channel }, event);
      if (r.outcome === 'needs_draft') {
        await draftForCase(db, deps, { caseId: r.caseId, category: r.category, language: r.language, text: event.content_excerpt });
      }
      await db.query(
        `update ufs_agent.events set processing_status=$2, processed_at=$3, lease_owner=null, lease_expires_at=null, last_error_code=null
         where id=$1 and lease_owner=$4`,
        [event.id, r.status, now, workerId],
      );
      results.push({ id: event.id, ...r });
    } catch (err) {
      const dead = event.attempt_count >= maxAttempts || !err.retryable;
      await db.query(
        `update ufs_agent.events set processing_status=$2, lease_owner=null, lease_expires_at=null, last_error_code=$3,
           next_attempt_at=$4::timestamptz + make_interval(secs => $5)
         where id=$1 and lease_owner=$6`,
        [event.id, dead ? 'dead' : 'pending', String(err.code || 'processing_error').slice(0, 80), now, backoffSeconds(event.attempt_count), workerId],
      );
      await audit(db, { actorType: 'system', action: dead ? 'event_dead_lettered' : 'event_retry_scheduled', entityType: 'event', entityId: event.id, detail: { error: err.code || 'processing_error', attempt: event.attempt_count } });
      if (!dead) await bumpUsage(db, 'retries', 1, now);
      results.push({ id: event.id, status: dead ? 'dead' : 'retry', error: err.code });
    }
  }
  return results;
}

// Normalised inbound events -> durable queue rows (idempotent).
export async function enqueueEvents(db, normalisedEvents, { settings, now = new Date() } = {}) {
  const out = { inserted: 0, duplicates: 0, unknownAccount: 0, overLimit: 0 };
  for (const ev of normalisedEvents) {
    const channel = await db.one(
      'select id, ingest_enabled from ufs_agent.channels where provider=$1 and external_account_id=$2',
      [ev.provider, ev.externalAccountId],
    );
    if (!channel || !channel.ingest_enabled) { out.unknownAccount += 1; continue; }
    const allowed = await consumeQuota(db, 'events', Number(settings?.limits?.events_per_day) || 0, 1, now);
    const row = await db.one(
      `insert into ufs_agent.events(channel_id, idempotency_key, external_object_id, external_parent_id, event_type,
         content_excerpt, author_ref, author_is_page, permalink, language, payload_checksum, processing_status, last_error_code)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (idempotency_key) do nothing returning id`,
      [channel.id, ev.idempotencyKey, ev.externalObjectId, ev.externalParentId, ev.eventType,
        allowed ? ev.contentExcerpt : null, ev.authorRef, ev.authorIsPage, ev.permalink || null, ev.language || null,
        ev.payloadChecksum, allowed ? 'pending' : 'ignored', allowed ? null : 'volume_limit'],
    );
    if (row) { out.inserted += 1; if (!allowed) out.overLimit += 1; } else out.duplicates += 1;
  }
  return out;
}

export function forumEventFromRow(row, pepperFn) {
  const text = [row.title, row.body].filter(Boolean).join('\n').slice(0, HARD_LIMITS.maxExcerptChars);
  const type = row.kind === 'topic' ? 'forum_topic' : row.kind === 'reply' ? 'forum_reply' : 'forum_report';
  return {
    provider: 'forum',
    eventType: type,
    externalObjectId: row.id,
    externalParentId: row.topic_id,
    contentExcerpt: text,
    authorRef: pepperFn(row.author_id),
    authorIsPage: false,
    permalink: 'https://unitedforsitges.com/community.html',
    idempotencyKey: `forum:${type}:${row.id}`,
    payloadChecksum: sha256Hex(`${row.id}:${text}`),
  };
}
