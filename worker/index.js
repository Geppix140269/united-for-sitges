// Cloudflare Worker entry for unitedforsitges.com.
// * /api/agent/* is handled here (Meta webhook, moderator API, manual tick).
// * Everything else is the static site, served from the assets binding
//   exactly as before (wrangler.jsonc routes only /api/* to this script).
// * scheduled() runs the agent tick ONLY when a Cron Trigger is configured
//   AND AGENT_SCHEDULER_ENABLED is "true". Neither is set in this repository.
// All outbound behaviour stays off unless the env live switches are set.
import { configureEnv, boolEnv } from '../lib/agent/config.js';
import { workerDeps } from '../lib/agent/runtime.js';
import { handleVerify, handleEvent } from '../lib/agent/handlers/webhook.js';
import { handleAdmin } from '../lib/agent/handlers/admin.js';
import { handleCron } from '../lib/agent/handlers/cron.js';
import { runTick } from '../lib/agent/jobs.js';
import { json, log } from '../lib/agent/http.js';

const ROUTES = {
  '/api/agent/meta-webhook': { GET: (req) => handleVerify(req), POST: handleEvent },
  '/api/agent/admin': { GET: handleAdmin, POST: handleAdmin },
  '/api/agent/cron': { POST: handleCron },
};

export async function routeApi(request, makeDeps = workerDeps) {
  const { pathname } = new URL(request.url);
  const route = ROUTES[pathname];
  if (!route) return { response: json(404, { error: 'not_found' }) };
  const handler = route[request.method];
  if (!handler) return { response: json(405, { error: 'method_not_allowed' }, { Allow: Object.keys(route).join(', ') }) };
  const deps = makeDeps();
  try {
    return { response: await handler(request, deps), deps };
  } catch (err) {
    log('api_unhandled_error', { path: pathname, code: err.code || 'internal' });
    return { response: json(500, { error: 'internal_error' }), deps };
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      configureEnv(env);
      const { response, deps } = await routeApi(request);
      if (deps?.close) ctx.waitUntil(deps.close());
      return response;
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    configureEnv(env);
    if (!boolEnv('AGENT_SCHEDULER_ENABLED')) {
      log('agent_tick_skipped', { reason: 'scheduler_disabled' });
      return;
    }
    const deps = workerDeps();
    ctx.waitUntil((async () => {
      try {
        const summary = await runTick(deps.getDb(), deps);
        log('agent_tick', { cron: controller.cron, moderation: summary.mode.moderation, publishing: summary.mode.publishing, stop: summary.mode.emergency_stop });
      } catch (err) {
        log('agent_tick_failed', { code: err.code || 'tick_failed' });
      } finally {
        await deps.close();
      }
    })());
  },
};
