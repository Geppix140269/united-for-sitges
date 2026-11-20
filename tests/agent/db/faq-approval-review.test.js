import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, setTestEnv, resetDb, superDb, closeDbs, addApprovedFaq } from '../helpers.js';

describe('Security regression: FAQ approval scope and validity', { skip: dbSkip }, () => {
  before(() => setTestEnv());
  beforeEach(async () => { await resetDb(); });
  after(() => closeDbs());

  for (const [label, sql, value] of [
    ['allowed platforms', 'allowed_channels=$2::text[]', ['mock','facebook_page','instagram']],
    ['expiration date', 'expires_at=now()+interval \'120 days\'', null],
    ['factual classification', 'is_factual=true', null],
    ['factual source URL', 'source_url=$2::text', 'https://www.sitges.cat/'],
    ['source verification time', 'source_verified_at=now()', null],
    ['question semantics', 'canonical_question=$2::text', 'Who manages United for Sitges?'],
    ['matching phrases', 'match_phrases=$2::text[]', ['who is u4s']],
    ['answer wording', 'approved_answer=$2::text', 'Updated answer approved by nobody'],
    ['language', 'language=$2::text', 'es'],
  ]) {
    test(`changing ${label} revokes prior approval`, async () => {
      const faq = await addApprovedFaq();
      assert.equal(faq.active, true);
      const params = value === null ? [faq.id] : [faq.id, value];
      const rows = await superDb().query(
        `update ufs_agent.faq set ${sql} where id=$1 returning active, approved_by, approved_at, answer_fingerprint`, params,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].active, false);
      assert.equal(rows[0].approved_by, null);
      assert.equal(rows[0].approved_at, null);
      assert.equal(rows[0].answer_fingerprint, null);
    });
  }

  test('updating non-safety metadata does not revoke approval', async () => {
    const faq = await addApprovedFaq();
    const rows = await superDb().query(
      "update ufs_agent.faq set updated_at=now() where id=$1 returning active, approved_by", [faq.id],
    );
    assert.equal(rows[0].active, true);
    assert.equal(rows[0].approved_by, faq.approved_by);
  });
});
