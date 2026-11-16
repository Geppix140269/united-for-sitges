import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveSwitches } from '../../../lib/agent/config.js';
import { authorizeReply, authorizePublication } from '../../../lib/agent/policy.js';
import { textFingerprint } from '../../../lib/agent/crypto.js';

const LIVE_VARS = ['AGENT_LIVE_META_REPLIES', 'AGENT_LIVE_META_PUBLISHING', 'AGENT_LIVE_INSTAGRAM_PUBLISHING', 'AGENT_LIVE_EMAIL', 'AGENT_LLM_ENABLED', 'AGENT_ALLOW_SUPERVISED', 'AGENT_ALLOW_AUTONOMOUS'];

test('every live switch is OFF when no environment is configured', () => {
  const saved = Object.fromEntries(LIVE_VARS.map((k) => [k, process.env[k]]));
  for (const k of LIVE_VARS) delete process.env[k];
  try {
    assert.deepEqual(liveSwitches(), { metaReplies: false, metaPublishing: false, instagramPublishing: false, email: false, llm: false });
    // Only an explicit true-like value turns a switch on.
    process.env.AGENT_LIVE_META_PUBLISHING = 'yes please';
    assert.equal(liveSwitches().metaPublishing, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('even fully authorised settings only simulate while the env live switches are off', () => {
  for (const k of LIVE_VARS) delete process.env[k];
  const now = new Date('2026-11-16T08:05:00Z');
  const fbPerms = ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement', 'pages_manage_posts'];
  const fb = { provider: 'facebook_page', paused: false, connection_status: 'verified', token_status: 'valid', capabilities: { reply: true, publish: true }, auto_reply_enabled: true, publishing_enabled: true, max_posts_per_day: 2, permissions_verified: fbPerms };
  const ig = { ...fb, provider: 'instagram', permissions_verified: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments'] };
  const text = 'Approved';
  const draft = { status: 'approved', origin: 'faq', content_fingerprint: textFingerprint(text), approved_fingerprint: textFingerprint(text), approved_at: now.toISOString() };
  const action = { actor_type: 'system', payload_text: text, payload_fingerprint: textFingerprint(text), attempt_count: 1 };
  const reply = authorizeReply({ settings: { moderation: { mode: 'SUPERVISED', auto_reply_enabled: true }, emergency_stop: { active: false } }, channel: fb, action, draft, caseRow: { risk_level: 'low', category: 'approved_faq' }, now });
  assert.equal(reply.mode, 'simulate');
  const settings = { publishing: { mode: 'AUTONOMOUS', autonomous_publishing_enabled: true, daily_post_limit: 2, permitted_content_categories: ['civic_information'] }, emergency_stop: { active: false } };
  const content = { publishability: 'publishable', factual_verification_status: 'passed', neutrality_validation_status: 'passed', duplication_status: 'unique' };
  for (const channel of [fb, ig]) {
    const pub = { scheduled_at: '2026-11-16T08:00:00Z', platform_text: 't', text_fingerprint: textFingerprint('t'), media_reference: 'https://unitedforsitges.com/assets/agent/cards/mobility.jpg' };
    const d = authorizePublication({ settings, channel, publication: pub, content, calendar: { category: 'civic_information' }, now, publishedToday: 0, mediaCheck: { ok: true } });
    assert.equal(d.mode, 'simulate', channel.provider);
    assert.deepEqual(d.reasons, ['live_switch_off']);
  }
});
