import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentMatchesOriginal } from '../../../lib/agent/executor.js';

test('comment integrity accepts only exactly the approved text', () => {
  assert.equal(commentMatchesOriginal('What is United for Sitges?', 'What is United for Sitges?'), true);
  assert.equal(commentMatchesOriginal('What is United for Sitges? Edited', 'What is United for Sitges?'), false);
  assert.equal(commentMatchesOriginal(null, 'What is United for Sitges?'), false);
  assert.equal(commentMatchesOriginal('What is United for Sitges?', null), false);
  assert.equal(commentMatchesOriginal('x'.repeat(2001), 'x'.repeat(2000)), false);
  assert.equal(commentMatchesOriginal('  Hello\n', 'Hello'), true);
});
