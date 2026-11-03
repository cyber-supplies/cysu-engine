// Workspaces (named, saved run setups). No Docker. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workspaces } from '../server/workspaces.js';

// An in-memory stand-in for the engine's JSON store.
function memoryStore(initial = {}) {
  const data = structuredClone(initial);
  return { data, load: async (k, fallback) => (k in data ? structuredClone(data[k]) : fallback), save: async (k, v) => { data[k] = structuredClone(v); } };
}
const req = (prompt = 'p') => ({ prompt, fromTags: {} });

test('create, list (newest first), find by name (any case) or id', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  const a = await ws.create({ name: '  Weekly   recon ', request: req('a') });
  assert.equal(a.name, 'Weekly recon', 'names are tidied');
  await new Promise((r) => setTimeout(r, 5));
  const b = await ws.create({ name: 'Deep test', request: req('b') });
  assert.deepEqual((await ws.list()).map((w) => w.name), ['Deep test', 'Weekly recon']);
  assert.equal((await ws.get('weekly RECON')).id, a.id);
  assert.equal((await ws.get(b.id)).name, 'Deep test');
  await assert.rejects(ws.get('nope'), (e) => e.status === 404 && /No workspace called "nope"/.test(e.message));
});

test('names are unique; bad input is refused', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  await ws.create({ name: 'One', request: req() });
  await assert.rejects(ws.create({ name: 'one', request: req() }), (e) => e.status === 409);
  await assert.rejects(ws.create({ name: '  ', request: req() }), (e) => e.status === 400 && /needs a name/.test(e.message));
  await assert.rejects(ws.create({ name: 'x'.repeat(81), request: req() }), (e) => e.status === 400);
  await assert.rejects(ws.create({ name: 'Two', request: 'not an object' }), (e) => e.status === 400 && /run request/.test(e.message));
  await assert.rejects(ws.create({ name: 'Two', request: [] }), (e) => e.status === 400);
});

test('update: rename and/or replace the request; renaming onto another name is refused', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  const a = await ws.create({ name: 'A', request: req('first') });
  await ws.create({ name: 'B', request: req() });
  const renamed = await ws.update('a', { name: 'Alpha' });
  assert.equal(renamed.name, 'Alpha');
  assert.equal(renamed.request.prompt, 'first', 'request kept when not given');
  const changed = await ws.update(a.id, { request: req('second') });
  assert.equal(changed.request.prompt, 'second');
  assert.ok(changed.updatedAt >= renamed.updatedAt);
  await assert.rejects(ws.update('Alpha', { name: 'b' }), (e) => e.status === 409);
});

test('delete', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  await ws.create({ name: 'Gone', request: req() });
  await ws.delete('gone');
  assert.deepEqual(await ws.list(), []);
  await assert.rejects(ws.delete('gone'), (e) => e.status === 404);
});

test('old "saved setups" (workflows.json) become workspaces once', async () => {
  const store = memoryStore({ workflows: [
    { id: 'w1', name: 'Old setup', request: req('old'), updatedAt: '2026-11-01T10:00:00.000Z' },
    { id: 'w2', name: 'Legacy UI workflow', task: 'x', steps: [] }, // the very first base format: no request → skipped
  ] });
  const ws = new Workspaces({ store });
  const list = await ws.list();
  assert.deepEqual(list.map((w) => [w.id, w.name, w.request.prompt]), [['w1', 'Old setup', 'old']]);
  assert.ok(Array.isArray(store.data.workspaces), 'saved under the new name');
  await ws.create({ name: 'New', request: req() });
  assert.equal((await new Workspaces({ store }).list()).length, 2, 'migration does not run again');
});

test('concurrent creates do not lose each other', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  await Promise.all(Array.from({ length: 10 }, (_, i) => ws.create({ name: `W${i}`, request: req() })));
  assert.equal((await ws.list()).length, 10);
});
