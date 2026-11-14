// Workspaces (named, saved run setups). No Docker. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workspaces } from '../server/workspaces.js';

// An in-memory stand-in for the engine's JSON store.
function memoryStore(initial = {}) {
  const data = structuredClone(initial);
  return { data, load: async (k, fallback) => (k in data ? structuredClone(data[k]) : fallback), save: async (k, v) => { data[k] = structuredClone(v); } };
}
const req = (model = 'gpt-5') => ({ model, fromTags: {} }); // a workspace has no objective

test('provider survives workspace edits and profile changes; removing it restores automatic selection', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  const created = await ws.create({ name: 'Claude', request: { provider: 'claude', stages: [] } });
  await ws.changeStages(created.id, { add: ['recon'] });
  assert.equal((await ws.get(created.id)).request.provider, 'claude');
  const updated = await ws.update(created.id, { request: { ...(await ws.get(created.id)).request, provider: 'openrouter' } });
  assert.equal(updated.request.provider, 'openrouter');
  const { provider, ...automatic } = updated.request;
  assert.equal((await ws.update(created.id, { request: automatic })).request.provider, undefined);
});

test('create, list (newest first), find ONLY by exact id', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  const a = await ws.create({ name: '  Weekly   recon ', request: req('a') });
  assert.equal(a.name, 'Weekly recon', 'names are tidied');
  await new Promise((r) => setTimeout(r, 5));
  const b = await ws.create({ name: 'Deep test', request: req('b') });
  assert.deepEqual((await ws.list()).map((w) => w.name), ['Deep test', 'Weekly recon']);
  assert.equal((await ws.get(a.id)).name, 'Weekly recon');
  assert.equal((await ws.get(b.id)).name, 'Deep test');
  // Names, other spellings of the id, prefixes and "current" are not references.
  for (const ref of ['Weekly recon', 'weekly RECON', a.id.toUpperCase(), ` ${a.id} `, a.id.slice(0, 8), 'current', '', undefined, null]) {
    await assert.rejects(ws.get(ref), (e) => e.status === 404 && /No workspace with id/.test(e.message), String(ref));
  }
  assert.equal(typeof ws.select, 'undefined', 'no workspace selection');
  assert.equal(typeof ws.current, 'undefined', 'no current workspace');
});

test('names are unique; bad input is refused', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  await ws.create({ name: 'One', request: req() });
  await assert.rejects(ws.create({ name: 'one', request: req() }), (e) => e.status === 409);
  await assert.rejects(ws.create({ name: '  ', request: req() }), (e) => e.status === 400 && /needs a name/.test(e.message));
  await assert.rejects(ws.create({ name: 'x'.repeat(81), request: req() }), (e) => e.status === 400);
  await assert.rejects(ws.create({ name: 'Two', request: 'not an object' }), (e) => e.status === 400 && /run request/.test(e.message));
  await assert.rejects(ws.create({ name: 'Two', request: [] }), (e) => e.status === 400);
  assert.equal((await ws.create({ name: 'current', request: req() })).name, 'current', '"current" is just a name now');
});

test('update: rename and/or replace the request; renaming onto another name is refused', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  const a = await ws.create({ name: 'A', request: req('first') });
  await ws.create({ name: 'B', request: req() });
  await assert.rejects(ws.update('A', { name: 'Alpha' }), (e) => e.status === 404, 'not by name');
  const renamed = await ws.update(a.id, { name: 'Alpha' });
  assert.equal(renamed.name, 'Alpha');
  assert.equal(renamed.request.model, 'first', 'request kept when not given');
  const changed = await ws.update(a.id, { request: req('second') });
  assert.equal(changed.request.model, 'second');
  assert.ok(changed.updatedAt >= renamed.updatedAt);
  await assert.rejects(ws.update(a.id, { name: 'b' }), (e) => e.status === 409);
});

test('delete', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  const g = await ws.create({ name: 'Gone', request: req() });
  await assert.rejects(ws.delete('Gone'), (e) => e.status === 404, 'not by name');
  await ws.delete(g.id);
  assert.deepEqual(await ws.list(), []);
  await assert.rejects(ws.delete(g.id), (e) => e.status === 404);
});

test('old "saved setups" (workflows.json) become workspaces once', async () => {
  const store = memoryStore({ workflows: [
    { id: 'w1', name: 'Old setup', request: { prompt: 'old', fromTags: {} }, updatedAt: '2026-11-01T10:00:00.000Z' },
    { id: 'w2', name: 'Legacy UI workflow', task: 'x', steps: [] }, // the very first base format: no request → skipped
  ] });
  const ws = new Workspaces({ store });
  const list = await ws.list();
  assert.deepEqual(list.map((w) => [w.id, w.name, w.request.prompt]), [['w1', 'Old setup', 'old']]);
  assert.ok(Array.isArray(store.data.workspaces), 'saved under the new name');
  await ws.create({ name: 'New', request: req() });
  assert.equal((await new Workspaces({ store }).list()).length, 2, 'migration does not run again');
});

test('/load keeps each profile\'s stage tag (so per-tag models and follow-ups reach it)', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  const w = await ws.create({ name: 'Picked', request: { stages: [] } });
  const tags = { recon: '1', attack: '2' }; // odd: no single 1-4 tag
  const out = await ws.changeStages(w.id, { add: ['recon', 'odd', 'attack'], tagOf: (id) => tags[id] || '' });
  assert.deepEqual(out.workspace.request.stages, [{ profile: 'recon', tag: '1' }, { profile: 'odd' }, { profile: 'attack', tag: '2' }]);
  const plain = await ws.changeStages(w.id, { add: ['late'] }); // no tagOf given: no tag
  assert.deepEqual(plain.workspace.request.stages.at(-1), { profile: 'late' });
});

test('concurrent creates do not lose each other', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  await Promise.all(Array.from({ length: 10 }, (_, i) => ws.create({ name: `W${i}`, request: req() })));
  assert.equal((await ws.list()).length, 10);
});

test('no objective in a workspace: refused with a pointer to /run; an empty one is dropped', async () => {
  const ws = new Workspaces({ store: memoryStore() });
  for (const request of [{ prompt: 'scan it', fromTags: {} }, { stages: [{ profile: 'recon', prompt: 'scan it' }] }]) {
    await assert.rejects(ws.create({ name: 'X', request }), (e) => e.status === 400 && /no objective; give it when you start a run/.test(e.message));
  }
  const a = await ws.create({ name: 'Blank', request: { prompt: '', stages: [{ profile: 'recon', prompt: '' }] } });
  assert.deepEqual(a.request, { stages: [{ profile: 'recon' }] });
  await assert.rejects(ws.update(a.id, { request: { prompt: 'scan it', stages: [] } }), (e) => e.status === 400);
});

test('takeObjectives: older workspaces hand their objective over, then lose it', async () => {
  const store = memoryStore({ workspaces: [
    { id: 'w1', name: 'Main', request: { prompt: 'recon example.com', stages: [{ profile: 'recon', prompt: 'stage own' }] }, createdAt: 'x', updatedAt: 'x' },
    { id: 'w2', name: 'Stage only', request: { stages: [{ profile: 'recon' }, { profile: 'b', prompt: 'from stage b' }] }, createdAt: 'x', updatedAt: 'x' },
    { id: 'w3', name: 'Empty', request: { prompt: '', fromTags: {} }, createdAt: 'x', updatedAt: 'x' },
    { id: 'w4', name: 'New', request: { fromTags: {} }, createdAt: 'x', updatedAt: 'x' },
  ] });
  const ws = new Workspaces({ store });
  let handed = null;
  const found = await ws.takeObjectives(async (m) => { handed = new Map(m); assert.equal(store.data.workspaces[0].request.prompt, 'recon example.com', 'kept until handed over'); });
  assert.deepEqual([...handed], [['w1', 'recon example.com'], ['w2', 'from stage b']]);
  assert.equal(found.size, 2);
  assert.deepEqual(store.data.workspaces.map((w) => w.request), [
    { stages: [{ profile: 'recon' }] }, { stages: [{ profile: 'recon' }, { profile: 'b' }] }, { fromTags: {} }, { fromTags: {} }]);

  // If handing over fails, nothing is removed (it runs again next start).
  const store2 = memoryStore({ workspaces: [{ id: 'w1', name: 'Main', request: { prompt: 'keep me' }, createdAt: 'x', updatedAt: 'x' }] });
  await assert.rejects(new Workspaces({ store: store2 }).takeObjectives(async () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(store2.data.workspaces[0].request.prompt, 'keep me');
  let called = false;
  assert.equal((await new Workspaces({ store }).takeObjectives(async () => { called = true; })).size, 0);
  assert.equal(called, false, 'nothing to do the second time');
});
