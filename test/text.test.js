// Text the CLI prints comes from agents (untrusted): terminal control codes
// must be stripped so it cannot rewrite the user's screen. No Docker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../server/runs.js';

test('escape sequences and control characters are removed; newlines and tabs stay', () => {
  const evil = 'ok\u001b[2J\u001b[H\u001b]0;pwned\u0007fake prompt$ \u0008\u0008\r\nline2\tcol\u009b31m\u0000end';
  assert.equal(cleanText(evil), 'ok[2J[H]0;pwnedfake prompt$ \nline2\tcol31mend');
  assert.equal(cleanText('plain text\nnext'), 'plain text\nnext');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText('ünïcødé ✓ 漢字'), 'ünïcødé ✓ 漢字');
});
