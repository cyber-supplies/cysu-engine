// The API behind the CLI's slash commands: /workspace, /load, /run, /runs,
// /watch (feed), /cancel, /download — with the "current" workspace and short
// run ids. Real engine + stand-in Cyber Supplies API + stand-in Codex stages.
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
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) break;
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
  return fetch(`${base}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
}
const ws = (ref, rest = '') => `/api/workspaces/${encodeURIComponent(ref)}${rest}`;

test('/workspace: a new workspace becomes current; status shows it; drafts are allowed', async () => {
  assert.equal((await http('/api/status')).body.workspace, null);
  const r = await http('/api/workspaces', 'POST', { name: 'My recon' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.current, true);
  assert.deepEqual(r.body.request, { prompt: '', stages: [] }, 'an empty draft to load profiles into');
  assert.equal((await http('/api/status')).body.workspace, 'My recon');
  const view = (await http(ws('current'))).body;
  assert.equal(view.name, 'My recon');
  assert.equal(view.plan, null);
  assert.match(view.planError, /stage|prompt/i, 'the draft says what it still needs');
  assert.equal((await http('/api/workspaces', 'POST', { name: 'current' })).status, 400, '"current" is reserved');
});

test('/load: add stage profiles in order, skip duplicates, refuse unknown ones, set the global profile, remove', async () => {
  let r = await http(ws('my RECON', '/profiles'), 'POST', { add: ['recon', 'attack'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.skipped], [['recon', 'attack'], []]);
  r = await http(ws('current', '/profiles'), 'POST', { add: ['attack', 'escalate'], global: 'global' });
  assert.deepEqual([r.body.added, r.body.skipped], [['escalate'], ['attack']]);
  assert.deepEqual(r.body.request.stages.map((s) => s.profile), ['recon', 'attack', 'escalate']);
  assert.equal(r.body.request.globalProfile, 'global');

  r = await http(ws('current', '/profiles'), 'POST', { add: ['not-mine'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Not one of your profiles: not-mine/);
  r = await http(ws('current', '/profiles'), 'POST', { global: 'nope' });
  assert.match(r.body.error, /Not one of your profiles: nope/);
  r = await http(ws('current', '/profiles'), 'POST', { remove: ['escalate'] });
  assert.deepEqual(r.body.request.stages.map((s) => s.profile), ['recon', 'attack']);
  r = await http(ws('current', '/profiles'), 'POST', { remove: ['triage'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /triage is not a stage of "My recon"/);
  assert.equal((await http(ws('current', '/profiles'), 'POST', {})).status, 400);
  assert.equal((await http(ws('current', '/profiles'), 'POST', { add: 'recon' })).status, 400);

  await http('/api/workspaces', 'POST', { name: 'Tagged', request: { prompt: 'p', fromTags: {} } });
  r = await http(ws('Tagged', '/profiles'), 'POST', { add: ['recon'] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /builds its stages from profile tags/);
});

test('/workspace <name>: switch the current workspace; listing marks it', async () => {
  assert.equal((await http('/api/status')).body.workspace, 'Tagged', 'the newest one is current');
  const r = await http(ws('my recon', '/select'), 'POST');
  assert.equal(r.body.current, true);
  const list = (await http('/api/workspaces')).body;
  assert.deepEqual(list.filter((w) => w.current).map((w) => w.name), ['My recon']);
  assert.equal((await http(ws('nope', '/select'), 'POST')).status, 404);
});

let runId;
test('/run: refused while the workspace is incomplete; then the USER starts it', async () => {
  let r = await http(ws('current', '/run'), 'POST');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /prompt/i);
  await http(ws('current'), 'PATCH', { request: { ...(await http(ws('current'))).body.request, prompt: 'Map example.com (authorized).' } });
  r = await http(ws('current', '/run'), 'POST');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  runId = r.body.id;
  assert.equal(r.body.name, 'My recon');
  assert.equal(r.body.workspace.name, 'My recon');
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
  const dl = await fetch(`${base}/api/runs/${short}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/gzip');
  assert.equal((await http(`/api/runs/${short}/cancel`, 'POST')).status, 409, 'not active');
  assert.equal((await http('/api/runs/abc')).status, 404, 'too short');
  assert.equal((await http('/api/runs/zzzzzzzz')).status, 404);
  assert.equal((await http(`/api/runs/${short}/stages/0/log`)).status, 200);
  assert.equal((await http('/api/runs')).body[0].workspace.name, 'My recon', '/runs shows where each run came from');
});

test('deleting the current workspace clears "current"', async () => {
  assert.equal((await http(ws('current'), 'DELETE')).status, 204);
  assert.equal((await http('/api/status')).body.workspace, null);
  const r = await http(ws('current'));
  assert.equal(r.status, 404);
  assert.match(r.body.error, /No current workspace/);
});

test('settings: only a USER token (usr_…) is accepted; an LLM token is refused', async () => {
  const r = await http('/api/settings', 'PUT', { token: 'llm_0123456789abcdef' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /needs your Cyber Supplies user token \(it starts with usr_\)/);
  assert.equal((await http('/api/settings', 'PUT', { token: TOKEN })).status, 200);
});

test('settings: the assistant\'s model can be chosen ("" = default), and is checked', async () => {
  let r = await http('/api/settings', 'PUT', { agentModel: 'gpt-6.1-sol' });
  assert.equal(r.body.agentModel, 'gpt-6.1-sol');
  assert.equal((await http('/api/status')).body.llm.model, 'gpt-6.1-sol');
  assert.equal((await http('/api/settings', 'PUT', { agentModel: 'bad model!' })).status, 400);
  r = await http('/api/settings', 'PUT', { agentModel: '' });
  assert.equal(r.body.agentModel, '');
});

test('unknown ids on log/feed/events endpoints get a clean 404, and the engine stays up', async () => {
  const z = '00000000-0000-4000-8000-000000000000';
  for (const path of [`/api/chats/${z}/log`, `/api/runs/${z}/stages/0/log`, `/api/runs/${z}/feed`, `/api/runs/${z}/stages/0/events`, `/api/runs/${z}/download`, `/api/chats/${z}/messages`]) {
    const r = await http(path);
    assert.equal(r.status, 404, path);
    assert.match(r.body.error, /not found/i, path);
  }
  assert.equal((await http('/api/status')).status, 200, 'the engine must still be running');
});
