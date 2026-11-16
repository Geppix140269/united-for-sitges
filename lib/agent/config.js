// Server-side configuration. Never import this file from browser code.
// Secrets are read from process.env at call time and never logged.

export const MODERATION_MODES = Object.freeze(['DISABLED', 'SHADOW', 'SUPERVISED']);
export const PUBLISHING_MODES = Object.freeze(['DISABLED', 'SHADOW', 'AUTONOMOUS']);

export const CASE_CATEGORIES = Object.freeze([
  'platform_info', 'approved_faq', 'civic_information', 'electoral_procedure', 'political_discussion',
  'community_feedback', 'complaint', 'spam', 'harassment', 'personal_information', 'threat_or_unlawful', 'unclear',
]);

export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

export const EDITORIAL_CATEGORIES = Object.freeze([
  'civic_information', 'local_government', 'electoral_resources', 'urban_planning', 'mobility', 'tourism',
  'local_economy', 'community_wellbeing', 'environment', 'international_integration', 'platform_updates',
  'community_questions',
]);

export const LANGUAGES = Object.freeze(['en', 'es', 'ca']);

// Hard ceilings that settings cannot raise.
export const HARD_LIMITS = Object.freeze({
  maxWebhookBodyBytes: 256 * 1024,
  maxEntriesPerWebhook: 50,
  maxChangesPerEntry: 50,
  maxExcerptChars: 2000,
  maxAttempts: 8,
  maxPostsPerChannelPerDay: 2,
  leaseSeconds: 120,
});

export function env(name, { required = false } = {}) {
  const value = process.env[name];
  if (required && (!value || !value.trim())) {
    const err = new Error(`Missing required server configuration: ${name}`);
    err.code = 'config_missing';
    throw err;
  }
  return value && value.trim() ? value.trim() : undefined;
}

export function boolEnv(name) {
  return /^(1|true|yes)$/i.test(process.env[name] || '');
}

// Build-time master switches. Even if database settings say otherwise, live
// outbound calls require the matching environment flag to be explicitly set.
// Defaults are all OFF, so a fresh deployment can never publish.
export function liveSwitches() {
  return Object.freeze({
    metaReplies: boolEnv('AGENT_LIVE_META_REPLIES'),
    metaPublishing: boolEnv('AGENT_LIVE_META_PUBLISHING'),
    instagramPublishing: boolEnv('AGENT_LIVE_INSTAGRAM_PUBLISHING'),
    email: boolEnv('AGENT_LIVE_EMAIL'),
    llm: boolEnv('AGENT_LLM_ENABLED'),
  });
}

export function resolveCredential(ref) {
  if (!ref || typeof ref !== 'string') return undefined;
  const m = /^env:([A-Z][A-Z0-9_]{2,63})$/.exec(ref);
  if (!m) return undefined;
  return env(m[1]);
}
