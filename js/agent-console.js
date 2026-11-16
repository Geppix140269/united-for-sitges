// Agent console (moderators only). All data comes from /api/agent/admin,
// which re-checks moderator status server-side on every call. Content from
// the public is rendered with textContent only, never as HTML.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.75.0';

const cfg = window.UFS_FORUM_CONFIG || {};
const supabase = createClient(cfg.url, cfg.publishableKey, { auth: { persistSession: true, storageKey: 'ufs-agent-console' } });
const API = '/api/agent/admin';
const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (k === 'text') n.textContent = v;
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const pill = (t, kind = '') => el('span', { class: `pill ${kind}`, text: t });
const fmt = (d) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/Madrid' }) : '');
const statusKind = (s) => (['published', 'succeeded', 'passed', 'publishable', 'valid', 'verified', 'resolved', 'ready', 'processed'].includes(s) ? 'ok'
  : ['failed', 'dead', 'blocked', 'expired', 'unknown', 'critical', 'high', 'invalid', 'escalated'].includes(s) ? 'bad'
    : ['needs_review', 'simulated', 'pending', 'medium', 'awaiting_approval', 'skipped', 'dry_run'].includes(s) ? 'warn' : '');

async function token() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

async function api(method, params = {}) {
  const t = await token();
  if (!t) throw new Error('signed_out');
  const url = method === 'GET' ? `${API}?${new URLSearchParams(params)}` : API;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(params) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `http_${res.status}`);
  return body;
}

function setStatus(msg, error = false) {
  const s = $('status');
  s.textContent = msg;
  s.className = error ? 'error' : 'muted';
}

async function act(params, okMsg = 'Saved.') {
  try {
    const r = await api('POST', params);
    setStatus(okMsg);
    await render();
    return r;
  } catch (e) {
    setStatus(`Not done: ${e.message}`, true);
    return null;
  }
}

function table(headers, rows) {
  return el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, headers.map((h) => el('th', { text: h })))), el('tbody', {}, rows)));
}

// ------------------------------------------------------------------ tabs
const TABS = {
  overview: 'Overview', cases: 'Cases', publishing: 'Content publishing', faq: 'FAQ library', sources: 'Sources',
  channels: 'Channels', failures: 'Failures', audit: 'Audit', digests: 'Digests', external: 'External notes', settings: 'Settings',
};
let current = 'overview';

const RENDER = {
  async overview() {
    const o = await api('GET', { view: 'overview' });
    const stop = o.settings.emergency_stop || {};
    const stopCard = el('div', { class: `card ${stop.active ? 'stop' : ''}` },
      el('h2', { text: 'Emergency stop' }),
      el('p', {}, stop.active ? pill('ACTIVE: all outbound actions blocked', 'bad') : pill('Not active', 'ok'), stop.reason ? ` ${stop.reason}` : ''),
      stop.active
        ? el('button', { class: 'act', onclick: () => act({ action: 'set_emergency_stop', active: false }, 'Emergency stop released.') }, 'Release stop')
        : el('button', { class: 'act danger', onclick: () => { const r = prompt('Reason for stopping all outbound actions:'); if (r) act({ action: 'set_emergency_stop', active: true, reason: r }, 'Emergency stop ACTIVE.'); } }, 'STOP all outbound actions'));
    const c = o.counts;
    const usage = Object.fromEntries(o.usage.map((u) => [u.metric, u.count]));
    return [
      stopCard,
      el('div', { class: 'card' }, el('h2', { text: 'Operating state' }),
        el('p', {}, 'Moderation: ', pill(o.settings.moderation.mode, o.settings.moderation.mode === 'SUPERVISED' ? 'warn' : ''), ' Auto replies: ', pill(String(o.settings.moderation.auto_reply_enabled))),
        el('p', {}, 'Publishing: ', pill(o.settings.publishing.mode, o.settings.publishing.mode === 'AUTONOMOUS' ? 'warn' : ''), ` Slots ${o.settings.publishing.morning_publish_time} and ${o.settings.publishing.evening_publish_time} ${o.settings.publishing.timezone}`),
        el('p', { class: 'muted' }, 'Deployment live switches: ', Object.entries(o.live_switches).map(([k, v]) => pill(`${k}: ${v ? 'on' : 'off'}`, v ? 'warn' : '')))),
      el('div', { class: 'grid' },
        [['Interactions (24h)', c.events_24h], ['Awaiting review', c.awaiting], ['Urgent', c.urgent], ['Failed events', c.failed_events], ['Failed replies', c.failed_actions], ['Failed posts', c.failed_publications]]
          .map(([k, v]) => el('div', { class: 'card stat' }, el('b', { text: String(v) }), k))),
      el('div', { class: 'card' }, el('h2', { text: `Today's publishing schedule (${o.today})` }),
        o.schedule.length ? table(['Slot', 'Time', 'Channel', 'Status', 'Link'], o.schedule.map((p) => el('tr', {},
          el('td', { text: p.scheduled_slot }), el('td', { text: fmt(p.scheduled_at) }), el('td', { text: `${p.account_label} (${p.provider})` }),
          el('td', {}, pill(p.publication_status, statusKind(p.publication_status)), p.status_reason ? ` ${p.status_reason}` : ''),
          el('td', {}, p.provider_post_url ? el('a', { href: p.provider_post_url, target: '_blank', rel: 'noopener', text: 'open' }) : '')))) : el('p', { class: 'muted', text: 'Nothing scheduled today.' })),
      el('div', { class: 'card' }, el('h2', { text: 'Usage today (UTC)' }), el('p', {}, Object.keys(usage).length ? Object.entries(usage).map(([k, v]) => pill(`${k}: ${v}`)) : 'No usage recorded.')),
    ];
  },

  async cases() {
    const { cases } = await api('GET', { view: 'cases' });
    return [el('div', { class: 'card' }, el('h2', { text: 'Cases' }),
      cases.length ? table(['Priority', 'Category', 'Risk', 'Status', 'Summary', 'Channel', 'Received', ''], cases.map((k) => el('tr', {},
        el('td', { text: String(k.priority) }), el('td', { text: k.category }), el('td', {}, pill(k.risk_level, statusKind(k.risk_level))),
        el('td', {}, pill(k.status, statusKind(k.status))), el('td', { text: k.summary }), el('td', { text: k.provider }), el('td', { text: fmt(k.created_at) }),
        el('td', {}, el('button', { class: 'act secondary', onclick: () => openCase(k.id) }, 'Open'))))) : el('p', { class: 'muted', text: 'No cases.' }))];
  },

  async publishing() {
    const [{ calendar }, { publications }] = await Promise.all([api('GET', { view: 'calendar' }), api('GET', { view: 'publications' })]);
    return [
      el('div', { class: 'card' }, el('h2', { text: 'Editorial calendar' }),
        table(['Date', 'Slot', 'Category', 'Topic', 'Status', 'Content gates', ''], calendar.map((c) => {
          const failed = (c.content?.gate_results || []).filter((g) => g.result === 'fail').map((g) => g.name);
          return el('tr', {}, el('td', { text: String(c.planned_date).slice(0, 10) }), el('td', { text: c.planned_slot }), el('td', { text: c.category }), el('td', { text: c.topic }),
            el('td', {}, pill(c.status, statusKind(c.status)), c.status_reason ? el('div', { class: 'muted', text: c.status_reason }) : ''),
            el('td', {}, c.content ? [pill(c.content.publishability, statusKind(c.content.publishability)), failed.length ? el('div', { class: 'muted', text: `failed: ${failed.join(', ')}` }) : ''] : ''),
            el('td', {}, el('button', { class: 'act secondary', onclick: () => openSlot(c) }, 'Review'),
              !['published', 'cancelled'].includes(c.status) ? el('button', { class: 'act secondary', onclick: () => { if (confirm('Cancel this slot?')) act({ action: 'calendar_cancel', id: c.id }); } }, 'Cancel') : ''));
        }))),
      el('div', { class: 'card' }, el('h2', { text: 'Publications' }),
        table(['Date', 'Slot', 'Channel', 'Status', 'Post', 'Metrics', ''], publications.map((p) => el('tr', {},
          el('td', { text: String(p.scheduled_local_date).slice(0, 10) }), el('td', { text: p.scheduled_slot }), el('td', { text: `${p.account_label} (${p.provider})` }),
          el('td', {}, pill(p.publication_status, statusKind(p.publication_status)), p.status_reason ? el('div', { class: 'muted', text: p.status_reason }) : ''),
          el('td', {}, p.provider_post_url ? el('a', { href: p.provider_post_url, target: '_blank', rel: 'noopener', text: 'open' }) : ''),
          el('td', { text: p.metrics ? (p.metrics.metrics_available ? `views ${p.metrics.impressions ?? 'n/a'}, reactions ${p.metrics.reactions ?? 'n/a'}, comments ${p.metrics.comments ?? 'n/a'}` : `unavailable (${p.metrics.unavailable_reason})`) : '' }),
          el('td', {},
            p.publication_status === 'failed' ? el('button', { class: 'act secondary', onclick: () => act({ action: 'publication_retry', id: p.id }) }, 'Retry') : '',
            p.publication_status === 'unknown' ? el('button', { class: 'act secondary', onclick: () => { const url = prompt('If the post exists, paste its URL. Leave empty if it was NOT published.'); act({ action: 'publication_mark_reconciled', id: p.id, outcome: url ? 'published' : 'not_published', url: url || undefined }); } }, 'Reconcile') : '',
            ['scheduled', 'needs_review', 'failed'].includes(p.publication_status) ? el('button', { class: 'act secondary', onclick: () => act({ action: 'publication_cancel', id: p.id }) }, 'Cancel') : ''))))),
    ];
  },

  async faq() {
    const { faq } = await api('GET', { view: 'faq' });
    return [el('div', { class: 'card' }, el('h2', { text: 'Approved FAQ library' }),
      el('p', { class: 'muted', text: 'Only active, approved, unexpired, non-political templates can be sent automatically. Any edit revokes approval.' }),
      el('button', { class: 'act', onclick: () => editFaq({}) }, 'New FAQ'),
      table(['Slug', 'Lang', 'Question', 'Status', 'Expires', 'Channels', ''], faq.map((f) => el('tr', {},
        el('td', { text: f.slug }), el('td', { text: f.language }), el('td', { text: f.canonical_question }),
        el('td', {}, f.active ? pill('active', 'ok') : pill('inactive', 'warn')), el('td', { text: fmt(f.expires_at) }), el('td', { text: (f.allowed_channels || []).join(', ') }),
        el('td', {}, el('button', { class: 'act secondary', onclick: () => editFaq(f) }, 'Edit'),
          !f.active ? el('button', { class: 'act', onclick: () => approveFaq(f) }, 'Approve') : el('button', { class: 'act secondary', onclick: () => act({ action: 'faq_deactivate', id: f.id }) }, 'Deactivate'))))))];
  },

  async sources() {
    const { sources } = await api('GET', { view: 'sources' });
    return [el('div', { class: 'card' }, el('h2', { text: 'Approved source registry' }),
      el('p', { class: 'muted', text: 'Open each URL yourself and confirm it is the official, current page before verifying. Verification expires.' }),
      table(['Source', 'Class', 'Status', 'Verified', 'Review by', ''], sources.map((s) => el('tr', {},
        el('td', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.title })), el('td', { text: s.source_class }),
        el('td', {}, s.active ? pill('active', 'ok') : pill('inactive', 'warn')), el('td', { text: fmt(s.verified_at) }), el('td', { text: fmt(s.review_by) }),
        el('td', {}, el('button', { class: 'act secondary', onclick: () => { if (confirm(`Have you opened ${s.url} and checked it is the official, current page?`)) act({ action: 'source_verify', id: s.id, confirm: 'I OPENED AND CHECKED THIS URL' }); } }, 'Verify'),
          s.active ? el('button', { class: 'act secondary', onclick: () => act({ action: 'source_deactivate', id: s.id }) }, 'Deactivate') : '')))))];
  },

  async channels() {
    const { channels } = await api('GET', { view: 'channels' });
    const toggle = (c, key) => el('button', { class: 'act secondary', onclick: () => act({ action: 'channel_update', id: c.id, [key]: !c[key] }) }, `${key.replace(/_/g, ' ')}: ${c[key] ? 'on' : 'off'}`);
    return [el('div', { class: 'card' }, el('h2', { text: 'Connected channels' }),
      channels.length ? table(['Channel', 'Connection', 'Token', 'Permissions', 'Controls'], channels.map((c) => el('tr', {},
        el('td', { text: `${c.account_label} (${c.provider} ${c.external_account_id})` }),
        el('td', {}, pill(c.connection_status, statusKind(c.connection_status))), el('td', {}, pill(c.token_status, statusKind(c.token_status)), el('div', { class: 'muted', text: fmt(c.token_checked_at) })),
        el('td', { text: (c.permissions_verified || []).join(', ') || 'none verified' }),
        el('td', {}, toggle(c, 'paused'), toggle(c, 'ingest_enabled'), toggle(c, 'publishing_enabled'), toggle(c, 'auto_reply_enabled'),
          c.provider !== 'forum' ? el('button', { class: 'act secondary', onclick: () => act({ action: 'channel_verify', id: c.id }, 'Verification recorded.') }, 'Verify token') : '')))) : el('p', { class: 'muted', text: 'No channels configured. See docs/COMMUNITY_AGENT_OPERATIONS.md.' }))];
  },

  async failures() {
    const f = await api('GET', { view: 'failures' });
    return [
      el('div', { class: 'card' }, el('h2', { text: 'Failed or dead-lettered events' }), table(['Received', 'Type', 'Status', 'Attempts', 'Error', ''], f.events.map((e) => el('tr', {},
        el('td', { text: fmt(e.received_at) }), el('td', { text: e.event_type }), el('td', {}, pill(e.processing_status, 'bad')), el('td', { text: String(e.attempt_count) }), el('td', { text: e.last_error_code || '' }),
        el('td', {}, el('button', { class: 'act secondary', onclick: () => act({ action: 'event_requeue', id: e.id }) }, 'Requeue')))))),
      el('div', { class: 'card' }, el('h2', { text: 'Replies' }), table(['Updated', 'Status', 'Reason', 'Error', ''], f.actions.map((a) => el('tr', {},
        el('td', { text: fmt(a.updated_at) }), el('td', {}, pill(a.execution_status, statusKind(a.execution_status))), el('td', { text: a.status_reason || '' }), el('td', { text: a.error_code || '' }),
        el('td', {}, ['failed', 'blocked'].includes(a.execution_status) ? el('button', { class: 'act secondary', onclick: () => act({ action: 'action_requeue', id: a.id }) }, 'Requeue') : ''))))),
      el('div', { class: 'card' }, el('h2', { text: 'Publications' }), table(['Date', 'Slot', 'Status', 'Reason', 'Error'], f.publications.map((p) => el('tr', {},
        el('td', { text: String(p.scheduled_local_date).slice(0, 10) }), el('td', { text: p.scheduled_slot }), el('td', {}, pill(p.publication_status, statusKind(p.publication_status))), el('td', { text: p.status_reason || '' }), el('td', { text: p.error_code || '' }))))),
    ];
  },

  async audit() {
    const { audit } = await api('GET', { view: 'audit' });
    return [el('div', { class: 'card' }, el('h2', { text: 'Audit history' }), table(['When', 'Actor', 'Action', 'Entity', 'Detail'], audit.map((a) => el('tr', {},
      el('td', { text: fmt(a.at) }), el('td', { text: `${a.actor_type}${a.actor_id ? ` ${a.actor_id.slice(0, 8)}` : ''}` }), el('td', { text: a.action }),
      el('td', { text: `${a.entity_type} ${a.entity_id ? a.entity_id.slice(0, 8) : ''}` }), el('td', {}, el('pre', { text: JSON.stringify(a.detail, null, 1) }))))))];
  },

  async digests() {
    const [{ digests }, preview] = await Promise.all([api('GET', { view: 'digests' }), api('GET', { view: 'digest_preview' })]);
    return [el('div', { class: 'card' }, el('h2', { text: "Preview: today's activity so far" }), el('pre', { text: preview.body })),
      el('div', { class: 'card' }, el('h2', { text: 'Generated digests and alerts' }), table(['Kind', 'Period', 'Status', 'Generated', 'Body'], digests.map((d) => el('tr', {},
        el('td', { text: d.kind }), el('td', { text: d.period_key }), el('td', {}, pill(d.status, statusKind(d.status))), el('td', { text: fmt(d.generated_at) }),
        el('td', {}, el('details', {}, el('summary', { text: d.subject || 'view' }), el('pre', { text: d.body_text || '' }))))))) ];
  },

  async external() {
    const { notes } = await api('GET', { view: 'external_notes' });
    const label = el('input', { placeholder: 'Group or page name' });
    const url = el('input', { placeholder: 'https://... (optional)' });
    const summary = el('textarea', { placeholder: 'Neutral summary of the discussion. No names or personal data.' });
    const follow = el('select', {}, ['none', 'faq_candidate', 'editorial_candidate', 'escalate'].map((v) => el('option', { value: v, text: v })));
    return [el('div', { class: 'card' }, el('h2', { text: 'Manual review of external discussions' }),
      el('p', { class: 'muted', text: 'Third-party Facebook groups are not monitored or posted to automatically. Record relevant discussions here after reading them yourself.' }),
      el('label', { text: 'Source' }), label, el('label', { text: 'Link' }), url, el('label', { text: 'Summary' }), summary, el('label', { text: 'Follow-up' }), follow,
      el('p', {}, el('button', { class: 'act', onclick: () => act({ action: 'external_note_create', source_label: label.value, source_url: url.value || undefined, summary: summary.value, follow_up: follow.value }) }, 'Save note')),
      table(['When', 'Source', 'Summary', 'Follow-up'], notes.map((n) => el('tr', {}, el('td', { text: fmt(n.created_at) }), el('td', { text: n.source_label }), el('td', { text: n.summary }), el('td', { text: n.follow_up || '' })))))];
  },

  async settings() {
    const o = await api('GET', { view: 'overview' });
    const p = o.settings.publishing;
    const morning = el('input', { type: 'time', value: p.morning_publish_time });
    const evening = el('input', { type: 'time', value: p.evening_publish_time });
    const cats = el('div', {}, (await api('GET', { view: 'calendar' })).categories.map((c) => el('label', { style: 'font-weight:400' },
      el('input', { type: 'checkbox', value: c, style: 'width:auto', checked: p.permitted_content_categories.includes(c) }), ` ${c}`)));
    const modSel = el('select', {}, ['DISABLED', 'SHADOW', 'SUPERVISED'].map((m) => el('option', { value: m, text: m, selected: o.settings.moderation.mode === m })));
    const pubSel = el('select', {}, ['DISABLED', 'SHADOW', 'AUTONOMOUS'].map((m) => el('option', { value: m, text: m, selected: p.mode === m })));
    return [
      el('div', { class: 'card' }, el('h2', { text: 'Publishing schedule and categories' }),
        el('div', { class: 'grid' }, el('div', {}, el('label', { text: 'Morning (Europe/Madrid)' }), morning), el('div', {}, el('label', { text: 'Evening (Europe/Madrid)' }), evening)),
        el('label', { text: 'Categories allowed for publication' }), cats,
        el('p', {}, el('button', { class: 'act', onclick: () => act({ action: 'set_publishing', morning_publish_time: morning.value, evening_publish_time: evening.value, permitted_content_categories: [...cats.querySelectorAll('input:checked')].map((i) => i.value) }) }, 'Save schedule'))),
      el('div', { class: 'card' }, el('h2', { text: 'Operating modes' }),
        el('p', { class: 'muted', text: 'SUPERVISED moderation and AUTONOMOUS publishing are refused unless the deployment has been explicitly authorised for them, and require a typed confirmation.' }),
        el('label', { text: 'Community moderation' }), modSel,
        el('p', {}, el('button', { class: 'act secondary', onclick: () => { const body = { action: 'set_moderation_mode', mode: modSel.value }; if (modSel.value === 'SUPERVISED') body.confirm = prompt('Type ENABLE SUPERVISED MODERATION to confirm'); act(body); } }, 'Apply moderation mode')),
        el('label', { text: 'Scheduled editorial publishing' }), pubSel,
        el('p', {}, el('button', { class: 'act secondary', onclick: () => { const body = { action: 'set_publishing', mode: pubSel.value }; if (pubSel.value === 'AUTONOMOUS') body.confirm = prompt('Type ENABLE AUTONOMOUS PUBLISHING to confirm'); act(body); } }, 'Apply publishing mode'))),
      el('div', { class: 'card' }, el('h2', { text: 'Limits' }), el('pre', { text: JSON.stringify(o.settings.limits, null, 2) }), el('p', { class: 'muted', text: 'Change limits through the API action set_limits; see the operations guide.' })),
    ];
  },
};

// --------------------------------------------------------------- dialogs
async function openCase(id) {
  const d = await api('GET', { view: 'case', id });
  const k = d.case;
  const latest = d.drafts[0];
  const editor = el('textarea', {}, latest ? latest.proposed_answer : '');
  const view = $('view');
  view.replaceChildren(
    el('p', {}, el('button', { class: 'act secondary', onclick: () => render() }, 'Back to cases')),
    el('div', { class: 'card' },
      el('h2', { text: `Case: ${k.category}` }),
      el('p', {}, pill(k.risk_level, statusKind(k.risk_level)), pill(k.status, statusKind(k.status)), ` ${k.provider} ${k.account_label}`),
      el('p', { text: k.summary }),
      k.content_purged_at ? el('p', { class: 'muted', text: 'Original text removed under the retention policy.' }) : el('div', { class: 'excerpt', text: k.content_excerpt || '' }),
      k.permalink ? el('p', {}, el('a', { href: k.permalink, target: '_blank', rel: 'noopener', text: 'Open on the platform' })) : '',
      el('details', {}, el('summary', { text: 'Classification detail' }), el('pre', { text: JSON.stringify(k.classification, null, 1) }))),
    el('div', { class: 'card' },
      el('h2', { text: latest ? `Suggested reply (version ${latest.version}, ${latest.origin})` : 'No draft' }),
      latest ? [
        el('p', {}, pill(latest.status, statusKind(latest.status)), pill(`validation ${latest.validation_state}`, statusKind(latest.validation_state)),
          (latest.validation_notes || []).map((n) => pill(n, 'bad'))),
        (latest.source_references || []).length ? el('p', {}, 'Sources: ', latest.source_references.map((s) => el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.title || s.url }))) : '',
        el('label', { text: 'Reply text (editing creates a new version that needs its own approval)' }), editor,
        el('div', { class: 'row' },
          latest.status === 'proposed' ? el('button', { class: 'act', onclick: async () => {
            if (editor.value !== latest.proposed_answer) { setStatus('Text changed: save as a new version first, then approve it.', true); return; }
            if (confirm('Approve exactly this text for publication as a reply?')) { await act({ action: 'draft_approve', draft_id: latest.id, fingerprint: latest.content_fingerprint }, 'Approved. The executor re-checks every guardrail before sending.'); }
          } }, 'Approve') : '',
          el('button', { class: 'act secondary', onclick: () => act({ action: 'draft_edit', case_id: k.id, text: editor.value, based_on_fingerprint: latest.content_fingerprint }, 'New version saved; review and approve it.').then(() => openCase(id)) }, 'Save as new version'),
          latest.status === 'proposed' ? el('button', { class: 'act secondary', onclick: () => { const r = prompt('Reason for rejecting'); if (r) act({ action: 'draft_reject', draft_id: latest.id, reason: r }); } }, 'Reject') : ''),
      ] : '',
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'act secondary', onclick: () => act({ action: 'case_update', id: k.id, status: 'escalated' }) }, 'Escalate'),
        el('button', { class: 'act secondary', onclick: () => act({ action: 'case_update', id: k.id, status: 'resolved' }) }, 'Mark resolved'),
        el('button', { class: 'act secondary', onclick: () => act({ action: 'case_update', id: k.id, status: 'dismissed' }) }, 'Dismiss'),
        el('button', { class: 'act secondary', onclick: () => { if (confirm('Redact the stored text of this item (data request)?')) act({ action: 'redact_event_content', event_id: k.event_id, reason: 'data subject request' }); } }, 'Redact stored text'))),
    el('div', { class: 'card' }, el('h2', { text: 'History' }), table(['When', 'Actor', 'Action'], d.history.map((h) => el('tr', {}, el('td', { text: fmt(h.at) }), el('td', { text: h.actor_type }), el('td', { text: h.action }))))),
  );
}

function openSlot(c) {
  const content = c.content?.canonical_content || {};
  const fields = Object.fromEntries(['title', 'body', 'facebook_text', 'instagram_caption', 'es_summary', 'ca_summary'].map((f) => [f, el(f === 'title' ? 'input' : 'textarea', { value: content[f] || '' })]));
  for (const [f, n] of Object.entries(fields)) if (n.tagName === 'TEXTAREA') n.value = content[f] || '';
  $('view').replaceChildren(
    el('p', {}, el('button', { class: 'act secondary', onclick: () => render() }, 'Back')),
    el('div', { class: 'card' }, el('h2', { text: `${String(c.planned_date).slice(0, 10)} ${c.planned_slot}: ${c.topic}` }),
      c.content ? [el('h3', { text: 'Quality gates' }), table(['Gate', 'Result', 'Detail'], (c.content.gate_results || []).map((g) => el('tr', {}, el('td', { text: g.name }), el('td', {}, pill(g.result, g.result === 'pass' ? 'ok' : 'bad')), el('td', { text: g.detail ? JSON.stringify(g.detail) : '' })))),
        el('h3', { text: 'Sources' }), (c.content.source_references || []).map((s) => el('p', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.title || s.url }), ` retrieved ${fmt(s.retrieved_at)}`)),
        el('h3', { text: 'Claims' }), el('pre', { text: JSON.stringify(content.claims || [], null, 1) })] : el('p', { class: 'muted', text: 'No content generated yet.' })),
    el('div', { class: 'card' }, el('h2', { text: 'Replace with human-written content' }),
      el('p', { class: 'muted', text: 'Human content runs through the same gates. Factual claims in manual posts are not source-checked automatically, so keep them to platform information or questions.' }),
      Object.entries(fields).map(([f, n]) => [el('label', { text: f.replace(/_/g, ' ') }), n]),
      el('p', {}, el('button', { class: 'act', onclick: () => act({ action: 'content_replace', calendar_id: c.id, approve: true, ...Object.fromEntries(Object.entries(fields).map(([f, n]) => [f, n.value])) }, 'Content saved and validated.') }, 'Validate, approve and schedule'))),
  );
}

function editFaq(f) {
  const inputs = {
    slug: el('input', { value: f.slug || '' }), language: el('select', {}, ['en', 'es', 'ca'].map((l) => el('option', { value: l, text: l, selected: f.language === l }))),
    canonical_question: el('input', { value: f.canonical_question || '' }), match_phrases: el('textarea', {}), approved_answer: el('textarea', {}),
    source_url: el('input', { value: f.source_url || '' }), expires_at: el('input', { type: 'date', value: f.expires_at ? String(f.expires_at).slice(0, 10) : '' }),
    allowed_channels: el('input', { value: (f.allowed_channels || []).join(',') || 'facebook_page' }), is_factual: el('input', { type: 'checkbox', style: 'width:auto', checked: Boolean(f.is_factual) }),
  };
  inputs.match_phrases.value = (f.match_phrases || []).join('\n');
  inputs.approved_answer.value = f.approved_answer || '';
  $('view').replaceChildren(el('p', {}, el('button', { class: 'act secondary', onclick: () => render() }, 'Back')),
    el('div', { class: 'card' }, el('h2', { text: f.id ? `Edit FAQ ${f.slug}` : 'New FAQ' }),
      el('p', { class: 'muted', text: 'Saving any change deactivates the FAQ until it is approved again. Never use this for voting, party, candidate or legal questions.' }),
      Object.entries(inputs).map(([k, n]) => [el('label', { text: k.replace(/_/g, ' ') }), n]),
      el('p', {}, el('button', { class: 'act', onclick: () => act({ action: 'faq_upsert', slug: inputs.slug.value, language: inputs.language.value, canonical_question: inputs.canonical_question.value,
        match_phrases: inputs.match_phrases.value.split('\n').map((s) => s.trim()).filter(Boolean), approved_answer: inputs.approved_answer.value, source_url: inputs.source_url.value || undefined,
        expires_at: inputs.expires_at.value || undefined, allowed_channels: inputs.allowed_channels.value.split(',').map((s) => s.trim()).filter(Boolean), is_factual: inputs.is_factual.checked }, 'FAQ saved (inactive until approved).') }, 'Save'))));
}

async function approveFaq(f) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`v1\n${String(f.approved_answer).replace(/\r\n?/g, '\n').trim()}`));
  const fingerprint = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  let verified;
  if (f.is_factual) {
    verified = prompt(`Date you verified ${f.source_url} (YYYY-MM-DD):`);
    if (!verified) return;
  }
  if (confirm(`Approve this exact answer for automatic use?\n\n${f.approved_answer}`)) {
    await act({ action: 'faq_approve', id: f.id, fingerprint, source_verified_at: verified }, 'FAQ approved.');
  }
}

async function render() {
  const view = $('view');
  try {
    view.replaceChildren(el('p', { class: 'muted', text: 'Loading...' }));
    view.replaceChildren(...(await RENDER[current]()));
  } catch (e) {
    if (e.message === 'not_moderator') {
      view.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'error', text: 'This account is not an active moderator.' })));
    } else if (e.message === 'signed_out' || e.message === 'invalid_token') {
      showLogin();
    } else {
      view.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'error', text: `Could not load: ${e.message}` })));
    }
  }
}

function buildTabs() {
  $('tabs').replaceChildren(...Object.entries(TABS).map(([k, label]) => el('button', { type: 'button', 'aria-selected': String(k === current), onclick: () => { current = k; buildTabs(); setStatus(''); render(); } }, label)));
}

function showLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('logout').classList.add('hidden');
  $('who').textContent = '';
}

async function showApp() {
  const { data } = await supabase.auth.getUser();
  if (!data.user) { showLogin(); return; }
  $('who').textContent = data.user.email || '';
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('logout').classList.remove('hidden');
  buildTabs();
  render();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginStatus').textContent = 'Signing in...';
  const { error } = await supabase.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  $('password').value = '';
  if (error) { $('loginStatus').textContent = 'Sign in failed.'; return; }
  $('loginStatus').textContent = '';
  showApp();
});
$('logout').addEventListener('click', async () => { await supabase.auth.signOut(); showLogin(); });

if (!cfg.url || !cfg.publishableKey) {
  $('loginStatus').textContent = 'Console not configured.';
} else {
  showApp();
}
