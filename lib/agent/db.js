// Database access for the agent backend (private schema ufs_agent).
// Connects as the least-privilege role ufs_agent_worker through the Supabase
// transaction pooler. The connection string is a server-side secret
// (AGENT_DATABASE_URL) and is never logged or sent to the browser.

import pg from 'pg';
import { env } from './config.js';

let sharedPool = null;

export function createPool(connectionString, { max = 2 } = {}) {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
    statement_timeout: 15000,
    ssl: /sslmode=disable/.test(connectionString) || /localhost|127\.0\.0\.1|\/tmp|host=\//.test(connectionString)
      ? false : { rejectUnauthorized: false },
  });
}

export class Db {
  constructor(pool) {
    this.pool = pool;
  }

  static fromEnv() {
    if (!sharedPool) sharedPool = createPool(env('AGENT_DATABASE_URL', { required: true }));
    return new Db(sharedPool);
  }

  async query(text, params = []) {
    const res = await this.pool.query(text, params);
    return res.rows;
  }

  async one(text, params = []) {
    const rows = await this.query(text, params);
    return rows[0] ?? null;
  }

  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const scoped = {
        query: async (t, p = []) => (await client.query(t, p)).rows,
        one: async (t, p = []) => (await client.query(t, p)).rows[0] ?? null,
      };
      scoped.tx = (inner) => inner(scoped);
      const result = await fn(scoped);
      await client.query('commit');
      return result;
    } catch (err) {
      try { await client.query('rollback'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async end() {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Shared helpers used by every module.
// ---------------------------------------------------------------------------

const SAFE_DETAIL_KEYS_BLOCKLIST = /token|secret|password|authorization|api[_-]?key|cookie/i;

function scrub(detail) {
  if (!detail || typeof detail !== 'object') return {};
  const out = Array.isArray(detail) ? [] : {};
  for (const [k, v] of Object.entries(detail)) {
    if (SAFE_DETAIL_KEYS_BLOCKLIST.test(k)) continue;
    if (v && typeof v === 'object') out[k] = scrub(v);
    else if (typeof v === 'string') out[k] = v.slice(0, 2000);
    else out[k] = v;
  }
  return out;
}

export async function audit(db, { actorType, actorId = null, action, entityType, entityId = null, detail = {} }) {
  await db.query(
    `insert into ufs_agent.audit_log(actor_type, actor_id, action, entity_type, entity_id, detail)
     values ($1,$2,$3,$4,$5,$6)`,
    [actorType, actorId, action, entityType, entityId == null ? null : String(entityId), scrub(detail)],
  );
}

export async function getSettings(db) {
  const rows = await db.query('select key, value from ufs_agent.settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(db, key, value, actorId) {
  return db.tx(async (t) => {
    const before = await t.one('select value from ufs_agent.settings where key=$1 for update', [key]);
    if (!before) throw Object.assign(new Error('Unknown setting'), { code: 'unknown_setting' });
    const row = await t.one(
      'update ufs_agent.settings set value=$2, updated_by=$3, updated_at=now() where key=$1 returning value',
      [key, value, actorId],
    );
    await audit(t, { actorType: 'human', actorId, action: 'setting_changed', entityType: 'setting', entityId: key, detail: { before: before.value, after: value } });
    return row.value;
  });
}

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Atomically consume quota. Returns true when allowed.
export async function consumeQuota(db, metric, limit, amount = 1, now = new Date()) {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const row = await db.one(
    `insert into ufs_agent.usage_counters(day, metric, count) values ($1,$2,$3)
     on conflict (day, metric) do update set count = ufs_agent.usage_counters.count + excluded.count
       where ufs_agent.usage_counters.count + excluded.count <= $4
     returning count`,
    [utcDay(now), metric, amount, limit],
  );
  if (!row) return false;
  return Number(row.count) <= limit;
}

export async function bumpUsage(db, metric, amount = 1, now = new Date()) {
  if (!amount) return;
  await db.query(
    `insert into ufs_agent.usage_counters(day, metric, count) values ($1,$2,$3)
     on conflict (day, metric) do update set count = ufs_agent.usage_counters.count + excluded.count`,
    [utcDay(now), metric, amount],
  );
}

export function backoffSeconds(attempt) {
  // 1m, 5m, 15m, 1h, 3h ... capped at 6h.
  const table = [60, 300, 900, 3600, 10800];
  return table[Math.min(attempt - 1, table.length - 1)] ?? 21600;
}
