// Deterministic policy enforcement for every outbound operation.
// Pure functions: they receive fresh state and return { allowed, mode, reasons }.
// mode is 'live' (call the provider), 'simulate' (record only) or 'block'.

import { liveSwitches, HARD_LIMITS } from './config.js';
import { textFingerprint } from './crypto.js';
import { missingPermissions } from './adapters/index.js';

const REPLY_FORBIDDEN_CATEGORIES = new Set([
  'electoral_procedure', 'political_discussion', 'harassment', 'personal_information', 'threat_or_unlawful', 'spam',
]);

function liveFlagFor(provider, op) {
  const s = liveSwitches();
  if (provider === 'mock') return true;
  if (op === 'reply') return provider === 'facebook_page' || provider === 'instagram' ? s.metaReplies : false;
  if (op === 'publish') {
    if (provider === 'facebook_page') return s.metaPublishing;
    if (provider === 'instagram') return s.instagramPublishing;
  }
  return false;
}

function channelProblems(channel, op) {
  const reasons = [];
  if (!channel) return ['channel_missing'];
  if (channel.paused) reasons.push('channel_paused');
  if (channel.provider !== 'mock') {
    if (channel.connection_status !== 'verified') reasons.push('channel_unverified');
    if (channel.token_status !== 'valid') reasons.push(`token_${channel.token_status || 'unknown'}`);
    const missing = missingPermissions(channel, op);
    if (missing.length) reasons.push(`missing_permissions:${missing.join(',')}`);
  }
  if (op === 'reply' && !(channel.capabilities && channel.capabilities.reply === true)) reasons.push('capability_reply_off');
  if (op === 'publish' && !(channel.capabilities && channel.capabilities.publish === true)) reasons.push('capability_publish_off');
  return reasons;
}

// Reply to an inbound comment (FAQ auto-reply or human-approved draft).
export function authorizeReply({ settings, channel, action, draft, caseRow, now = new Date(), succeededForTarget = false, approvalMaxAgeHours = 72 }) {
  const reasons = [];
  if (settings?.emergency_stop?.active) return { allowed: false, mode: 'block', reasons: ['emergency_stop'] };
  const moderationMode = settings?.moderation?.mode;
  if (moderationMode === 'DISABLED') return { allowed: false, mode: 'block', reasons: ['moderation_disabled'] };
  if (succeededForTarget) return { allowed: false, mode: 'block', reasons: ['already_replied'] };
  // A dismissed or escalated case revokes queued approval, including cases
  // dismissed after a reply action was already created.
  if (caseRow && ['dismissed', 'escalated'].includes(caseRow.status)) reasons.push('case_no_longer_replyable');

  if (!draft || !['approved'].includes(draft.status)) reasons.push('draft_not_approved');
  if (draft) {
    const fp = textFingerprint(action.payload_text);
    if (fp !== action.payload_fingerprint) reasons.push('payload_fingerprint_mismatch');
    if (draft.content_fingerprint !== fp || draft.approved_fingerprint !== fp) reasons.push('approved_text_changed');
    if (!draft.approved_at || (now - new Date(draft.approved_at)) / 3600000 > approvalMaxAgeHours) {
      if (draft.origin !== 'faq') reasons.push('approval_stale');
    }
  }
  if (action.actor_type === 'system') {
    // Automatic replies: exact approved FAQ only, on low-risk, allowed categories.
    if (!draft || draft.origin !== 'faq') reasons.push('system_reply_not_faq');
    if (!settings?.moderation?.auto_reply_enabled) reasons.push('auto_reply_disabled');
    if (!channel?.auto_reply_enabled) reasons.push('channel_auto_reply_disabled');
    if (caseRow && (caseRow.risk_level !== 'low' || REPLY_FORBIDDEN_CATEGORIES.has(caseRow.category))) reasons.push('case_not_low_risk');
  }
  reasons.push(...channelProblems(channel, 'reply'));
  if (action.attempt_count > (settings?.limits?.max_attempts ?? 5) || action.attempt_count > HARD_LIMITS.maxAttempts) reasons.push('max_attempts');

  if (reasons.length) return { allowed: false, mode: 'block', reasons };
  if (moderationMode !== 'SUPERVISED') return { allowed: true, mode: 'simulate', reasons: ['shadow_mode'] };
  if (!liveFlagFor(channel.provider, 'reply')) return { allowed: true, mode: 'simulate', reasons: ['live_switch_off'] };
  return { allowed: true, mode: 'live', reasons: [] };
}

// Scheduled editorial publication.
export function authorizePublication({ settings, channel, publication, content, calendar, now = new Date(), publishedToday = 0, mediaCheck = null }) {
  const pub = settings?.publishing || {};
  if (settings?.emergency_stop?.active) return { allowed: false, mode: 'block', terminal: false, reasons: ['emergency_stop'] };
  if (pub.mode === 'DISABLED') return { allowed: false, mode: 'block', terminal: true, reasons: ['publishing_disabled'] };

  const windowMin = Math.min(Math.max(Number(pub.publish_window_minutes) || 45, 5), 180);
  const due = new Date(publication.scheduled_at);
  if (now < due) return { allowed: false, mode: 'block', terminal: false, reasons: ['not_due'] };
  if ((now - due) / 60000 > windowMin) return { allowed: false, mode: 'block', terminal: true, reasons: ['window_expired'] };

  const reasons = [];
  if (!content || content.publishability !== 'publishable') reasons.push('content_not_publishable');
  if (content?.superseded) reasons.push('content_superseded');
  if (content && content.factual_verification_status === 'failed') reasons.push('factual_verification_failed');
  if (content && content.neutrality_validation_status !== 'passed') reasons.push('neutrality_failed');
  if (content && content.duplication_status !== 'unique') reasons.push('duplicate_content');
  if (textFingerprint(publication.platform_text) !== publication.text_fingerprint) reasons.push('text_changed_after_validation');
  const permitted = Array.isArray(pub.permitted_content_categories) ? pub.permitted_content_categories : [];
  if (calendar && !permitted.includes(calendar.category)) reasons.push('category_disabled');
  if (!channel?.publishing_enabled) reasons.push('channel_publishing_disabled');
  reasons.push(...channelProblems(channel, 'publish'));
  const limit = Math.min(Number(pub.daily_post_limit) || 0, Number(channel?.max_posts_per_day ?? 2), HARD_LIMITS.maxPostsPerChannelPerDay);
  if (publishedToday >= limit) reasons.push('daily_limit_reached');
  if (channel?.provider === 'instagram') {
    if (!publication.media_reference) reasons.push('media_required');
    else if (mediaCheck && !mediaCheck.ok) reasons.push(`media_invalid:${mediaCheck.reason}`);
  }
  if (reasons.length) return { allowed: false, mode: 'block', terminal: true, reasons };

  if (pub.mode !== 'AUTONOMOUS' || pub.autonomous_publishing_enabled !== true) return { allowed: true, mode: 'simulate', terminal: true, reasons: ['shadow_mode'] };
  if (!liveFlagFor(channel.provider, 'publish')) return { allowed: true, mode: 'simulate', terminal: true, reasons: ['live_switch_off'] };
  return { allowed: true, mode: 'live', terminal: true, reasons: [] };
}

export { REPLY_FORBIDDEN_CATEGORIES };
