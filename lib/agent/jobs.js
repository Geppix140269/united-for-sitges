// Scheduler tick: every step is idempotent and lease-based, so overlapping,
// repeated, delayed or crashed runs cannot duplicate work.

import { getSettings, audit } from './db.js';
import { newWorkerId, authorRef } from './crypto.js';
import { processEventQueue, enqueueEvents, forumEventFromRow } from './moderation.js';
import { executePendingActions } from './executor.js';
import { planCalendar } from './editorial/calendar.js';
import { generateUpcoming } from './editorial/generate.js';
import { publishDue, collectMetrics } from './editorial/publisher.js';
import { runDailyDigest, runUrgentAlerts, runWeeklyDigest } from './digest.js';
import { localDateString, zonedTimeToUtc } from './time.js';
import { env } from './config.js';

export const JOBS = ['forum', 'events', 'actions', 'plan', 'generate', 'publish', 'metrics', 'alerts', 'digest', 'retention'];

export async function ingestForum(db, { settings, now = new Date() }) {
  const channel = await db.one("select * from ufs_agent.channels where provider='forum' and ingest_enabled limit 1");
  if (!channel) return { skipped: 'forum_channel_not_enabled' };
  const cursor = channel.capabilities?.forum_cursor || new Date(now.getTime() - 86400000).toISOString();
  const rows = await db.query('select * from ufs_agent.forum_items_since($1::timestamptz, 100)', [cursor]);
  const pepper = env('AGENT_AUTHOR_PEPPER');
  const events = rows.map((r) => ({ ...forumEventFromRow(r, (id) => authorRef('forum', id, pepper)), externalAccountId: channel.external_account_id }));
  const res = await enqueueEvents(db, events, { settings, now });
  if (rows.length) {
    const last = rows[rows.length - 1].created_at;
    await db.query(
      "update ufs_agent.channels set capabilities = capabilities || jsonb_build_object('forum_cursor', $2::text), updated_at=now() where id=$1",
      [channel.id, new Date(last).toISOString()],
    );
  }
  return res;
}

export async function applyRetention(db, { settings, now = new Date() }) {
  const r = settings.retention || {};
  const eventDays = Math.max(Number(r.event_content_days) || 90, 7);
  const auditDays = Math.max(Number(r.audit_days) || 730, 365);
  const metricsDays = Math.max(Number(r.metrics_days) || 400, 30);
  const redacted = await db.query(
    `update ufs_agent.events set content_excerpt=null, author_ref=null, permalink=null, content_purged_at=$1
     where content_purged_at is null and received_at < $1::timestamptz - make_interval(days => $2) returning id`,
    [now, eventDays],
  );
  await db.query(
    `update ufs_agent.drafts d set source_references='[]'::jsonb where d.created_at < $1::timestamptz - make_interval(days => $2) and d.status in ('rejected','superseded')`,
    [now, eventDays],
  );
  const auditDel = await db.query(`delete from ufs_agent.audit_log where at < $1::timestamptz - make_interval(days => $2) returning id`, [now, auditDays]);
  const metricsDel = await db.query(`delete from ufs_agent.publication_metrics where collected_at < $1::timestamptz - make_interval(days => $2) returning id`, [now, metricsDays]);
  return { eventsRedacted: redacted.length, auditDeleted: auditDel.length, metricsDeleted: metricsDel.length };
}

export async function runTick(db, deps, { jobs = JOBS } = {}) {
  const now = deps.now || new Date();
  const workerId = deps.workerId || newWorkerId();
  const settings = await getSettings(db);
  const ctx = { ...deps, settings, now };
  const summary = { workerId, at: now.toISOString(), mode: { moderation: settings.moderation?.mode, publishing: settings.publishing?.mode, emergency_stop: Boolean(settings.emergency_stop?.active) }, jobs: {} };
  const tz = settings.publishing?.timezone || 'Europe/Madrid';
  const localToday = localDateString(now, tz);

  const steps = {
    forum: () => ingestForum(db, ctx),
    events: () => (settings.moderation?.mode === 'DISABLED' ? { skipped: 'moderation_disabled' } : processEventQueue(db, ctx, { workerId })),
    actions: () => executePendingActions(db, ctx, { workerId }),
    plan: () => (settings.publishing?.mode === 'DISABLED' ? { skipped: 'publishing_disabled' } : planCalendar(db, ctx)),
    generate: () => generateUpcoming(db, ctx, { workerId }),
    publish: () => publishDue(db, ctx, { workerId }),
    metrics: () => collectMetrics(db, ctx),
    alerts: () => runUrgentAlerts(db, ctx),
    digest: async () => {
      if (now < zonedTimeToUtc(localToday, '07:30', tz)) return { skipped: 'before_digest_time' };
      const daily = await runDailyDigest(db, ctx);
      const weekly = await runWeeklyDigest(db, ctx);
      return { daily: daily.status, weekly: weekly.status };
    },
    retention: () => applyRetention(db, ctx),
  };

  for (const name of jobs) {
    if (!steps[name]) continue;
    try {
      const r = await steps[name]();
      summary.jobs[name] = Array.isArray(r) ? { count: r.length, results: r.map((x) => ({ status: x.status, reason: x.reason || x.reasons?.[0] || x.error || null })) } : r;
    } catch (err) {
      summary.jobs[name] = { error: err.code || 'job_failed' };
      await audit(db, { actorType: 'system', action: 'job_failed', entityType: 'job', entityId: name, detail: { error: err.code || 'job_failed', message: String(err.message || '').slice(0, 200) } }).catch(() => {});
    }
  }
  return summary;
}
