// Daily (and weekly) administrative digest. Idempotent per period through
// unique(kind, period_key). Sending is OFF unless the owner enables it in
// settings AND the AGENT_LIVE_EMAIL switch AND Resend credentials exist.
// The digest contains counts, categories and links, never full conversations
// or personal data.

import { audit, getSettings } from './db.js';
import { env, liveSwitches } from './config.js';
import { sha256Hex } from './crypto.js';
import { localDateString, addDays, zonedTimeToUtc } from './time.js';

function line(label, value) {
  return `- ${label}: ${value}`;
}

export async function buildDailyDigest(db, { periodDate, settings, tz = 'Europe/Madrid' }) {
  const from = zonedTimeToUtc(periodDate, '00:00', tz);
  const to = zonedTimeToUtc(addDays(periodDate, 1), '00:00', tz);
  const q = (sql, extra = []) => db.query(sql, [from, to, ...extra]);

  const byChannel = await q(
    `select ch.account_label as label, ch.provider, count(*)::int as n from ufs_agent.events e join ufs_agent.channels ch on ch.id=e.channel_id
     where e.received_at >= $1 and e.received_at < $2 group by 1,2 order by 3 desc`,
  );
  const auto = await q(`select count(*)::int as n from ufs_agent.actions where actor_type='system' and execution_status in ('succeeded','simulated') and coalesce(executed_at, created_at) >= $1 and coalesce(executed_at, created_at) < $2`);
  const manual = await q(`select count(*)::int as n from ufs_agent.actions where actor_type='human' and execution_status in ('succeeded','simulated') and coalesce(executed_at, created_at) >= $1 and coalesce(executed_at, created_at) < $2`);
  const awaiting = await db.query(`select count(*)::int as n from ufs_agent.cases where status in ('open','awaiting_approval','escalated')`);
  const urgent = await q(`select category, risk_level, summary from ufs_agent.cases where risk_level in ('high','critical') and created_at >= $1 and created_at < $2 order by priority, created_at limit 10`);
  const topCats = await q(`select category, count(*)::int as n from ufs_agent.cases where created_at >= $1 and created_at < $2 group by 1 order by 2 desc limit 5`);
  const faqs = await q(`select f.canonical_question as q, count(*)::int as n from ufs_agent.cases c join ufs_agent.faq f on f.id=c.faq_id where c.created_at >= $1 and c.created_at < $2 group by 1 order by 2 desc limit 5`);
  const failures = await q(
    `select 'event' as kind, processing_status as status, count(*)::int as n from ufs_agent.events where processing_status in ('failed','dead') and received_at >= $1 and received_at < $2 group by 1,2
     union all select 'action', execution_status, count(*)::int from ufs_agent.actions where execution_status in ('failed','unknown','blocked') and updated_at >= $1 and updated_at < $2 group by 1,2
     union all select 'publication', publication_status, count(*)::int from ufs_agent.publications where publication_status in ('failed','unknown','expired') and updated_at >= $1 and updated_at < $2 group by 1,2`,
  );
  const pubs = await db.query(
    `select p.publication_status as status, p.status_reason as reason, p.provider_post_url as url, p.scheduled_slot as slot, ch.account_label as channel, ec.topic
     from ufs_agent.publications p join ufs_agent.channels ch on ch.id=p.channel_id
     join ufs_agent.content c on c.id=p.content_id join ufs_agent.editorial_calendar ec on ec.id=c.editorial_calendar_id
     where p.scheduled_local_date=$1 order by p.scheduled_at`, [periodDate],
  );
  const skippedSlots = await db.query(`select planned_slot as slot, status, status_reason as reason, topic from ufs_agent.editorial_calendar where planned_date=$1 and status in ('skipped','needs_review','failed')`, [periodDate]);
  const upcoming = await db.query(`select planned_date, planned_slot, topic, status from ufs_agent.editorial_calendar where planned_date > $1 and planned_date <= $1::date + 3 order by planned_date, planned_slot`, [periodDate]);
  const engagement = await q(
    `select ch.account_label as channel, sum(m.impressions)::int as views, sum(m.reactions)::int as reactions, sum(m.comments)::int as comments
     from ufs_agent.publication_metrics m join ufs_agent.publications p on p.id=m.publication_id join ufs_agent.channels ch on ch.id=p.channel_id
     where m.metrics_available and m.collected_at >= $1 and m.collected_at < $2 group by 1`,
  );
  const mode = `${settings.moderation?.mode || '?'} moderation, ${settings.publishing?.mode || '?'} publishing${settings.emergency_stop?.active ? ', EMERGENCY STOP ACTIVE' : ''}`;
  const dash = settings.digest?.dashboard_url || 'https://unitedforsitges.com/agent-console.html';

  const lines = [
    `United for Sitges agent digest for ${periodDate} (Europe/Madrid)`,
    `Operating state: ${mode}`,
    '',
    'Interactions by channel:',
    ...(byChannel.length ? byChannel.map((r) => line(`${r.label} (${r.provider})`, r.n)) : ['- none']),
    '',
    line('Handled automatically (approved FAQ)', auto[0].n),
    line('Replies approved manually', manual[0].n),
    line('Items awaiting review now', awaiting[0].n),
    '',
    'High-priority incidents:',
    ...(urgent.length ? urgent.map((u) => line(`${u.risk_level} ${u.category}`, u.summary.slice(0, 160))) : ['- none']),
    '',
    'Top categories:',
    ...(topCats.length ? topCats.map((c) => line(c.category, c.n)) : ['- none']),
    'Top recurring FAQ:',
    ...(faqs.length ? faqs.map((f) => line(f.q, f.n)) : ['- none']),
    '',
    'Publishing:',
    ...(pubs.length ? pubs.map((p) => line(`${p.slot} on ${p.channel}`, `${p.status}${p.url ? ` ${p.url}` : ''}${p.reason ? ` (${p.reason})` : ''}`)) : ['- no publications scheduled']),
    ...(skippedSlots.length ? ['Skipped or held slots:', ...skippedSlots.map((s) => line(`${s.slot}: ${s.topic}`, `${s.status} (${s.reason || 'no reason'})`))] : []),
    'Engagement (only where the platform reported real metrics):',
    ...(engagement.length ? engagement.map((e) => line(e.channel, `views ${e.views ?? 'n/a'}, reactions ${e.reactions ?? 'n/a'}, comments ${e.comments ?? 'n/a'}`)) : ['- no metrics available']),
    'Upcoming topics:',
    ...(upcoming.length ? upcoming.map((u) => line(`${String(u.planned_date instanceof Date ? u.planned_date.toISOString().slice(0, 10) : u.planned_date)} ${u.planned_slot}`, `${u.topic} [${u.status}]`)) : ['- none planned']),
    '',
    'Operational failures:',
    ...(failures.length ? failures.map((f) => line(`${f.kind} ${f.status}`, f.n)) : ['- none']),
    '',
    `Dashboard: ${dash}`,
  ];
  return { subject: `U4S agent digest ${periodDate}`, body: lines.join('\n') };
}

export async function sendViaResend({ from, to, subject, text, idempotencyKey, fetchImpl = globalThis.fetch }) {
  const key = env('RESEND_API_KEY');
  if (!key) throw Object.assign(new Error('Resend not configured'), { code: 'email_not_configured' });
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ from, to: [to], subject, text }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error('Resend rejected email'), { code: `email_http_${res.status}` });
  return body.id || null;
}

function emailAllowed(settings) {
  const d = settings.digest || {};
  return d.send_enabled === true && liveSwitches().email && Boolean(env('RESEND_API_KEY')) && typeof d.sender === 'string' && /@notify\.unitedforsitges\.com>?$/.test(d.sender) && typeof d.recipient === 'string';
}

// Generates (once) and optionally sends the digest for the previous local day.
export async function runDailyDigest(db, deps = {}) {
  const now = deps.now || new Date();
  const settings = deps.settings || await getSettings(db);
  const tz = settings.publishing?.timezone || 'Europe/Madrid';
  const periodDate = deps.periodDate || addDays(localDateString(now, tz), -1);
  const claim = await db.one(
    `insert into ufs_agent.digests(kind, period_key, status) values ('daily',$1,'generating')
     on conflict (kind, period_key) do nothing returning id`,
    [periodDate],
  );
  if (!claim) return { status: 'already_generated', periodDate };
  const { subject, body } = await buildDailyDigest(db, { periodDate, settings, tz });
  const send = emailAllowed(settings);
  await db.query('update ufs_agent.digests set subject=$2, body_text=$3, content_hash=$4, status=$5 where id=$1',
    [claim.id, subject, body, sha256Hex(body), send ? 'sending' : 'dry_run']);
  if (!send) {
    await audit(db, { actorType: 'system', action: 'digest_dry_run', entityType: 'digest', entityId: claim.id, detail: { period: periodDate } });
    return { status: 'dry_run', periodDate, subject, body };
  }
  try {
    const id = await sendViaResend({ from: settings.digest.sender, to: settings.digest.recipient, subject, text: body, idempotencyKey: `u4s-digest-daily-${periodDate}`, fetchImpl: deps.fetchImpl });
    await db.query("update ufs_agent.digests set status='sent', sent_at=now(), provider_message_id=$2 where id=$1", [claim.id, id]);
    await audit(db, { actorType: 'system', action: 'digest_sent', entityType: 'digest', entityId: claim.id, detail: { period: periodDate } });
    return { status: 'sent', periodDate };
  } catch (err) {
    await db.query("update ufs_agent.digests set status='failed', error_code=$2 where id=$1", [claim.id, err.code || 'email_error']);
    return { status: 'failed', periodDate, error: err.code };
  }
}

// Urgent alert for a critical/high case, once per case.
export async function runUrgentAlerts(db, deps = {}) {
  const settings = deps.settings || await getSettings(db);
  const cases = await db.query(
    `select c.id, c.category, c.risk_level from ufs_agent.cases c
     where c.risk_level in ('critical','high') and c.created_at > now() - interval '2 days'
       and not exists (select 1 from ufs_agent.digests d where d.kind='alert' and d.period_key=c.id::text)
     order by c.priority, c.created_at limit 10`,
  );
  const out = [];
  for (const c of cases) {
    const body = `A ${c.risk_level} priority ${c.category.replace(/_/g, ' ')} case needs human review.\nOpen the dashboard: ${settings.digest?.dashboard_url || 'https://unitedforsitges.com/agent-console.html'}\nCase reference: ${c.id}`;
    const claim = await db.one(
      `insert into ufs_agent.digests(kind, period_key, status, subject, body_text, content_hash) values ('alert',$1,'generating',$2,$3,$4)
       on conflict (kind, period_key) do nothing returning id`,
      [c.id, `U4S urgent review: ${c.category}`, body, sha256Hex(body)],
    );
    if (!claim) continue;
    if (!emailAllowed(settings)) {
      await db.query("update ufs_agent.digests set status='dry_run' where id=$1", [claim.id]);
      out.push({ case: c.id, status: 'dry_run' });
      continue;
    }
    try {
      const id = await sendViaResend({ from: settings.digest.sender, to: settings.digest.recipient, subject: `U4S urgent review: ${c.category}`, text: body, idempotencyKey: `u4s-alert-${c.id}`, fetchImpl: deps.fetchImpl });
      await db.query("update ufs_agent.digests set status='sent', sent_at=now(), provider_message_id=$2 where id=$1", [claim.id, id]);
      out.push({ case: c.id, status: 'sent' });
    } catch (err) {
      await db.query("update ufs_agent.digests set status='failed', error_code=$2 where id=$1", [claim.id, err.code || 'email_error']);
      out.push({ case: c.id, status: 'failed' });
    }
  }
  return out;
}

// Weekly trend report (Mondays, previous ISO week). Uses only metrics the
// platforms actually returned; missing metrics are reported as unavailable.
export function isoWeekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function runWeeklyDigest(db, deps = {}) {
  const now = deps.now || new Date();
  const settings = deps.settings || await getSettings(db);
  const tz = settings.publishing?.timezone || 'Europe/Madrid';
  const today = localDateString(now, tz);
  const [y, m, d] = today.split('-').map(Number);
  if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 1) return { status: 'not_monday' };
  const weekStart = addDays(today, -7);
  const key = isoWeekKey(weekStart);
  const claim = await db.one(
    `insert into ufs_agent.digests(kind, period_key, status) values ('weekly',$1,'generating') on conflict (kind, period_key) do nothing returning id`,
    [key],
  );
  if (!claim) return { status: 'already_generated', key };
  const from = zonedTimeToUtc(weekStart, '00:00', tz);
  const to = zonedTimeToUtc(today, '00:00', tz);
  const pubs = await db.query(
    `select ch.account_label as channel, p.publication_status as status, count(*)::int as n from ufs_agent.publications p
     join ufs_agent.channels ch on ch.id=p.channel_id where p.scheduled_at >= $1 and p.scheduled_at < $2 group by 1,2 order by 1,2`, [from, to],
  );
  const metrics = await db.query(
    `select ch.account_label as channel, count(distinct m.publication_id)::int as posts_with_metrics,
       sum(m.impressions)::int as views, sum(m.reactions)::int as reactions, sum(m.comments)::int as comments, sum(m.shares)::int as shares
     from (select distinct on (publication_id) * from ufs_agent.publication_metrics where metrics_available order by publication_id, collected_at desc) m
     join ufs_agent.publications p on p.id=m.publication_id join ufs_agent.channels ch on ch.id=p.channel_id
     where p.scheduled_at >= $1 and p.scheduled_at < $2 group by 1`, [from, to],
  );
  const cases = await db.query(`select category, count(*)::int as n from ufs_agent.cases where created_at >= $1 and created_at < $2 group by 1 order by 2 desc`, [from, to]);
  const body = [
    `United for Sitges weekly agent report ${key} (${weekStart} to ${addDays(today, -1)})`,
    '', 'Publications by status:', ...(pubs.length ? pubs.map((p) => line(`${p.channel} ${p.status}`, p.n)) : ['- none']),
    '', 'Engagement (latest platform-reported values; no estimates):',
    ...(metrics.length ? metrics.map((x) => line(x.channel, `posts with metrics ${x.posts_with_metrics}, views ${x.views ?? 'n/a'}, reactions ${x.reactions ?? 'n/a'}, comments ${x.comments ?? 'n/a'}, shares ${x.shares ?? 'n/a'}`)) : ['- no metrics available']),
    '', 'Cases by category:', ...(cases.length ? cases.map((c) => line(c.category, c.n)) : ['- none']),
  ].join('\n');
  const send = emailAllowed(settings);
  await db.query('update ufs_agent.digests set subject=$2, body_text=$3, content_hash=$4, status=$5 where id=$1',
    [claim.id, `U4S weekly agent report ${key}`, body, sha256Hex(body), send ? 'sending' : 'dry_run']);
  if (!send) return { status: 'dry_run', key, body };
  try {
    const id = await sendViaResend({ from: settings.digest.sender, to: settings.digest.recipient, subject: `U4S weekly agent report ${key}`, text: body, idempotencyKey: `u4s-digest-weekly-${key}`, fetchImpl: deps.fetchImpl });
    await db.query("update ufs_agent.digests set status='sent', sent_at=now(), provider_message_id=$2 where id=$1", [claim.id, id]);
    return { status: 'sent', key };
  } catch (err) {
    await db.query("update ufs_agent.digests set status='failed', error_code=$2 where id=$1", [claim.id, err.code || 'email_error']);
    return { status: 'failed', key };
  }
}
