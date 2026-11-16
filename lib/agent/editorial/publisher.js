// Deterministic publication controller. The ONLY code path that calls an
// adapter's publishPost. Exactly-once is guaranteed by:
//  * unique(channel_id, scheduled_local_date, scheduled_slot) and a unique
//    idempotency key per publication row,
//  * a lease taken with FOR UPDATE SKIP LOCKED before any provider call,
//  * never re-posting a row whose earlier attempt may have reached the
//    provider (status 'unknown' needs reconciliation, not a retry).

import { authorizePublication } from '../policy.js';
import { audit, getSettings, consumeQuota, bumpUsage, backoffSeconds } from '../db.js';
import { HARD_LIMITS } from '../config.js';
import { fetchAndCheckImage } from './media.js';

async function setPub(db, id, workerId, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
  await db.query(
    `update ufs_agent.publications set ${sets}, lease_owner=null, lease_expires_at=null, updated_at=now()
     where id=$1 and lease_owner=$2`,
    [id, workerId, ...keys.map((k) => fields[k])],
  );
}

export async function publishDue(db, deps, { workerId, limit = 10 } = {}) {
  const now = deps.now || new Date();
  // Crash recovery: an expired 'publishing' lease without an Instagram
  // container means the outcome is unknown. Never re-post automatically.
  await db.query(
    `update ufs_agent.publications set publication_status='unknown', status_reason='lease_expired_outcome_unknown', lease_owner=null, updated_at=now()
     where publication_status='publishing' and lease_expires_at < $1 and provider_container_id is null`,
    [now],
  );
  const claimed = await db.tx((t) => t.query(
    `with picked as (
       select id from ufs_agent.publications
       where (publication_status='scheduled' and scheduled_at <= $1 and (next_attempt_at is null or next_attempt_at <= $1))
          or (publication_status='publishing' and lease_expires_at < $1 and provider_container_id is not null)
       order by scheduled_at asc limit $2 for update skip locked)
     update ufs_agent.publications p set publication_status='publishing', lease_owner=$3,
       lease_expires_at=$1::timestamptz + make_interval(secs => $4), attempt_count=p.attempt_count+1, updated_at=now()
     from picked where p.id=picked.id returning p.*`,
    [now, limit, workerId, HARD_LIMITS.leaseSeconds],
  ));
  const results = [];
  for (const p of claimed) results.push(await publishOne(db, deps, p, workerId));
  return results;
}

export async function publishOne(db, deps, publication, workerId) {
  const now = deps.now || new Date();
  const settings = await getSettings(db); // fresh read, never cached
  const channel = await db.one('select * from ufs_agent.channels where id=$1', [publication.channel_id]);
  const content = await db.one('select * from ufs_agent.content where id=$1', [publication.content_id]);
  const calendar = content ? await db.one('select * from ufs_agent.editorial_calendar where id=$1', [content.editorial_calendar_id]) : null;
  const countRow = await db.one(
    `select count(*)::int as n from ufs_agent.publications
     where channel_id=$1 and scheduled_local_date=$2 and id<>$3 and publication_status in ('published','publishing','unknown')`,
    [publication.channel_id, publication.scheduled_local_date, publication.id],
  );
  let mediaCheck = null;
  if (channel?.provider === 'instagram' && publication.media_reference) {
    mediaCheck = await fetchAndCheckImage(publication.media_reference, deps.net);
  }
  const decision = authorizePublication({ settings, channel, publication, content, calendar, now, publishedToday: countRow.n, mediaCheck });

  if (!decision.allowed) {
    const status = decision.reasons.includes('window_expired') ? 'expired'
      : decision.reasons.includes('emergency_stop') ? 'scheduled'
        : decision.reasons.includes('content_not_publishable') ? 'needs_review' : 'skipped';
    const fields = { publication_status: status, status_reason: decision.reasons.join(';').slice(0, 300) };
    if (status === 'scheduled') fields.next_attempt_at = new Date(now.getTime() + 300_000);
    await setPub(db, publication.id, workerId, fields);
    await audit(db, { actorType: 'system', action: `publication_${status}`, entityType: 'publication', entityId: publication.id, detail: { reasons: decision.reasons } });
    return { id: publication.id, status, reasons: decision.reasons };
  }

  if (decision.mode === 'simulate') {
    await setPub(db, publication.id, workerId, { publication_status: 'simulated', status_reason: decision.reasons.join(';'), published_at: now });
    await audit(db, { actorType: 'system', action: 'publication_simulated', entityType: 'publication', entityId: publication.id, detail: { reasons: decision.reasons, channel: channel.provider } });
    await maybeMarkCalendar(db, calendar?.id);
    return { id: publication.id, status: 'simulated', reasons: decision.reasons };
  }

  if (!(await consumeQuota(db, 'outbound', Number(settings.limits?.outbound_per_day) || 0, 1, now))) {
    await setPub(db, publication.id, workerId, { publication_status: 'skipped', status_reason: 'outbound_quota_exhausted' });
    return { id: publication.id, status: 'skipped', reasons: ['outbound_quota'] };
  }

  const adapter = deps.adapterFor(channel);
  try {
    // Reconcile first: if an identical post already exists, record it.
    const existing = channel.provider === 'instagram' ? null : await adapter.findRecentPost(publication.platform_text);
    if (existing) {
      await setPub(db, publication.id, workerId, { publication_status: 'published', provider_post_id: existing.id, provider_post_url: existing.url, published_at: now, status_reason: 'reconciled_existing_post' });
      await audit(db, { actorType: 'system', action: 'publication_reconciled', entityType: 'publication', entityId: publication.id, detail: { provider_post_id: existing.id } });
      await maybeMarkCalendar(db, calendar?.id);
      return { id: publication.id, status: 'published', reconciled: true };
    }
    const stop = await db.one("select value from ufs_agent.settings where key='emergency_stop'");
    if (stop?.value?.active) {
      await setPub(db, publication.id, workerId, { publication_status: 'scheduled', status_reason: 'emergency_stop', next_attempt_at: new Date(now.getTime() + 300_000) });
      return { id: publication.id, status: 'scheduled', reasons: ['emergency_stop'] };
    }
    await bumpUsage(db, 'external_api_ops', 1, now);
    const res = await adapter.publishPost({ text: publication.platform_text, link: null, mediaUrl: publication.media_reference, containerId: publication.provider_container_id });
    if (res.pending) {
      // Keep the lease-expiry path: next run resumes this container.
      await db.query(
        `update ufs_agent.publications set provider_container_id=$3, status_reason='container_processing', updated_at=now()
         where id=$1 and lease_owner=$2`,
        [publication.id, workerId, res.containerId],
      );
      return { id: publication.id, status: 'publishing', containerId: res.containerId };
    }
    await setPub(db, publication.id, workerId, {
      publication_status: 'published', provider_post_id: res.id, provider_post_url: res.url || null, published_at: now, error_code: null, status_reason: null,
      ...(res.containerId ? { provider_container_id: res.containerId } : {}),
    });
    await audit(db, { actorType: 'system', action: 'publication_published', entityType: 'publication', entityId: publication.id, detail: { provider_post_id: res.id, channel: channel.provider } });
    await maybeMarkCalendar(db, calendar?.id);
    return { id: publication.id, status: 'published', postId: res.id };
  } catch (err) {
    const code = err.code || 'provider_error';
    const maxAttempts = Math.min(Number(settings.limits?.max_attempts) || 5, HARD_LIMITS.maxAttempts);
    let fields;
    if (['token_invalid', 'token_missing', 'permission_denied'].includes(code)) {
      await db.query('update ufs_agent.channels set token_status=$2, token_checked_at=now(), updated_at=now() where id=$1',
        [channel.id, code === 'permission_denied' ? 'missing_permissions' : 'invalid']);
      fields = { publication_status: 'failed', error_code: code, status_reason: 'credential_problem' };
    } else if ((code === 'provider_unavailable' && !err.httpStatus) || code === 'unknown_outcome') {
      fields = { publication_status: 'unknown', error_code: code, status_reason: 'outcome_unknown_reconcile_manually' };
    } else if (err.retryable && publication.attempt_count < maxAttempts) {
      const delay = Math.max(backoffSeconds(publication.attempt_count), err.retryAfterSeconds || 0);
      fields = { publication_status: 'scheduled', error_code: code, next_attempt_at: new Date(now.getTime() + delay * 1000) };
      await bumpUsage(db, 'retries', 1, now);
    } else {
      fields = { publication_status: 'failed', error_code: code };
    }
    await setPub(db, publication.id, workerId, fields);
    await audit(db, { actorType: 'provider', action: 'publication_error', entityType: 'publication', entityId: publication.id, detail: { error: code, attempt: publication.attempt_count } });
    return { id: publication.id, status: fields.publication_status, error: code };
  }
}

async function maybeMarkCalendar(db, calendarId) {
  if (!calendarId) return;
  await db.query(
    `update ufs_agent.editorial_calendar c set status = case
        when not exists (select 1 from ufs_agent.publications p join ufs_agent.content ct on ct.id=p.content_id
                         where ct.editorial_calendar_id=c.id and p.publication_status not in ('published','simulated')) then 'published'
        else 'partially_published' end, updated_at=now()
     where id=$1`,
    [calendarId],
  );
}

export async function collectMetrics(db, deps, { limit = 20 } = {}) {
  const now = deps.now || new Date();
  const due = await db.query(
    `select p.*, ch.provider from ufs_agent.publications p join ufs_agent.channels ch on ch.id=p.channel_id
     where p.publication_status='published' and p.provider_post_id is not null and p.published_at > $1::timestamptz - interval '14 days'
       and not exists (select 1 from ufs_agent.publication_metrics m where m.publication_id=p.id and m.collected_at > $1::timestamptz - interval '20 hours')
     order by p.published_at desc limit $2`,
    [now, limit],
  );
  let collected = 0;
  for (const p of due) {
    const channel = await db.one('select * from ufs_agent.channels where id=$1', [p.channel_id]);
    let m;
    try {
      m = await deps.adapterFor(channel).getPostMetrics(p.provider_post_id);
    } catch (err) {
      m = { available: false, reason: err.code || 'metrics_error' };
    }
    await db.query(
      `insert into ufs_agent.publication_metrics(publication_id, collected_at, impressions, reach, reactions, comments, shares, clicks, metrics_available, unavailable_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.id, now, m.impressions ?? null, m.reach ?? null, m.reactions ?? null, m.comments ?? null, m.shares ?? null, m.clicks ?? null, Boolean(m.available), m.available ? null : (m.reason || 'unavailable')],
    );
    collected += 1;
  }
  return { collected };
}
