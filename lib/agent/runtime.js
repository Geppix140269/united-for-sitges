// Production dependency wiring for the Vercel functions.
import { Db } from './db.js';
import { adapterFor } from './adapters/index.js';
import { AnthropicModelClient } from './llm.js';
import { env } from './config.js';

export function productionDeps() {
  return {
    getDb: () => Db.fromEnv(),
    adapterFor: (channel) => adapterFor(channel),
    model: env('ANTHROPIC_API_KEY') ? new AnthropicModelClient() : null,
  };
}
