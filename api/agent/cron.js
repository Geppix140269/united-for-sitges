// Scheduler tick (Bearer CRON_SECRET). Idempotent; safe to call repeatedly.
import { handleCron } from '../../lib/agent/handlers/cron.js';
import { productionDeps } from '../../lib/agent/runtime.js';

export function GET(request) {
  return handleCron(request, productionDeps());
}

export function POST(request) {
  return handleCron(request, productionDeps());
}
