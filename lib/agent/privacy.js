// Personal-data erasure and retention (issue #5). All redaction happens in
// PostgreSQL functions (ufs_agent.redact_events, process_privacy_request) so a
// request is applied atomically: either every local copy is redacted or none
// is. Data map and limits: docs/COMMUNITY_AGENT_DATA_MAP.md.
// Local redaction never deletes anything on Facebook or Instagram.

import { audit } from './db.js';

export const REASON_CODES = Object.freeze(['data_subject_request', 'objection', 'legal_request', 'moderator_decision']);
export const MAX_ATTEMPTS = 5;

export async function createPrivacyRequest(db, { seedEventId, scope, reasonCode, suppressFuture = false, requestedBy }) {
  const row = await db.one(
    `insert into ufs_agent.privacy_requests(seed_event_id, scope, reason_code, suppress_future, requested_by)
     select e.id, $2, $3, $4, $5 from ufs_agent.events e where e.id = $1 returning id`,
    [seedEventId, scope, reasonCode, Boolean(suppressFuture), requestedBy],
  );
  if (!row) throw Object.assign(new Error('event not found'), { code: 'not_found' });
  await audit(db, { actorType: 'human', actorId: requestedBy, action: 'privacy_request_created', entityType: 'privacy_request', entityId: row.id, detail: { scope, reason: reasonCode, suppress_future: Boolean(suppressFuture) } });
  return row.id;
}

// Runs one request in its own transaction. On failure nothing is redacted
// (rollback) and the request is marked failed for a later retry.
export async function processPrivacyRequest(db, id) {
  try {
    const result = await db.tx((t) => t.one('select ufs_agent.process_privacy_request($1::uuid) as r', [id]));
    return { id, status: 'completed', result: result.r };
  } catch (err) {
    const code = String(err.code || 'redaction_failed').slice(0, 80);
    await db.query(
      `update ufs_agent.privacy_requests set status='failed', attempts=attempts+1, last_error=$2 where id=$1 and status <> 'completed'`,
      [id, code],
    );
    await audit(db, { actorType: 'system', action: 'privacy_request_failed', entityType: 'privacy_request', entityId: id, detail: { error: code } }).catch(() => {});
    return { id, status: 'failed', error: code };
  }
}

// Scheduler job: retries pending or failed requests, bounded per run.
export async function processPendingPrivacyRequests(db, { limit = 5 } = {}) {
  const rows = await db.query(
    `select id from ufs_agent.privacy_requests where status in ('pending','failed') and attempts < $1 order by created_at limit $2`,
    [MAX_ATTEMPTS, limit],
  );
  const out = [];
  for (const r of rows) out.push(await processPrivacyRequest(db, r.id));
  return out;
}

// Retention: redacts events older than event_content_days together with all
// derived copies, in bounded batches (idempotent: done rows are skipped), then
// purges stale identifiers, suppressions, old digests and moderator notes.
export async function applyRetention(db, { settings, now = new Date() }) {
  const r = settings.retention || {};
  const eventDays = Math.max(Number(r.event_content_days) || 90, 7);
  const auditDays = Math.max(Number(r.audit_days) || 730, 365);
  const metricsDays = Math.max(Number(r.metrics_days) || 400, 30);
  const identifierDays = Math.max(Number(r.identifier_days) || 400, eventDays);
  const digestDays = Math.max(Number(r.digest_days) || 90, 7);
  const noteDays = Math.max(Number(r.external_note_days) || 365, 30);
  const batch = Math.min(Math.max(Number(r.batch_size) || 200, 1), 1000);

  const due = await db.query(
    `select id from ufs_agent.events where derived_redacted_at is null and received_at < $1::timestamptz - make_interval(days => $2)
     order by received_at limit $3`,
    [now, eventDays, batch],
  );
  let redaction = null;
  if (due.length) {
    redaction = (await db.tx((t) => t.one("select ufs_agent.redact_events($1::uuid[], 'retention', null) as r", [due.map((d) => d.id)]))).r;
  }
  // Platform identifiers are kept for idempotency and for locating our own
  // replies; after identifier_days they are replaced by internal placeholders.
  const ids = await db.query(
    `with picked as (select id from ufs_agent.events where identifiers_purged_at is null and derived_redacted_at is not null
        and received_at < $1::timestamptz - make_interval(days => $2) order by received_at limit $3)
     update ufs_agent.events e set external_object_id = 'purged:' || e.id, external_parent_id = null,
        idempotency_key = 'purged:' || e.id, identifiers_purged_at = $1
     from picked where e.id = picked.id returning e.id, e.channel_id`,
    [now, identifierDays, batch],
  );
  let actionIds = 0;
  if (ids.length) {
    const rows = await db.query(
      `update ufs_agent.actions a set external_target_id = 'purged:' || a.id, external_result_id = null, updated_at = now()
       where a.case_id in (select c.id from ufs_agent.cases c where c.event_id = any($1::uuid[])) and a.external_target_id not like 'purged:%'
       returning a.id`,
      [ids.map((x) => x.id)],
    );
    actionIds = rows.length;
  }
  const supp = await db.query('delete from ufs_agent.privacy_suppressions where expires_at < $1 returning id', [now]);
  const digests = await db.query(
    `update ufs_agent.digests set body_text = '[expired]', redacted_at = $1
     where body_text is not null and body_text <> '[expired]' and generated_at < $1::timestamptz - make_interval(days => $2) returning id`,
    [now, digestDays],
  );
  const notes = await db.query(
    `update ufs_agent.external_notes set summary = '[expired]'
     where summary <> '[expired]' and created_at < $1::timestamptz - make_interval(days => $2) returning id`,
    [now, noteDays],
  );
  const auditDel = await db.query('delete from ufs_agent.audit_log where at < $1::timestamptz - make_interval(days => $2) returning id', [now, auditDays]);
  const metricsDel = await db.query('delete from ufs_agent.publication_metrics where collected_at < $1::timestamptz - make_interval(days => $2) returning id', [now, metricsDays]);
  return {
    eventsRedacted: redaction ? redaction.events : 0,
    derived: redaction,
    moreDue: due.length === batch,
    identifiersPurged: ids.length,
    actionIdentifiersPurged: actionIds,
    suppressionsExpired: supp.length,
    digestsExpired: digests.length,
    notesExpired: notes.length,
    auditDeleted: auditDel.length,
    metricsDeleted: metricsDel.length,
  };
}

export async function isSuppressed(db, channelId, { externalObjectId, authorRef }, now = new Date()) {
  const row = await db.one(
    `select 1 as hit from ufs_agent.privacy_suppressions
     where channel_id = $1 and expires_at > $4 and ((kind = 'object' and value = $2) or (kind = 'author' and value = $3)) limit 1`,
    [channelId, externalObjectId || '', authorRef || '', now],
  );
  return Boolean(row);
}
