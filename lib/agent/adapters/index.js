// Provider adapter registry. Every adapter implements the same interface and
// declares its capabilities. Only the deterministic executor and publisher
// call write methods, and only after policy checks pass.
//
// Interface:
//   describe() -> { provider, account, supportedMediaTypes, permissionsRequired,
//                   operations, maxPostsPerDay, mediaRequirements }
//   verifyToken() -> { valid, scopes[], expiresAt|null, accountId }
//   getComment(id) -> { exists }
//   findOwnReply(commentId) -> replyId|null
//   replyToComment(commentId, text) -> { id }
//   findRecentPost(text) -> { id, url }|null
//   publishPost({ text, link, mediaUrl, containerId }) -> { id, url } | { pending: true, containerId }
//   getPostMetrics(postId) -> { available, impressions, reach, reactions, comments, shares, clicks, reason }

import { resolveCredential, env } from '../config.js';
import { FacebookPageAdapter } from './facebook.js';
import { InstagramAdapter } from './instagram.js';
import { MockAdapter } from './mock.js';
import { ProviderError } from '../meta/graph.js';

export function adapterFor(channel, { fetchImpl, mockRegistry } = {}) {
  switch (channel.provider) {
    case 'facebook_page':
      return new FacebookPageAdapter({
        pageId: channel.external_account_id,
        accessToken: resolveCredential(channel.credential_ref),
        appId: env('META_APP_ID'),
        appSecret: env('META_APP_SECRET'),
        version: env('META_GRAPH_VERSION'),
        fetchImpl,
      });
    case 'instagram':
      return new InstagramAdapter({
        igUserId: channel.external_account_id,
        accessToken: resolveCredential(channel.credential_ref),
        version: env('META_GRAPH_VERSION'),
        fetchImpl,
      });
    case 'mock': {
      const existing = mockRegistry?.get(channel.id);
      if (existing) return existing;
      const adapter = new MockAdapter({ accountId: channel.external_account_id });
      mockRegistry?.set(channel.id, adapter);
      return adapter;
    }
    default:
      throw new ProviderError(`No publishing adapter for ${channel.provider}`, { code: 'not_supported' });
  }
}

export const REQUIRED_PERMISSIONS = Object.freeze({
  facebook_page: {
    ingest: ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'pages_read_user_content'],
    reply: ['pages_manage_engagement', 'pages_read_user_content', 'pages_show_list'],
    publish: ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'],
    metrics: ['read_insights', 'pages_read_engagement'],
  },
  instagram: {
    ingest: ['instagram_business_basic', 'instagram_business_manage_comments'],
    reply: ['instagram_business_basic', 'instagram_business_manage_comments'],
    publish: ['instagram_business_basic', 'instagram_business_content_publish'],
    metrics: ['instagram_business_basic', 'instagram_business_manage_insights'],
  },
  mock: { ingest: [], reply: [], publish: [], metrics: [] },
});

export function missingPermissions(channel, operation) {
  const needed = REQUIRED_PERMISSIONS[channel.provider]?.[operation];
  if (!needed) return ['unsupported_provider'];
  const have = new Set(Array.isArray(channel.permissions_verified) ? channel.permissions_verified : []);
  return needed.filter((p) => !have.has(p));
}
