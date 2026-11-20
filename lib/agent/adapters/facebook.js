// Facebook Page adapter (Graph API, Page access token). Publishing and
// replying are disabled until permissions, Page ownership and the launch gate
// are verified; this class itself never decides whether to publish.

import { GraphClient, ProviderError, DEFAULT_GRAPH_VERSION } from '../meta/graph.js';
import { textFingerprint } from '../crypto.js';

export class FacebookPageAdapter {
  constructor({ pageId, accessToken, appId, appSecret, version, fetchImpl }) {
    this.provider = 'facebook_page';
    this.pageId = pageId;
    this.version = version || DEFAULT_GRAPH_VERSION;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.accessToken = accessToken;
    this.appId = appId;
    this.appSecret = appSecret;
  }

  graph() {
    return new GraphClient({ accessToken: this.accessToken, version: this.version, fetchImpl: this.fetchImpl });
  }

  describe() {
    return {
      provider: this.provider,
      account: this.pageId,
      supportedMediaTypes: ['text', 'link', 'image_url'],
      permissionsRequired: ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement', 'pages_manage_posts'],
      operations: ['ingest_comments', 'reply_comment', 'publish_post', 'read_metrics'],
      maxPostsPerDay: 2,
      mediaRequirements: { optional: true },
      tokenConfigured: Boolean(this.accessToken),
    };
  }

  // Uses /debug_token with an app access token to read the Page token's
  // validity, scopes and owning Page. Never returns the token itself.
  async verifyToken() {
    if (!this.accessToken) throw new ProviderError('No Page access token configured', { code: 'token_missing' });
    if (!this.appId || !this.appSecret) throw new ProviderError('Meta app credentials not configured', { code: 'config_missing' });
    const appGraph = new GraphClient({ accessToken: `${this.appId}|${this.appSecret}`, version: this.version, fetchImpl: this.fetchImpl });
    const res = await appGraph.request('GET', '/debug_token', { input_token: this.accessToken });
    const d = res && res.data ? res.data : {};
    const accountId = String(d.profile_id || '');
    return {
      valid: Boolean(d.is_valid) && accountId === String(this.pageId),
      scopes: Array.isArray(d.scopes) ? d.scopes.filter((s) => typeof s === 'string') : [],
      expiresAt: d.expires_at ? new Date(Number(d.expires_at) * 1000).toISOString() : null,
      accountId,
      type: d.type || null,
    };
  }

  async getComment(commentId) {
    try {
      const res = await this.graph().request('GET', `/${commentId}`, { fields: 'id,message' });
      return { exists: Boolean(res && res.id), text: typeof res?.message === 'string' ? res.message : null };
    } catch (err) {
      if (err.code === 'target_missing') return { exists: false };
      throw err;
    }
  }

  async findOwnReply(commentId) {
    const res = await this.graph().request('GET', `/${commentId}/comments`, { fields: 'id,from', limit: 50 });
    const own = (res?.data || []).find((c) => c?.from && String(c.from.id) === String(this.pageId));
    return own ? String(own.id) : null;
  }

  async replyToComment(commentId, text) {
    const res = await this.graph().request('POST', `/${commentId}/comments`, { message: text });
    if (!res || !res.id) throw new ProviderError('Reply response missing id', { code: 'provider_rejected' });
    return { id: String(res.id) };
  }

  async findRecentPost(text) {
    const res = await this.graph().request('GET', `/${this.pageId}/posts`, { fields: 'id,message,permalink_url,created_time', limit: 10 });
    const want = textFingerprint(text);
    const hit = (res?.data || []).find((p) => typeof p.message === 'string' && textFingerprint(p.message) === want);
    return hit ? { id: String(hit.id), url: hit.permalink_url || `https://www.facebook.com/${hit.id}` } : null;
  }

  async publishPost({ text, link, mediaUrl }) {
    const graph = this.graph();
    let res;
    if (mediaUrl) {
      res = await graph.request('POST', `/${this.pageId}/photos`, { url: mediaUrl, caption: text });
    } else {
      const params = { message: text };
      if (link) params.link = link;
      res = await graph.request('POST', `/${this.pageId}/feed`, params);
    }
    const id = String(res?.post_id || res?.id || '');
    if (!id) throw new ProviderError('Publish response missing id', { code: 'provider_rejected' });
    let url = `https://www.facebook.com/${id}`;
    try {
      const meta = await graph.request('GET', `/${id}`, { fields: 'permalink_url' });
      if (meta?.permalink_url && /^https:\/\//.test(meta.permalink_url)) url = meta.permalink_url;
    } catch { /* permalink lookup is best effort */ }
    return { id, url };
  }

  // Page Insights: impressions metrics were deprecated (v25+, June 2026);
  // post_media_view is the documented replacement.
  async getPostMetrics(postId) {
    const graph = this.graph();
    const out = { available: false, impressions: null, reach: null, reactions: null, comments: null, shares: null, clicks: null, reason: null };
    try {
      const ins = await graph.request('GET', `/${postId}/insights`, { metric: 'post_media_view,post_clicks,post_reactions_by_type_total' });
      for (const m of ins?.data || []) {
        const v = m?.values?.[0]?.value;
        if (m.name === 'post_media_view' && Number.isFinite(v)) out.impressions = v;
        if (m.name === 'post_clicks' && Number.isFinite(v)) out.clicks = v;
        if (m.name === 'post_reactions_by_type_total' && v && typeof v === 'object') {
          out.reactions = Object.values(v).reduce((a, b) => a + (Number(b) || 0), 0);
        }
      }
      const post = await graph.request('GET', `/${postId}`, { fields: 'shares,comments.summary(true).limit(0)' });
      out.shares = Number.isFinite(post?.shares?.count) ? post.shares.count : 0;
      out.comments = Number.isFinite(post?.comments?.summary?.total_count) ? post.comments.summary.total_count : null;
      out.available = true;
    } catch (err) {
      out.reason = err.code || 'metrics_unavailable';
    }
    return out;
  }
}
