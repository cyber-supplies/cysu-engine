// Stage ordering from profile tags (the Windmill flow's rules). No Docker.
// Run: node --test test/profiles.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderProfiles, fetchProfiles } from '../server/profiles.js';

const rows = [
  { id: 'triage', tag: ['4'] },
  { id: 'global', tag: [] },
  { id: 'attack-b', tag: ['2'] },
  { id: 'recon', tag: ['1'] },
  { id: 'attack', tag: ['2'] },
  { id: 'escalate', tag: ['3'] },
];
const order = (opts) => orderProfiles(rows, opts).map((s) => `${s.tag}:${s.profile}`);

test('orders by tag, then profile ID; the global profile is not a stage', () => {
  assert.deepEqual(order({ globalProfile: 'global' }),
    ['1:recon', '2:attack', '2:attack-b', '3:escalate', '4:triage']);
});

test('skip leaves out whole stage tags', () => {
  assert.deepEqual(order({ globalProfile: 'global', skip: ['1', '4'] }), ['2:attack', '2:attack-b', '3:escalate']);
});

test('every non-global profile needs exactly one tag 1-4', () => {
  assert.throws(() => orderProfiles(rows, {}), /Profile global must have exactly one stage tag from 1 to 4 \(it has none\)/);
  for (const tag of [['5'], ['1', '2'], ['recon']]) {
    assert.throws(() => orderProfiles([...rows, { id: 'odd', tag }], { globalProfile: 'global' }), /Profile odd must have exactly one stage tag/);
  }
});

test('clear errors for a missing global profile, nothing to run, bad skip, bad data', () => {
  assert.throws(() => order({ globalProfile: 'nope' }), /Global profile nope is not one of your profiles/);
  assert.throws(() => order({ globalProfile: 'global', skip: ['1', '2', '3', '4'] }), /Every stage was skipped/);
  assert.throws(() => orderProfiles([{ id: 'global', tag: [] }], { globalProfile: 'global' }), /no stage profiles/);
  assert.throws(() => order({ globalProfile: 'global', skip: ['5'] }), /skip must be/);
  assert.throws(() => order({ globalProfile: 'global', skip: '1' }), /skip must be/);
  assert.throws(() => orderProfiles([{ id: 'a', tag: ['1'] }, { id: 'a', tag: ['2'] }]), /duplicate profile ID a/);
  assert.throws(() => orderProfiles([{ id: ' a', tag: ['1'] }]), /valid ID/);
  assert.throws(() => orderProfiles([{ id: 'a', tag: '1' }]), /valid ID or tag/);
});

test('fetchProfiles: token required, upstream errors mapped', async () => {
  await assert.rejects(fetchProfiles(''), (e) => e.status === 400);
  const fake = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  await assert.rejects(fetchProfiles('t', { fetchImpl: fake(401, {}) }), (e) => e.status === 401);
  await assert.rejects(fetchProfiles('t', { fetchImpl: fake(500, {}) }), (e) => e.status === 502 && /\(500\)/.test(e.message));
  await assert.rejects(fetchProfiles('t', { fetchImpl: fake(200, { not: 'a list' }) }), (e) => e.status === 502);
  await assert.rejects(fetchProfiles('t', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), (e) => e.status === 502 && /ECONNREFUSED/.test(e.message));
  assert.deepEqual(await fetchProfiles('t', { fetchImpl: fake(200, rows) }), rows);
});
