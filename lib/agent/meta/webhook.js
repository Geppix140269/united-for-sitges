// Meta Page/Instagram webhook payload parsing.
// Treats every field as untrusted input: validates shape and bounds, keeps
// only what review needs, and never interprets text as instructions.

import { HARD_LIMITS } from '../config.js';
import { sha256Hex, authorRef } from '../crypto.js';

const ID_RE = /^[0-9_]{1,64}$/;

export class WebhookPayloadError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid_payload';
  }
}

function excerpt(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return clean ? clean.slice(0, HARD_LIMITS.maxExcerptChars) : null;
}

function verbToType(verb) {
  if (verb === 'add') return 'comment_added';
  if (verb === 'edited' || verb === 'edit') return 'comment_edited';
  if (verb === 'remove' || verb === 'delete' || verb === 'hide') return 'comment_removed';
  return null;
}

// Returns { events: NormalisedEvent[], ignored: number }.
export function parseMetaWebhook(body, { pepper } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WebhookPayloadError('Body must be an object');
  if (body.object !== 'page' && body.object !== 'instagram') throw new WebhookPayloadError('Unsupported object');
  if (!Array.isArray(body.entry) || body.entry.length === 0) throw new WebhookPayloadError('Missing entry');
  if (body.entry.length > HARD_LIMITS.maxEntriesPerWebhook) throw new WebhookPayloadError('Too many entries');

  const provider = body.object === 'page' ? 'facebook_page' : 'instagram';
  const events = [];
  let ignored = 0;

  for (const entry of body.entry) {
    if (!entry || typeof entry !== 'object') throw new WebhookPayloadError('Bad entry');
    const accountId = String(entry.id ?? '');
    if (!ID_RE.test(accountId)) throw new WebhookPayloadError('Bad entry id');
    const changes = entry.changes;
    if (!Array.isArray(changes)) { ignored += 1; continue; }
    if (changes.length > HARD_LIMITS.maxChangesPerEntry) throw new WebhookPayloadError('Too many changes');

    for (const change of changes) {
      if (!change || typeof change !== 'object' || typeof change.field !== 'string') throw new WebhookPayloadError('Bad change');
      const v = change.value;
      if (!v || typeof v !== 'object') throw new WebhookPayloadError('Bad change value');

      if (provider === 'facebook_page') {
        if (change.field !== 'feed' || v.item !== 'comment') { ignored += 1; continue; }
        const type = verbToType(v.verb);
        const commentId = String(v.comment_id ?? '');
        if (!type || !ID_RE.test(commentId)) { ignored += 1; continue; }
        const fromId = v.from && typeof v.from === 'object' ? String(v.from.id ?? '') : '';
        const canonical = JSON.stringify({ p: provider, a: accountId, c: commentId, t: type, m: v.message ?? null, ct: v.created_time ?? null });
        events.push({
          provider,
          externalAccountId: accountId,
          eventType: type,
          externalObjectId: commentId,
          externalParentId: ID_RE.test(String(v.parent_id ?? '')) ? String(v.parent_id) : (ID_RE.test(String(v.post_id ?? '')) ? String(v.post_id) : null),
          contentExcerpt: type === 'comment_removed' ? null : excerpt(v.message),
          authorRef: ID_RE.test(fromId) ? authorRef(provider, fromId, pepper) : null,
          authorIsPage: fromId === accountId,
          // Edited comments get their own key so the new text is reviewed.
          idempotencyKey: `${provider}:${accountId}:${commentId}:${type}:${sha256Hex(canonical).slice(0, 16)}`,
          payloadChecksum: sha256Hex(canonical),
        });
      } else {
        if (change.field !== 'comments' && change.field !== 'live_comments') { ignored += 1; continue; }
        const commentId = String(v.id ?? '');
        if (!ID_RE.test(commentId)) { ignored += 1; continue; }
        const fromId = v.from && typeof v.from === 'object' ? String(v.from.id ?? '') : '';
        const mediaId = v.media && typeof v.media === 'object' ? String(v.media.id ?? '') : '';
        const canonical = JSON.stringify({ p: provider, a: accountId, c: commentId, t: v.text ?? null });
        events.push({
          provider,
          externalAccountId: accountId,
          eventType: 'comment_added',
          externalObjectId: commentId,
          externalParentId: ID_RE.test(String(v.parent_id ?? '')) ? String(v.parent_id) : (ID_RE.test(mediaId) ? mediaId : null),
          contentExcerpt: excerpt(v.text),
          authorRef: ID_RE.test(fromId) ? authorRef(provider, fromId, pepper) : null,
          authorIsPage: fromId === accountId,
          idempotencyKey: `${provider}:${accountId}:${commentId}:comment_added:${sha256Hex(canonical).slice(0, 16)}`,
          payloadChecksum: sha256Hex(canonical),
        });
      }
    }
  }
  return { events, ignored };
}
