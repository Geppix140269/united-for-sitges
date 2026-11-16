// In-memory provider used for tests and shadow simulations. It never touches
// the network. Failure modes can be scripted per operation.

import { ProviderError } from '../meta/graph.js';
import { textFingerprint } from '../crypto.js';

export class MockAdapter {
  constructor({ accountId = 'mock-account' } = {}) {
    this.provider = 'mock';
    this.accountId = accountId;
    this.calls = [];
    this.replies = new Map();     // commentId -> reply id
    this.posts = [];              // { id, text, url }
    this.missingComments = new Set();
    this.failures = new Map();    // op -> array of error specs consumed in order
    this.metrics = new Map();
    this.counter = 0;
  }

  failNext(op, spec) {
    if (!this.failures.has(op)) this.failures.set(op, []);
    this.failures.get(op).push(spec);
  }

  maybeFail(op) {
    const queue = this.failures.get(op);
    if (queue && queue.length) {
      const spec = queue.shift();
      throw new ProviderError(spec.message || spec.code, spec);
    }
  }

  describe() {
    return { provider: 'mock', account: this.accountId, supportedMediaTypes: ['text', 'image_jpeg'], permissionsRequired: [], operations: ['reply_comment', 'publish_post', 'read_metrics'], maxPostsPerDay: 2, mediaRequirements: { optional: true }, tokenConfigured: true };
  }

  async verifyToken() {
    this.calls.push({ op: 'verifyToken' });
    this.maybeFail('verifyToken');
    return { valid: true, scopes: [], expiresAt: null, accountId: this.accountId };
  }

  async getComment(id) {
    this.calls.push({ op: 'getComment', id });
    this.maybeFail('getComment');
    return { exists: !this.missingComments.has(id) };
  }

  async findOwnReply(commentId) {
    this.calls.push({ op: 'findOwnReply', commentId });
    return this.replies.get(commentId) || null;
  }

  async replyToComment(commentId, text) {
    this.calls.push({ op: 'replyToComment', commentId, text });
    this.maybeFail('replyToComment');
    this.counter += 1;
    const id = `mock-reply-${this.counter}`;
    this.replies.set(commentId, id);
    return { id };
  }

  async findRecentPost(text) {
    const fp = textFingerprint(text);
    const hit = this.posts.find((p) => textFingerprint(p.text) === fp);
    return hit ? { id: hit.id, url: hit.url } : null;
  }

  async publishPost({ text, link, mediaUrl }) {
    this.calls.push({ op: 'publishPost', text, link, mediaUrl });
    this.maybeFail('publishPost');
    this.counter += 1;
    const post = { id: `mock-post-${this.counter}`, text, url: `https://example.invalid/mock/${this.counter}` };
    this.posts.push(post);
    return { id: post.id, url: post.url };
  }

  async getPostMetrics(postId) {
    this.calls.push({ op: 'getPostMetrics', postId });
    return this.metrics.get(postId) || { available: false, reason: 'mock_no_metrics' };
  }
}
