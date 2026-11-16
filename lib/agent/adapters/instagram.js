// Instagram adapter using Instagram API with Instagram Login
// (host graph.instagram.com, instagram_business_* permissions).
// Feed publishing requires a public JPEG image; text-only posts are rejected.
// Not activated: no Instagram Professional account has been confirmed.

import { GraphClient, ProviderError, DEFAULT_GRAPH_VERSION } from '../meta/graph.js';

export class InstagramAdapter {
  constructor({ igUserId, accessToken, version, fetchImpl, sleep }) {
    this.provider = 'instagram';
    this.igUserId = igUserId;
    this.accessToken = accessToken;
    this.version = version || DEFAULT_GRAPH_VERSION;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollAttempts = 4;
    this.pollDelayMs = 3000;
  }

  graph() {
    return new GraphClient({ accessToken: this.accessToken, version: this.version, host: 'https://graph.instagram.com', fetchImpl: this.fetchImpl });
  }

  describe() {
    return {
      provider: this.provider,
      account: this.igUserId,
      supportedMediaTypes: ['image_jpeg'],
      permissionsRequired: ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_content_publish'],
      operations: ['ingest_comments', 'reply_comment', 'publish_post'],
      maxPostsPerDay: 2,
      mediaRequirements: { required: true, format: 'JPEG', maxBytes: 8 * 1024 * 1024, aspectRatio: '4:5 to 1.91:1', widthPx: '320 to 1440' },
      tokenConfigured: Boolean(this.accessToken),
    };
  }

  async verifyToken() {
    const res = await this.graph().request('GET', '/me', { fields: 'user_id,username' });
    const accountId = String(res?.user_id || res?.id || '');
    return { valid: accountId === String(this.igUserId), scopes: [], expiresAt: null, accountId };
  }

  async getComment(commentId) {
    try {
      const res = await this.graph().request('GET', `/${commentId}`, { fields: 'id' });
      return { exists: Boolean(res?.id) };
    } catch (err) {
      if (err.code === 'target_missing') return { exists: false };
      throw err;
    }
  }

  async findOwnReply(commentId) {
    const res = await this.graph().request('GET', `/${commentId}/replies`, { fields: 'id,from' });
    const own = (res?.data || []).find((c) => c?.from && String(c.from.id) === String(this.igUserId));
    return own ? String(own.id) : null;
  }

  async replyToComment(commentId, text) {
    const res = await this.graph().request('POST', `/${commentId}/replies`, { message: text });
    if (!res?.id) throw new ProviderError('Reply response missing id', { code: 'provider_rejected' });
    return { id: String(res.id) };
  }

  async findRecentPost() {
    return null; // Containers are tracked by id instead (see publishPost).
  }

  async remainingQuota() {
    const res = await this.graph().request('GET', `/${this.igUserId}/content_publishing_limit`, { fields: 'quota_usage,config' });
    const row = res?.data?.[0] || {};
    const total = Number(row?.config?.quota_total);
    const used = Number(row?.quota_usage);
    if (!Number.isFinite(total) || !Number.isFinite(used)) return null;
    return total - used;
  }

  // Container lifecycle: create -> poll status -> publish. If processing is
  // still IN_PROGRESS the container id is returned so the next scheduler run
  // resumes it instead of creating a duplicate container.
  async publishPost({ text, mediaUrl, containerId }) {
    if (!mediaUrl) throw new ProviderError('Instagram feed posts require an image', { code: 'media_required' });
    const graph = this.graph();
    const remaining = await this.remainingQuota().catch(() => null);
    if (remaining !== null && remaining <= 0) throw new ProviderError('Instagram publishing quota exhausted', { code: 'rate_limited', retryable: true, retryAfterSeconds: 3600 });
    let creationId = containerId;
    if (!creationId) {
      const created = await graph.request('POST', `/${this.igUserId}/media`, { image_url: mediaUrl, caption: text });
      if (!created?.id) throw new ProviderError('Container creation returned no id', { code: 'provider_rejected' });
      creationId = String(created.id);
    }
    let status = null;
    for (let i = 0; i < this.pollAttempts; i += 1) {
      const s = await graph.request('GET', `/${creationId}`, { fields: 'status_code' });
      status = s?.status_code;
      if (status === 'FINISHED' || status === 'PUBLISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new ProviderError(`Media container ${status}`, { code: 'media_rejected' });
      await this.sleep(this.pollDelayMs);
    }
    if (status === 'IN_PROGRESS' || !status) return { pending: true, containerId: creationId };
    if (status === 'PUBLISHED') throw new ProviderError('Container already published; reconcile manually', { code: 'unknown_outcome' });
    const published = await graph.request('POST', `/${this.igUserId}/media_publish`, { creation_id: creationId });
    const id = String(published?.id || '');
    if (!id) throw new ProviderError('media_publish returned no id', { code: 'provider_rejected' });
    let url = null;
    try {
      const meta = await graph.request('GET', `/${id}`, { fields: 'permalink' });
      if (meta?.permalink && /^https:\/\//.test(meta.permalink)) url = meta.permalink;
    } catch { /* best effort */ }
    return { id, url, containerId: creationId };
  }

  async getPostMetrics() {
    return { available: false, reason: 'not_implemented_pending_permission_review' };
  }
}
