// Manual scheduler entrypoint (POST, Bearer CRON_SECRET) for operators and
// tests. Production scheduling uses the Worker's scheduled() handler with a
// Cloudflare Cron Trigger. Every job is idempotent, so it is safe to call often.

import { safeEqualString } from '../crypto.js';
import { env } from '../config.js';
import { json, log } from '../http.js';
import { runTick, JOBS } from '../jobs.js';

export async function handleCron(request, deps) {
  const secret = env('CRON_SECRET');
  if (!secret || secret.length < 32) return json(503, { error: 'not_configured' });
  const header = request.headers.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!safeEqualString(provided, secret)) return json(401, { error: 'unauthorized' });
  const url = new URL(request.url);
  const requested = (url.searchParams.get('jobs') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const jobs = requested.length ? requested.filter((j) => JOBS.includes(j)) : JOBS;
  try {
    const summary = await runTick(deps.getDb(), deps, { jobs });
    log('agent_tick', { jobs: jobs.join(','), moderation: summary.mode.moderation, publishing: summary.mode.publishing, stop: summary.mode.emergency_stop });
    return json(200, summary);
  } catch (err) {
    log('agent_tick_failed', { code: err.code || 'tick_failed' });
    return json(500, { error: 'tick_failed' });
  }
}
