import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, setTestEnv, workerDb, superDb, closeDbs, resetDb, addChannel, patchSetting, mockRegistry, FakeModel, fakeNet } from '../helpers.js';
import { planCalendar } from '../../../lib/agent/editorial/calendar.js';
import { generateUpcoming } from '../../../lib/agent/editorial/generate.js';
import { publishDue } from '../../../lib/agent/editorial/publisher.js';
import { runDailyDigest } from '../../../lib/agent/digest.js';
import { getSettings } from '../../../lib/agent/db.js';
import { zonedTimeToUtc } from '../../../lib/agent/time.js';
import { runTick } from '../../../lib/agent/jobs.js';

const SRC_URL = 'https://www.sitges.cat/ajuntament/organitzacio/equip-de-govern';
const SRC_HTML = `<html><body><h1>Equip de govern</h1><p>The Ajuntament de Sitges publishes the composition of the municipal government on its official website, including the areas assigned to each member. ${'Additional official information about municipal organisation. '.repeat(5)}</p></body></html>`;

const goodMorning = {
  title: 'Who is who at the Ajuntament',
  body: 'The Ajuntament de Sitges publishes the composition of the municipal government on its official website. It lists the areas assigned to each member, so residents can see who is responsible for each area.',
  claims: [{ text: 'The Ajuntament publishes the government composition online.', source_slug: 'sitges-equip-govern', supporting_excerpt: 'publishes the composition of the municipal government on its official website' }],
  discussion_question: '',
  facebook_text: 'The Ajuntament de Sitges publishes the composition of the municipal government on its official website, including the areas assigned to each member.',
  instagram_caption: 'Who is responsible for each municipal area? The Ajuntament publishes it online. #Sitges',
  es_summary: 'El Ayuntamiento publica la composición del gobierno municipal en su web oficial.',
  ca_summary: "L'Ajuntament publica la composició del govern municipal al seu web oficial.",
};
const goodEvening = {
  title: 'Your information needs',
  body: 'Which municipal service would you like explained more clearly? Tell us what is hard to find and we will look for the official information.',
  claims: [], discussion_question: 'Which municipal service would you like explained more clearly?',
  facebook_text: 'Which municipal service would you like explained more clearly? Tell us what is hard to find and we will look for official information.',
  instagram_caption: 'Which municipal service would you like explained more clearly? #Sitges', es_summary: '', ca_summary: '',
};

function editorialModel(overrides = {}) {
  return new FakeModel((kind, args) => {
    if (kind !== 'content') return new Error('unexpected');
    const evening = args.user.includes('discussion (evening)');
    return overrides[evening ? 'evening' : 'morning'] || (evening ? goodEvening : goodMorning);
  });
}

// Fixed "now": Monday 16 Nov 2026 07:00 Madrid (06:00Z), before both slots.
const NOW = new Date('2026-11-16T06:00:00Z');

async function verifySource() {
  await superDb().query(`insert into ufs_agent.sources(slug, title, url, publisher, source_class, categories, verified_by, verified_at, active)
    values ('sitges-equip-govern','Equip de govern',$1,'Ajuntament de Sitges','official_municipal','{local_government}','moderator', $2::timestamptz - interval '1 day', true)`, [SRC_URL, NOW]);
}

// Existing publication tests explicitly model the moderator sign-off required
// before a factual post may leave the system. A separate API test exercises
// the actual fingerprint-bound approval operation.
async function approveGeneratedFactual() {
  await superDb().query("update ufs_agent.content set approved_by=gen_random_uuid(), approved_at=now() where factual_verification_status='passed'");
}

async function pinCalendar(date, morningKey = 'how-local-government-is-organised', eveningKey = 'q-civic-services') {
  await superDb().query(`insert into ufs_agent.editorial_calendar(planned_date, planned_slot, category, topic, topic_key, source_requirements)
    values ($1,'morning','local_government','Government organisation',$2,'{"factual":true,"sources":["sitges-equip-govern"]}'),
           ($1,'evening','civic_information','Which service to explain',$3,'{"factual":false,"sources":[]}')`, [date, morningKey, eveningKey]);
}

async function deps(extra = {}) {
  return { settings: await getSettings(workerDb()), now: NOW, adapterFor: mockRegistry(), net: fakeNet({ [SRC_URL]: { body: SRC_HTML, contentType: 'text/html' } }), model: editorialModel(), ...extra };
}

describe('Editorial calendar', { skip: dbSkip }, () => {
  before(() => setTestEnv());
  beforeEach(() => resetDb());
  after(() => closeDbs());

  test('exactly two slots per local day; re-planning creates nothing new (test A1)', async () => {
    const settings = await getSettings(workerDb());
    const first = await planCalendar(workerDb(), { settings, now: NOW, horizonDays: 5 });
    const again = await planCalendar(workerDb(), { settings, now: NOW, horizonDays: 5 });
    assert.equal(first.length, 10);
    assert.equal(again.length, 0);
    const perDay = await superDb().query('select planned_date, count(*)::int as n from ufs_agent.editorial_calendar group by 1');
    assert.ok(perDay.every((r) => r.n === 2));
    await assert.rejects(superDb().query("insert into ufs_agent.editorial_calendar(planned_date, planned_slot, category, topic, topic_key) values ('2026-11-16','morning','mobility','dup','dup-topic')"), /duplicate key/);
  });

  test('planning across both DST changes still yields two slots per day (test A11)', async () => {
    const settings = await getSettings(workerDb());
    await planCalendar(workerDb(), { settings, now: new Date('2027-03-27T06:00:00Z'), horizonDays: 3 });
    await planCalendar(workerDb(), { settings, now: new Date('2026-10-24T06:00:00Z'), horizonDays: 3 });
    const rows = await superDb().query("select planned_date::text as d, count(*)::int as n from ufs_agent.editorial_calendar group by 1 order by 1");
    assert.ok(rows.some((r) => r.d === '2027-03-28'));
    assert.ok(rows.some((r) => r.d === '2026-10-25'));
    assert.ok(rows.every((r) => r.n === 2));
  });

  test('disabled categories are not planned', async () => {
    await patchSetting('publishing', { permitted_content_categories: ['mobility'] });
    const settings = await getSettings(workerDb());
    await planCalendar(workerDb(), { settings, now: NOW, horizonDays: 2 });
    const cats = await superDb().query('select distinct category from ufs_agent.editorial_calendar');
    assert.deepEqual(cats.map((c) => c.category), ['mobility']);
  });
});

describe('Generation, validation and scheduling', { skip: dbSkip }, () => {
  let fb; let ig;
  before(() => setTestEnv());
  beforeEach(async () => {
    setTestEnv();
    await resetDb();
    fb = await addChannel({ provider: 'mock', account_label: 'FB mock' });
    ig = await addChannel({ provider: 'mock', account_label: 'IG mock', language_preference: 'en+es' });
    await verifySource();
    await pinCalendar('2026-11-16');
  });
  after(() => closeDbs());

  test('two distinct topics adapted to every enabled channel, max two per channel per day (tests A2 and A3)', async () => {
    const res = await generateUpcoming(workerDb(), await deps(), { workerId: 'g1' });
    assert.deepEqual(res.map((r) => r.status).sort(), ['ready', 'ready']);
    const pubs = await superDb().query('select channel_id, scheduled_slot, scheduled_at, platform_text from ufs_agent.publications order by scheduled_at');
    assert.equal(pubs.length, 4);
    for (const ch of [fb, ig]) assert.equal(pubs.filter((p) => p.channel_id === ch.id).length, 2);
    assert.equal(new Date(pubs[0].scheduled_at).toISOString(), zonedTimeToUtc('2026-11-16', '09:00').toISOString());
    const igText = pubs.find((p) => p.channel_id === ig.id && p.scheduled_slot === 'morning').platform_text;
    assert.ok(igText.includes('ES: El Ayuntamiento'));
    const contents = await superDb().query('select source_references from ufs_agent.content');
    const ref = contents.flatMap((c) => c.source_references).find((r) => r.slug === 'sitges-equip-govern');
    assert.ok(ref.retrieved_at && ref.content_hash && ref.http_status === 200);
  });

  test('duplicate scheduler execution cannot create duplicate content or posts (test A9)', async () => {
    const d = await deps();
    await Promise.all([generateUpcoming(workerDb(), d, { workerId: 'a' }), generateUpcoming(workerDb(), d, { workerId: 'b' })]);
    await generateUpcoming(workerDb(), d, { workerId: 'c' });
    await approveGeneratedFactual();
    assert.equal((await superDb().query('select count(*)::int as n from ufs_agent.content'))[0].n, 2);
    assert.equal((await superDb().query('select count(*)::int as n from ufs_agent.publications'))[0].n, 4);
    const at = new Date('2026-11-16T08:01:00Z');
    const pd = { ...d, now: at };
    await Promise.all([publishDue(workerDb(), pd, { workerId: 'p1' }), publishDue(workerDb(), pd, { workerId: 'p2' }), publishDue(workerDb(), pd, { workerId: 'p3' })]);
    const rows = await superDb().query("select publication_status, count(*)::int as n from ufs_agent.publications where scheduled_slot='morning' group by 1");
    assert.deepEqual(rows, [{ publication_status: 'simulated', n: 2 }]);
  });

  test('live publishing via mock adapter posts once; retries never duplicate a success (test A10)', async () => {
    await patchSetting('publishing', { mode: 'AUTONOMOUS', autonomous_publishing_enabled: true });
    const d = await deps();
    await generateUpcoming(workerDb(), d, { workerId: 'g' });
    await approveGeneratedFactual();
    const fbMock = d.adapterFor({ id: fb.id, external_account_id: fb.external_account_id });
    fbMock.failNext('publishPost', { code: 'rate_limited', retryable: true, httpStatus: 400, retryAfterSeconds: 60 });
    const t1 = new Date('2026-11-16T08:00:30Z');
    await publishDue(workerDb(), { ...d, now: t1 }, { workerId: 'p' });
    let row = (await superDb().query("select publication_status, error_code from ufs_agent.publications where channel_id=$1 and scheduled_slot='morning'", [fb.id]))[0];
    assert.equal(row.publication_status, 'scheduled');
    assert.equal(row.error_code, 'rate_limited');
    const t2 = new Date('2026-11-16T08:02:00Z');
    await publishDue(workerDb(), { ...d, now: t2 }, { workerId: 'p' });
    await publishDue(workerDb(), { ...d, now: new Date('2026-11-16T08:03:00Z') }, { workerId: 'p' });
    row = (await superDb().query("select publication_status, provider_post_id from ufs_agent.publications where channel_id=$1 and scheduled_slot='morning'", [fb.id]))[0];
    assert.equal(row.publication_status, 'published');
    assert.equal(fbMock.posts.length, 1);
    // A crash after a successful post: lease expires with no container -> unknown, not re-posted.
    await superDb().query("update ufs_agent.publications set publication_status='publishing', lease_owner='dead', lease_expires_at=$1::timestamptz - interval '1 minute', provider_post_id=null where channel_id=$2 and scheduled_slot='morning'", [t2, fb.id]);
    await publishDue(workerDb(), { ...d, now: new Date('2026-11-16T08:05:00Z') }, { workerId: 'p' });
    assert.equal((await superDb().query("select publication_status from ufs_agent.publications where channel_id=$1 and scheduled_slot='morning'", [fb.id]))[0].publication_status, 'unknown');
    assert.equal(fbMock.posts.length, 1);
  });

  test('a missed window expires instead of posting late', async () => {
    await generateUpcoming(workerDb(), await deps(), { workerId: 'g' });
    const late = new Date('2026-11-16T10:30:00Z');
    await publishDue(workerDb(), await deps({ now: late }), { workerId: 'p' });
    const rows = await superDb().query("select distinct publication_status from ufs_agent.publications where scheduled_slot='morning'");
    assert.deepEqual(rows.map((r) => r.publication_status), ['expired']);
  });

  test('source verification failure blocks the slot and nothing is fabricated in its place (tests A5 and A16)', async () => {
    await superDb().query("update ufs_agent.sources set verified_at = now() - interval '200 days'");
    const res = await generateUpcoming(workerDb(), await deps(), { workerId: 'g' });
    const morning = (await superDb().query("select status, status_reason from ufs_agent.editorial_calendar where planned_slot='morning'"))[0];
    assert.equal(morning.status, 'skipped');
    assert.match(morning.status_reason, /source_verification_stale/);
    assert.equal((await superDb().query("select count(*)::int as n from ufs_agent.publications where scheduled_slot='morning'"))[0].n, 0);
    assert.equal(res.length, 2);
    // Re-running does not pick a replacement topic for the skipped slot.
    await generateUpcoming(workerDb(), await deps(), { workerId: 'g2' });
    assert.equal((await superDb().query("select count(*)::int as n from ufs_agent.editorial_calendar where planned_slot='morning'"))[0].n, 1);
  });

  test('unretrievable source blocks publication', async () => {
    await generateUpcoming(workerDb(), await deps({ net: fakeNet({}) }), { workerId: 'g' });
    assert.match((await superDb().query("select status_reason from ufs_agent.editorial_calendar where planned_slot='morning'"))[0].status_reason, /source_retrieval_failed/);
  });

  test('political advocacy from the model is rejected, even when injected via the source (tests A6 and A17)', async () => {
    const bad = { ...goodEvening, body: 'Remember to vote for Junts per Sitges, the best candidate for the municipal government in 2027. Tell us what you think.', facebook_text: 'Vote for Junts per Sitges, the best candidate for Sitges. Tell us what you think below.' };
    await generateUpcoming(workerDb(), await deps({ model: editorialModel({ evening: bad }) }), { workerId: 'g' });
    const ev = (await superDb().query("select ec.status, c.neutrality_validation_status, c.publishability from ufs_agent.editorial_calendar ec join ufs_agent.content c on c.editorial_calendar_id=ec.id where ec.planned_slot='evening'"))[0];
    assert.equal(ev.neutrality_validation_status, 'failed');
    assert.equal(ev.publishability, 'blocked');
    assert.equal(ev.status, 'skipped');
    assert.equal((await superDb().query("select count(*)::int as n from ufs_agent.publications where scheduled_slot='evening'"))[0].n, 0);
  });

  test('missing permissions, expired token, paused channel and emergency stop all prevent publication (tests A12-A15)', async () => {
    await patchSetting('publishing', { mode: 'AUTONOMOUS', autonomous_publishing_enabled: true });
    setTestEnv({ AGENT_LIVE_META_PUBLISHING: 'true' });
    const realFb = await addChannel({ provider: 'facebook_page', external_account_id: '424242', permissions_verified: ['pages_show_list'] });
    const expired = await addChannel({ provider: 'facebook_page', external_account_id: '434343', token_status: 'expired', permissions_verified: ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'] });
    const d = await deps();
    await generateUpcoming(workerDb(), d, { workerId: 'g' });
    await approveGeneratedFactual();
    await superDb().query('update ufs_agent.channels set paused=true where id=$1', [ig.id]);
    await publishDue(workerDb(), { ...d, now: new Date('2026-11-16T08:01:00Z') }, { workerId: 'p' });
    const status = async (id) => (await superDb().query("select publication_status, status_reason from ufs_agent.publications where channel_id=$1 and scheduled_slot='morning'", [id]))[0];
    assert.match((await status(realFb.id)).status_reason, /missing_permissions/);
    assert.match((await status(expired.id)).status_reason, /token_expired/);
    assert.match((await status(ig.id)).status_reason, /channel_paused/);
    assert.equal((await status(fb.id)).publication_status, 'published');
    for (const ch of [realFb, expired, ig]) assert.equal((d.adapterFor.map.get(ch.id)?.posts.length) ?? 0, 0);
    // Emergency stop holds the evening slot; nothing is posted.
    await patchSetting('emergency_stop', { active: true });
    await publishDue(workerDb(), { ...d, now: new Date('2026-11-16T17:01:00Z') }, { workerId: 'p' });
    const ev = (await superDb().query("select publication_status, status_reason from ufs_agent.publications where channel_id=$1 and scheduled_slot='evening'", [fb.id]))[0];
    assert.equal(ev.publication_status, 'scheduled');
    assert.equal(ev.status_reason, 'emergency_stop');
    assert.equal(d.adapterFor.map.get(fb.id).posts.length, 1);
  });

  test('autonomous publishing does not change moderation mode (test A18)', async () => {
    await patchSetting('publishing', { mode: 'AUTONOMOUS', autonomous_publishing_enabled: true });
    const s = await getSettings(workerDb());
    assert.equal(s.moderation.mode, 'SHADOW');
    assert.equal(s.moderation.auto_reply_enabled, false);
  });

  test('daily digest reports actual publication results and is generated once (tests 20 and A19)', async () => {
    await patchSetting('publishing', { mode: 'AUTONOMOUS', autonomous_publishing_enabled: true });
    await superDb().query("update ufs_agent.sources set verified_at = now() - interval '200 days'");
    const d = await deps();
    await generateUpcoming(workerDb(), d, { workerId: 'g' });
    await publishDue(workerDb(), { ...d, now: new Date('2026-11-16T17:00:30Z') }, { workerId: 'p' });
    const nextMorning = new Date('2026-11-17T07:00:00Z');
    const first = await runDailyDigest(workerDb(), { now: nextMorning });
    const second = await runDailyDigest(workerDb(), { now: nextMorning });
    assert.equal(first.status, 'dry_run');
    assert.equal(second.status, 'already_generated');
    assert.match(first.body, /evening on FB mock: published https:\/\/example\.invalid\/mock\//);
    assert.match(first.body, /morning: Government organisation: skipped \(source_verification_stale/);
    assert.ok(!/@/.test(first.body.replace(/https?:\/\/\S+/g, '')), 'no email addresses in digest');
    assert.equal((await superDb().query("select count(*)::int as n from ufs_agent.digests where kind='daily'"))[0].n, 1);
  });

  test('full tick in default SHADOW mode simulates and never calls a provider', async () => {
    const adapterFor = mockRegistry();
    const summary = await runTick(workerDb(), { now: new Date('2026-11-16T08:01:00Z'), adapterFor, model: editorialModel(), net: fakeNet({ [SRC_URL]: { body: SRC_HTML, contentType: 'text/html' } }), jobs: undefined });
    assert.equal(summary.mode.publishing, 'SHADOW');
    for (const a of adapterFor.map.values()) assert.equal(a.posts.length, 0);
  });
});
