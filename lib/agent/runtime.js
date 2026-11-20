// Dependency wiring for the Cloudflare Worker (one set per invocation).
// Database pools are not shared across requests on Workers, so getDb()
// creates one lazily and close() ends it after the response.
import { Db } from './db.js';
import { adapterFor } from './adapters/index.js';
import { AnthropicModelClient } from './llm.js';
import { env } from './config.js';
import { fetchTransport, dohResolver } from './net/fetch-transport.js';

export function workerDeps() {
  let db = null;
  return {
    getDb: () => {
      if (!db) db = Db.perRequest();
      return db;
    },
    close: async () => {
      if (db) {
        const d = db;
        db = null;
        await d.end().catch(() => {});
      }
    },
    adapterFor: (channel) => adapterFor(channel),
    model: env('ANTHROPIC_API_KEY') ? new AnthropicModelClient() : null,
    net: { transport: fetchTransport, resolver: dohResolver() },
  };
}
