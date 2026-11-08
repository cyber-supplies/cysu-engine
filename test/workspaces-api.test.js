// The API behind the CLI's slash commands: /workspace, /load, /run, /runs,
// /watch (feed), /cancel, /download — workspaces by exact id, short run ids. Real engine + stand-in Cyber Supplies API + stand-in Codex stages.
// Needs Docker + both images (npm run image:build && npm run image:build:test).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeApi } from './fixtures/fake-api.js';

const TOKEN = 'usr_wsapi-test-token-3c8d';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let api, dir, server, base;

before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  dir = await mkdtemp(join(tmpdir(), 'cysu-wsapi-'));
  const port = 25000 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test', CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  await http('/api/settings', 'PUT', { token: TOKEN, passkey: 'pk', llm: { mode: 'openai-api-key', apiKey: 'sk-wsapi' } });
});
after(async () => {
  server?.kill('SIGINT');
  await sleep(1500);
  api?.server.close();
  await rm(dir, { recursive: true, force: true });
});

function http(path, method = 'GET', body) {
  const headers = { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) };
  return fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
}
const ws = (ref, rest = '') => `/api/workspaces/${encodeURIComponent(ref)}${rest}`;

let wsId;
test('/workspace: create returns the id; names do not work as references; drafts are allowed', async () => {
  const r = await http('/api/workspaces', 'POST', { name: 'My recon' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  wsId = r.body.id;
  assert.match(wsId, /^[0-9a-f-]{36}$/);
  assert.equal(r.body.current, undefined, 'no current workspace');
  assert.deepEqual(r.body.request, { stages: [] }, 'an empty draft to load profiles into');
  assert.equal((await http('/api/status')).body.workspace, undefined, 'status has no current workspace');
  const view = (await http(ws(wsId))).body;
  assert.equal(view.name, 'My recon');
  assert.equal(view.plan, null);
  assert.match(view.planError, /at least one stage/, 'the draft says what it still needs');
  for (const ref of ['My recon', 'my recon', 'current', wsId.slice(0, 8), wsId.toUpperCase()]) {
    for (const [method, rest] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/profiles'], ['POST', '/run']]) {
      const res = await http(ws(ref, rest), method, method === 'GET' || method === 'DELETE' ? undefined : { name: 'x', add: ['recon'] });
      assert.equal(res.status, 404, `${method} ${ref}${rest}`);
      assert.match(res.body.error, /No workspace with id/);
    }
  }
  assert.equal((await http(ws(wsId))).body.name, 'My recon', 'nothing was changed or deleted by those');
  assert.deepEqual((await http('/api/workspaces')).body.map((w) => [w.id, w.current]), [[wsId, undefined]]);
});

test('/load: add stage profiles in order, skip duplicates, refuse unknown ones, set the global profile, remove', async () => {
  let r = await http(ws(wsId, '/profiles'), 'POST', { add: ['recon', 'attack'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.skipped], [['recon', 'attack'], []]);
  r = await http(ws(wsId, '/profiles'), 'POST', { add: ['attack', 'escalate'], global: 'global' });
  assert.deepEqual([r.body.added, r.body.skipped], [['escalate'], ['attack']]);
  assert.deepEqual(r.body.request.stages, [{ profile: 'recon', tag: '1' }, { profile: 'attack', tag: '2' }, { profile: 'escalate', tag: '3' }], 'tags saved');
  assert.equal(r.body.request.globalProfile, 'global');

  r = await http(ws(wsId, '/profiles'), 'POST', { add: ['not-mine'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Not one of your profiles: not-mine/);
  r = await http(ws(wsId, '/profiles'), 'POST', { global: 'nope' });
  assert.match(r.body.error, /Not one of your profiles: nope/);
  // Per-tag model + follow-up reach /load-ed stages now (they carry their tag).
  const reqNow = (await http(ws(wsId))).body.request;
  assert.equal(reqNow.stages.length, 3);
  r = await http(ws(wsId), 'PATCH', { request: { ...reqNow, modelOverrides: [{ stage: 2, model: 'gpt-attack' }], reprompts: [{ stage: '3', prompt: 'again' }] } });
  assert.equal(r.body.planError, null, r.body.planError);
  assert.deepEqual(r.body.plan.stages.map((s) => `${s.profile}:${s.tag}:${s.model}`), ['recon:1:default', 'attack:2:gpt-attack', 'escalate:3:default']);
  const planned = (await http('/api/runs/plan', 'POST', { ...r.body.request, objective: 'p' })).body;
  assert.deepEqual(planned.stages.map((s) => s.reprompts), [[], [], ['again']]);
  await http(ws(wsId), 'PATCH', { request: reqNow }); // back to the plain draft for the next tests
  r = await http(ws(wsId, '/profiles'), 'POST', { remove: ['escalate'] });
  assert.deepEqual(r.body.request.stages.map((s) => s.profile), ['recon', 'attack']);
  r = await http(ws(wsId, '/profiles'), 'POST', { remove: ['triage'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /triage is not a stage of "My recon"/);
  assert.equal((await http(ws(wsId, '/profiles'), 'POST', {})).status, 400);
  assert.equal((await http(ws(wsId, '/profiles'), 'POST', { add: 'recon' })).status, 400);

  const tagged = (await http('/api/workspaces', 'POST', { name: 'Tagged', request: { fromTags: {} } })).body;
  r = await http(ws(tagged.id, '/profiles'), 'POST', { add: ['recon'] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /builds its stages from profile tags/);
});

test('the assistant, proposals and workspace selection are gone', async () => {
  for (const [method, path] of [['GET', '/api/chats'], ['POST', '/api/chats'], ['GET', '/api/proposals'], ['POST', '/api/proposals/x/approve'],
    ['POST', ws(wsId, '/select')]]) {
    assert.equal((await http(path, method, method === 'POST' ? {} : undefined)).status, 404, `${method} ${path}`);
  }
  const s = (await http('/api/settings', 'PUT', { agentModel: 'gpt-6.1-sol' })).body;
  assert.equal(s.agentModel, undefined, 'no assistant model setting');
  assert.equal((await http('/api/status')).body.llm.model, undefined);
});

let runId;
test('/run: the objective comes with the run; the workspace stays a blank template', async () => {
  const view = (await http(ws(wsId))).body;
  assert.equal(view.planError, null, 'a workspace without an objective is complete');
  for (const body of [undefined, {}, { objective: '  ' }, { objective: 42 }, null]) {
    const r = await http(ws(wsId, '/run'), 'POST', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, /Give the run an objective/);
  }
  let r = await http(ws(wsId), 'PATCH', { request: { ...view.request, prompt: 'Map example.com (authorized).' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no objective; give it when you start a run/);
  r = await http(ws(wsId, '/run'), 'POST', { objective: 'Map example.com (authorized).' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.objective, 'Map example.com (authorized).');
  assert.equal(r.body.request.objective, 'Map example.com (authorized).', '"run again" repeats it');
  assert.deepEqual((await http(ws(wsId))).body.request, view.request, 'the workspace is unchanged');
  runId = r.body.id;
  assert.equal(r.body.name, 'My recon');
  assert.deepEqual(r.body.workspace, { id: wsId, name: 'My recon' });
  assert.deepEqual(r.body.stages.map((s) => s.profile), ['recon', 'attack']);
  assert.equal(r.body.globalProfile, 'global');
});

test('/watch: the feed waits for news and walks through every stage until done', async () => {
  let cursor = '';
  const items = [];
  let feed;
  for (let i = 0; i < 40; i++) {
    const t = Date.now();
    feed = (await http(`/api/runs/${runId.slice(0, 8)}/feed?cursor=${cursor}&wait=15000`)).body;
    assert.ok(feed.items.length > 0 || feed.done || Date.now() - t >= 14_000, 'returned early with nothing new');
    items.push(...feed.items);
    cursor = feed.cursor;
    if (feed.done) break;
  }
  assert.equal(feed.done, true);
  assert.equal(feed.run.status, 'succeeded');
  assert.equal(feed.run.workspace.name, 'My recon');
  for (const stage of [0, 1]) {
    const kinds = items.filter((it) => it.stage === stage).map((it) => it.kind);
    assert.deepEqual([kinds[0], kinds.includes('command'), kinds.includes('message'), kinds.at(-1)], ['attempt', true, true, 'turn'], `stage ${stage}: ${kinds}`);
  }
  const seqs = items.map((it) => `${it.stage}:${it.seq}`);
  assert.equal(new Set(seqs).size, seqs.length, 'no item twice');
  const again = (await http(`/api/runs/${runId}/feed?cursor=${cursor}&wait=5000`)).body;
  assert.deepEqual([again.items, again.done], [[], true], 'a finished run answers at once with nothing new');
});

test('short run ids work for /runs, /download, /cancel; bad ones are clear', async () => {
  const short = runId.slice(0, 8);
  assert.equal((await http(`/api/runs/${short}`)).body.id, runId);
  const dl = await fetch(`${base}/api/runs/${short}/download`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/gzip');
  assert.equal((await http(`/api/runs/${short}/cancel`, 'POST')).status, 409, 'not active');
  assert.equal((await http('/api/runs/abc')).status, 404, 'too short');
  assert.equal((await http('/api/runs/zzzzzzzz')).status, 404);
  assert.equal((await http(`/api/runs/${short}/stages/0/log`)).status, 200);
  assert.equal((await http('/api/runs')).body[0].workspace.name, 'My recon', '/runs shows where each run came from');
});

test('deleting a workspace by id', async () => {
  assert.equal((await http(ws(wsId), 'DELETE')).status, 204);
  const r = await http(ws(wsId));
  assert.equal(r.status, 404);
  assert.match(r.body.error, /No workspace with id/);
});

test('settings: only a USER token (usr_…) is accepted; an LLM token is refused', async () => {
  const r = await http('/api/settings', 'PUT', { token: 'llm_0123456789abcdef' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /needs your Cyber Supplies user token \(it starts with usr_\)/);
  assert.equal((await http('/api/settings', 'PUT', { token: TOKEN })).status, 200);
});

test('unknown ids on log/feed/events endpoints get a clean 404, and the engine stays up', async () => {
  const z = '00000000-0000-4000-8000-000000000000';
  for (const path of [`/api/workspaces/${z}`, `/api/runs/${z}/stages/0/log`, `/api/runs/${z}/feed`, `/api/runs/${z}/stages/0/events`, `/api/runs/${z}/download`]) {
    const r = await http(path);
    assert.equal(r.status, 404, path);
    assert.match(r.body.error, /not found|no workspace/i, path);
  }
  assert.equal((await http('/api/status')).status, 200, 'the engine must still be running');
});
