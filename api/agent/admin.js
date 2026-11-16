// Moderator API for the agent console. Requires a verified Supabase Auth
// session of an active moderator; all writes are validated server-side.
import { handleAdmin } from '../../lib/agent/handlers/admin.js';
import { productionDeps } from '../../lib/agent/runtime.js';

export function GET(request) {
  return handleAdmin(request, productionDeps());
}

export function POST(request) {
  return handleAdmin(request, productionDeps());
}
