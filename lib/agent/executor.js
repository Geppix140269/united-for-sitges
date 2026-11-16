// The ONLY component allowed to call provider write methods for replies.
// Each action is leased, re-authorised against fresh state immediately
// before the provider call, and recorded with its outcome.

import { authorizeReply } from './policy.js';
import { faqIneligibility } from './faq.js';
import { audit, getSettings, consumeQuota, bumpUsage, backoffSeconds } from './db.js';
import { HARD_LIMITS } from './config.js';

// Fail closed if the live comment has been edited since the approved draft
// was based on it. Webhook excerpts are capped at 2000 chars; longer comments
// cannot be compared reliably and must be handled manually.
export function commentMatchesOriginal(currentText, originalExcerpt) {
  if (typeof currentText !== 'string' || typeof originalExcerpt !== 'string') return false;
  const clean = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  const current = clean(currentText);
  const original = clean(originalExcerpt);
  return current.length > 0 && current.length <= HARD_LIMITS.maxExcerptChars && current === original;
}

async function finish(db, action, workerId, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
  await db.query(
    `update ufs_agent.actions set ${sets}, lease_owner=null, lease_expires_at=null, updated_at=now() where id=$1 and lease_owner=$2`,
    [action.id, workerId, ...keys.map((k) => fields[k])],
  );
}

export async function executePendingActions(db, deps, { workerId, limit = 10 } = {}) {
  const now = deps.now || new Date();
  // Claim one action at a time so two pending actions for the same target
  // can never be in flight together. The partial unique index
  // actions_one_success_per_target makes any racing claim fail closed.
  const claimOne = () => db.tx((t) => t.one(
    `with picked as (
       select a.id from ufs_agent.actions a
       where a.execution_status='pending' and a.next_attempt_at <= greatest($1::timestamptz, now())
         and not exists (select 1 from ufs_agent.actions o
           where o.target_channel_id=a.target_channel_id and o.external_target_id=a.external_target_id
             and o.action_type=a.action_type and o.execution_status in ('executing','succeeded','unknown'))
       order by a.created_at asc limit 1 for update skip locked)
     update ufs_agent.actions a set execution_status='executing', lease_owner=$2,
       lease_expires_at=$1::timestamptz + make_interval(secs => $3), attempt_count=a.attempt_count+1
     from picked where a.id=picked.id returning a.*`,
    [now, workerId, HARD_LIMITS.leaseSeconds],
  ));
  // An 'executing' action whose lease expired may or may not have reached the
  // provider: never retry blindly, mark it unknown for reconciliation.
  await db.query(
    `update ufs_agent.actions set execution_status='unknown', status_reason='lease_expired_outcome_unknown', lease_owner=null, updated_at=now()
     where execution_status='executing' and lease_expires_at < $1`,
    [now],
  );
  const results = [];
  for (let i = 0; i < limit; i += 1) {
    let action;
    try {
      action = await claimOne();
    } catch (err) {
      if (err.code === '23505') break; // concurrent claim on the same target: stop, retry next run
      throw err;
    }
    if (!action) break;
    results.push(await executeOne(db, deps, action, workerId));
  }
  return results;
}

export async function executeOne(db, deps, action, workerId) {
  const now = deps.now || new Date();
  // Fresh state, read immediately before the decision.
  const settings = await getSettings(db);
  const channel = await db.one('select * from ufs_agent.channels where id=$1', [action.target_channel_id]);
  const draft = action.draft_id ? await db.one('select * from ufs_agent.drafts where id=$1', [action.draft_id]) : null;
  const caseRow = action.case_id ? await db.one('select * from ufs_agent.cases where id=$1', [action.case_id]) : null;
  const succeeded = await db.one(
    `select 1 from ufs_agent.actions where target_channel_id=$1 and external_target_id=$2 and action_type=$3
       and execution_status in ('succeeded','unknown') and id<>$4 limit 1`,
    [action.target_channel_id, action.external_target_id, action.action_type, action.id],
  );
  const decision = authorizeReply({ settings, channel, action, draft, caseRow, now, succeededForTarget: Boolean(succeeded) });

  if (decision.allowed && draft?.origin === 'faq' && caseRow?.faq_id) {
    const faq = await db.one('select * from ufs_agent.faq where id=$1', [caseRow.faq_id]);
    const reason = faqIneligibility(faq, { now, channelProvider: channel?.provider });
    if (reason) { decision.allowed = false; decision.mode = 'block'; decision.reasons = [`faq_${reason}`]; }
  }

  if (!decision.allowed) {
    await finish(db, action, workerId, { execution_status: 'blocked', status_reason: decision.reasons.join(';').slice(0, 300) });
    await audit(db, { actorType: 'system', action: 'reply_blocked', entityType: 'action', entityId: action.id, detail: { reasons: decision.reasons } });
    return { id: action.id, status: 'blocked', reasons: decision.reasons };
  }

  if (decision.mode === 'simulate') {
    await finish(db, action, workerId, { execution_status: 'simulated', status_reason: decision.reasons.join(';'), executed_at: now });
    await audit(db, { actorType: 'system', action: 'reply_simulated', entityType: 'action', entityId: action.id, detail: { reasons: decision.reasons, target: action.external_target_id } });
    return { id: action.id, status: 'simulated', reasons: decision.reasons };
  }

  if (!(await consumeQuota(db, 'outbound', Number(settings?.limits?.outbound_per_day) || 0, 1, now))) {
    await finish(db, action, workerId, { execution_status: 'pending', status_reason: 'outbound_quota', next_attempt_at: new Date(now.getTime() + 3600_000) });
    return { id: action.id, status: 'deferred', reasons: ['outbound_quota'] };
  }

  const adapter = deps.adapterFor(channel);
  try {
    await bumpUsage(db, 'external_api_ops', 3, now);
    const target = await adapter.getComment(action.external_target_id);
    if (!target.exists) {
      await finish(db, action, workerId, { execution_status: 'cancelled', status_reason: 'target_missing', error_code: 'target_missing' });
      await audit(db, { actorType: 'system', action: 'reply_cancelled', entityType: 'action', entityId: action.id, detail: { reason: 'target_missing' } });
      return { id: action.id, status: 'cancelled' };
    }
    const existing = await adapter.findOwnReply(action.external_target_id);
    if (existing) {
      await finish(db, action, workerId, { execution_status: 'succeeded', external_result_id: existing, executed_at: now, status_reason: 'reconciled_existing_reply' });
      await audit(db, { actorType: 'system', action: 'reply_reconciled', entityType: 'action', entityId: action.id, detail: { external_result_id: existing } });
      return { id: action.id, status: 'succeeded', reconciled: true };
    }
    // Re-check the case and comment version immediately before replying.
    // A queued action never grants permission to reply to a later edit.
    const freshCase = caseRow ? await db.one('select status from ufs_agent.cases where id=$1', [caseRow.id]) : null;
    const originalEvent = caseRow ? await db.one(
      'select id, content_excerpt, received_at from ufs_agent.events where id=$1', [caseRow.event_id],
    ) : null;
    const newerChange = originalEvent ? await db.one(
      `select 1 from ufs_agent.events
       where channel_id=$1 and external_object_id=$2
         and id<>$3 and received_at >= $4
         and event_type in ('comment_removed','comment_edited') limit 1`,
      [action.target_channel_id, action.external_target_id, originalEvent.id, originalEvent.received_at],
    ) : null;
    const cancelledCase = !freshCase || ['dismissed', 'escalated'].includes(freshCase.status);
    const editedComment = Boolean(newerChange)
      || (channel.provider !== 'mock' && !commentMatchesOriginal(target.text, originalEvent?.content_excerpt));
    if (cancelledCase || editedComment) {
      const reason = cancelledCase ? 'case_no_longer_replyable' : 'target_text_changed_or_unverifiable';
      await finish(db, action, workerId, { execution_status: 'cancelled', status_reason: reason, error_code: reason });
      await audit(db, { actorType: 'system', action: 'reply_cancelled', entityType: 'action', entityId: action.id, detail: { reason } });
      return { id: action.id, status: 'cancelled', reasons: [reason] };
    }

    // Last-instant kill-switch check, right before the write call.
    const stop = await db.one("select value from ufs_agent.settings where key='emergency_stop'");
    if (stop?.value?.active) {
      await finish(db, action, workerId, { execution_status: 'blocked', status_reason: 'emergency_stop' });
      return { id: action.id, status: 'blocked', reasons: ['emergency_stop'] };
    }
    const res = await adapter.replyToComment(action.external_target_id, action.payload_text);
    await db.tx(async (t) => {
      await t.query(
        `update ufs_agent.actions set execution_status='succeeded', external_result_id=$3, executed_at=$4, lease_owner=null,
           lease_expires_at=null, error_code=null, updated_at=now() where id=$1 and lease_owner=$2`,
        [action.id, workerId, res.id, now],
      );
      if (draft) await t.query("update ufs_agent.drafts set status='published' where id=$1", [draft.id]);
      if (caseRow) await t.query("update ufs_agent.cases set status='resolved', updated_at=now() where id=$1", [caseRow.id]);
      await audit(t, { actorType: 'system', action: 'reply_published', entityType: 'action', entityId: action.id, detail: { external_result_id: res.id, actor: action.actor_type } });
    });
    return { id: action.id, status: 'succeeded', externalId: res.id };
  } catch (err) {
    return handleProviderError(db, action, workerId, err, { channel, now, settings });
  }
}

async function handleProviderError(db, action, workerId, err, { channel, now, settings }) {
  const code = err.code || 'provider_error';
  const maxAttempts = Math.min(Number(settings?.limits?.max_attempts) || 5, HARD_LIMITS.maxAttempts);
  if (code === 'token_invalid' || code === 'token_missing' || code === 'permission_denied') {
    await db.query("update ufs_agent.channels set token_status=$2, token_checked_at=now(), updated_at=now() where id=$1",
      [channel.id, code === 'permission_denied' ? 'missing_permissions' : 'invalid']);
    await finish(db, action, workerId, { execution_status: 'failed', error_code: code, status_reason: 'credential_problem' });
  } else if (code === 'provider_unavailable' && !err.httpStatus) {
    // Network failure on a write: the provider may have accepted it.
    await finish(db, action, workerId, { execution_status: 'unknown', error_code: code, status_reason: 'network_error_outcome_unknown' });
  } else if (err.retryable && action.attempt_count < maxAttempts) {
    const delay = Math.max(backoffSeconds(action.attempt_count), err.retryAfterSeconds || 0);
    await finish(db, action, workerId, { execution_status: 'pending', error_code: code, next_attempt_at: new Date(now.getTime() + delay * 1000) });
    await bumpUsage(db, 'retries', 1, now);
  } else {
    await finish(db, action, workerId, { execution_status: 'failed', error_code: code });
  }
  await audit(db, { actorType: 'provider', action: 'reply_error', entityType: 'action', entityId: action.id, detail: { error: code, attempt: action.attempt_count } });
  return { id: action.id, status: 'error', error: code };
}
