// Meta Webhooks endpoint: GET verification challenge, POST signed events.
// Receives and stores only. No replies, publishing or moderation here.
import { handleVerify, handleEvent } from '../../lib/agent/handlers/webhook.js';
import { productionDeps } from '../../lib/agent/runtime.js';

export function GET(request) {
  return handleVerify(request);
}

export function POST(request) {
  return handleEvent(request, productionDeps());
}
