// Minimal Meta Graph API client used ONLY by provider adapters.
// The LLM never sees or constructs these requests.

// Latest version per the Graph API changelog on 2026-11-16 (v27.0, released 2026-11-04).
// Override with META_GRAPH_VERSION; pin explicitly before production.
export const DEFAULT_GRAPH_VERSION = 'v27.0';

export class ProviderError extends Error {
  constructor(message, { code, retryable = false, httpStatus, providerCode, providerSubcode, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;               // our stable error code
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
    this.providerSubcode = providerSubcode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014]);

export function classifyGraphError(httpStatus, body, headers) {
  const e = body && body.error ? body.error : {};
  const code = Number(e.code);
  const sub = Number(e.error_subcode);
  if (code === 190 || code === 102) {
    return new ProviderError('Access token invalid or expired', { code: 'token_invalid', retryable: false, httpStatus, providerCode: code, providerSubcode: sub });
  }
  if (code === 10 || code === 200 || (code >= 200 && code <= 299)) {
    return new ProviderError('Permission missing for this operation', { code: 'permission_denied', retryable: false, httpStatus, providerCode: code, providerSubcode: sub });
  }
  if (RATE_LIMIT_CODES.has(code) || httpStatus === 429) {
    let retryAfterSeconds = 600;
    const buc = headers && typeof headers.get === 'function' ? headers.get('x-business-use-case-usage') : null;
    if (buc) {
      try {
        const parsed = JSON.parse(buc);
        for (const arr of Object.values(parsed)) {
          for (const item of Array.isArray(arr) ? arr : []) {
            const mins = Number(item.estimated_time_to_regain_access);
            if (Number.isFinite(mins) && mins > 0) retryAfterSeconds = Math.max(60, mins * 60);
          }
        }
      } catch { /* ignore malformed header */ }
    }
    return new ProviderError('Provider rate limit reached', { code: 'rate_limited', retryable: true, httpStatus, providerCode: code, retryAfterSeconds });
  }
  if (code === 100 && (sub === 33 || sub === 1487390)) {
    return new ProviderError('Target object no longer exists or is not accessible', { code: 'target_missing', retryable: false, httpStatus, providerCode: code, providerSubcode: sub });
  }
  if (code === 368) {
    return new ProviderError('Action blocked by provider policy', { code: 'provider_blocked', retryable: false, httpStatus, providerCode: code });
  }
  if (code === 1 || code === 2 || httpStatus >= 500) {
    return new ProviderError('Provider temporarily unavailable', { code: 'provider_unavailable', retryable: true, httpStatus, providerCode: code });
  }
  return new ProviderError('Provider rejected the request', { code: 'provider_rejected', retryable: false, httpStatus, providerCode: code, providerSubcode: sub });
}

export class GraphClient {
  constructor({ accessToken, version = DEFAULT_GRAPH_VERSION, host = 'https://graph.facebook.com', fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    if (!accessToken) throw new ProviderError('No access token configured', { code: 'token_missing' });
    if (!/^v\d{1,2}\.\d$/.test(version)) throw new ProviderError('Invalid Graph API version', { code: 'config_invalid' });
    this.token = accessToken;
    this.version = version;
    this.host = host;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, params = {}) {
    if (!/^\/[A-Za-z0-9_/]+$/.test(path)) throw new ProviderError('Invalid Graph path', { code: 'config_invalid' });
    const url = new URL(`${this.host}/${this.version}${path}`);
    const init = { method, headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(this.timeoutMs) };
    if (method === 'GET') {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    } else {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    }
    let res;
    try {
      res = await this.fetch(url, init);
    } catch (err) {
      throw new ProviderError('Network error calling provider', { code: 'provider_unavailable', retryable: true });
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok || (body && body.error)) throw classifyGraphError(res.status, body, res.headers);
    return body;
  }
}
