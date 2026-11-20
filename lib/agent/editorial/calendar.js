// Rolling editorial calendar. Exactly two slots per local calendar date
// (morning, evening), enforced by unique(planned_date, planned_slot).

import topicData from '../../../data/agent/editorial-topics.json' with { type: 'json' };
import { localDateString, addDays } from '../time.js';
import { audit } from '../db.js';

let topicBank = null;
export function loadTopicBank() {
  if (!topicBank) {
    topicBank = topicData.topics;
  }
  return topicBank;
}

// Pure topic selection: prefer the slot's natural kind (morning informative,
// evening discussion), skip disabled categories, avoid topics used within the
// duplicate window and the category used in the previous slot.
export function chooseTopic({ slot, permittedCategories, recentTopicKeys, previousCategory, bank = loadTopicBank(), reservedKeys = new Set() }) {
  const permitted = new Set(permittedCategories || []);
  const candidates = bank.filter((t) => permitted.has(t.category) && !recentTopicKeys.has(t.key) && !reservedKeys.has(t.key));
  const ranked = [
    ...candidates.filter((t) => t.slot === slot && t.category !== previousCategory),
    ...candidates.filter((t) => t.slot === slot && t.category === previousCategory),
    ...candidates.filter((t) => t.slot !== slot && t.category !== previousCategory),
  ];
  return ranked[0] || null;
}

export async function planCalendar(db, { settings, now = new Date(), horizonDays } = {}) {
  const pub = settings.publishing || {};
  const tz = pub.timezone || 'Europe/Madrid';
  const horizon = Math.min(Math.max(Number(horizonDays ?? pub.planning_horizon_days) || 7, 1), 21);
  const windowDays = Math.max(Number(pub.duplicate_content_window_days) || 30, 1);
  const today = localDateString(now, tz);
  const created = [];

  const recent = await db.query(
    `select topic_key, planned_date, planned_slot, category from ufs_agent.editorial_calendar
     where planned_date >= $1::date - $2::int and status <> 'cancelled' order by planned_date, planned_slot`,
    [today, windowDays],
  );
  const recentKeys = new Set(recent.map((r) => r.topic_key));
  const existing = new Set(recent.map((r) => `${String(r.planned_date instanceof Date ? r.planned_date.toISOString().slice(0, 10) : r.planned_date)}|${r.planned_slot}`));
  let previousCategory = recent.length ? recent[recent.length - 1].category : null;

  for (let d = 0; d < horizon; d += 1) {
    const date = addDays(today, d);
    for (const slot of ['morning', 'evening']) {
      if (existing.has(`${date}|${slot}`)) continue;
      const topic = chooseTopic({ slot, permittedCategories: pub.permitted_content_categories, recentTopicKeys: recentKeys, previousCategory });
      if (!topic) continue; // never invent a topic to fill a slot
      const row = await db.one(
        `insert into ufs_agent.editorial_calendar(planned_date, planned_slot, category, topic, topic_key, source_requirements, priority)
         values ($1,$2,$3,$4,$5,$6,3) on conflict (planned_date, planned_slot) do nothing returning id`,
        [date, slot, topic.category, topic.topic, topic.key, JSON.stringify({ sources: topic.sources, factual: topic.factual, sensitive_electoral: Boolean(topic.sensitive_electoral) })],
      );
      if (row) {
        created.push({ id: row.id, date, slot, key: topic.key });
        recentKeys.add(topic.key);
        previousCategory = topic.category;
      }
    }
  }
  if (created.length) await audit(db, { actorType: 'system', action: 'calendar_planned', entityType: 'editorial_calendar', detail: { slots: created.length } });
  return created;
}
