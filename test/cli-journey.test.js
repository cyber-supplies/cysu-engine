// The whole `cysu engine` journey, done exactly the way docs/CLI.md tells the
// CLI to do it: setup → /workspace new → /load → /workspace (by id) → /run →
// /watch → /runs → /download. Real engine, stand-in Cyber Supplies API,
// stand-in Codex in the stage containers. If this passes, the CLI only has to
// make these same calls.
// Needs Docker + both images (npm run image:build && npm run image:build:test).
//
// CYSU_TEST_ENGINE=container runs the same journey against the engine as a
// CONTAINER (npm run engine:build), started like `cysu engine` starts it
// (docs/INSTALL.md), with throwaway volumes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeApi } from './fixtures/fake-api.js';
import { provisionToken } from './fixtures/provision-auth.js';

const TOKEN = 'usr_journey-test-token-8b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let api, dir, server, base;
const IN_CONTAINER = process.env.CYSU_TEST_ENGINE === 'container';
const tag = Math.random().toString(16).slice(2, 8);
const names = { container: `cysu-engine-test-${tag}`, data: `cysu-engine-test-data-${tag}` };

before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  dir = await mkdtemp(join(tmpdir(), 'cysu-cli-'));
  const port = 26000 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  if (IN_CONTAINER) {
    const testEnv = { CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test', CYSU_CLI_VERSION: 'image', CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1' };
    execFileSync('docker', ['run', '-d', '--name', names.container, '--init', '-p', `127.0.0.1:${port}:8787`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${names.data}:/data`,
      ...Object.entries(testEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'cysu-engine:dev']);
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return;
      await sleep(200);
    }
    throw new Error(`engine container did not start: ${execFileSync('docker', ['logs', names.container]).toString()}`);
  }
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test', CYSU_CLI_VERSION: 'image',
      CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return;
    await sleep(200);
  }
  throw new Error('engine did not start');
});
after(async () => {
  if (IN_CONTAINER) {
    execFileSync('docker', ['stop', '-t', '15', names.container]);
    try { execFileSync('docker', ['rm', '-f', names.container]); execFileSync('docker', ['volume', 'rm', names.data]); } catch { /* best effort */ }
  }
  server?.kill('SIGINT');
  await sleep(2000);
  api?.server.close();
  await rm(dir, { recursive: true, force: true });
});

// The CLI's HTTP calls: JSON body, no Origin header.
// After setup every call carries the engine token (the user token).
const call = (method, path, body) => fetch(`${base}${path}`, {
  method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
const ws = (id, rest = '') => `/api/workspaces/${encodeURIComponent(id)}${rest}`;

test('1. start: the engine is up but not set up yet (401 setupRequired)', async () => {
  assert.deepEqual(await fetch(`${base}/api/health`).then((r) => r.json()), { ok: true });
  const r = await call('GET', '/api/status');
  assert.equal(r.status, 401);
  assert.equal(r.body.setupRequired, true);
});

test('2. installer provisions the token locally, then authenticated passkey and LLM login', async () => {
  let r = await call('PUT', '/api/settings', { token: TOKEN });
  assert.equal(r.status, 401, 'HTTP cannot enroll a token');
  const provisioned = await provisionToken({ dir, apiUrl: api.url, container: IN_CONTAINER ? names.container : undefined }, TOKEN);
  assert.equal(provisioned.code, 0, provisioned.output);
  r = await call('PUT', '/api/settings', { passkey: 'my passkey' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.passkey, r.body.token.startsWith('••••')], ['set', true], 'secrets come back masked');
  const s = (await call('GET', '/api/status')).body;
  assert.deepEqual([s.configured, s.cysu, s.llm.ready], [false, true, false], 'LLM still missing');
  assert.ok(s.docker, 'Docker available');
  r = await call('PUT', '/api/settings', { llm: { mode: 'openai-api-key', apiKey: 'sk-journey' } });
  assert.equal(r.body.llm.mode, 'openai-api-key');
  assert.equal((await call('GET', '/api/status')).body.configured, true);
});

let tagged, picked;
test('3. /workspace new from profile tags; the CLI keeps the returned id', async () => {
  const r = await call('POST', '/api/workspaces', { name: 'Recon then attack', request: { globalProfile: 'global', fromTags: { skip: ['3', '4'] } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  tagged = r.body.id;
  const view = (await call('GET', ws(tagged))).body;
  assert.deepEqual(view.plan.stages.map((s) => s.profile), ['recon', 'attack', 'attack-b']);
  assert.equal((await call('GET', ws('Recon then attack'))).status, 404, 'names are not references');
  assert.deepEqual((await call('GET', '/api/runs')).body, [], 'nothing started');
});

test('4. /workspace new + /load + /load --global + /unload, then /workspace shows the stages it would run', async () => {
  let r = await call('POST', '/api/workspaces', { name: 'Picked by hand' });
  assert.equal(r.status, 201);
  picked = r.body.id;
  r = await call('POST', ws(picked, '/profiles'), { add: ['recon', 'escalate', 'triage'] });
  assert.deepEqual(r.body.added, ['recon', 'escalate', 'triage']);
  r = await call('POST', ws(picked, '/profiles'), { global: 'global' });
  r = await call('POST', ws(picked, '/profiles'), { remove: ['triage'] });
  const view = (await call('GET', ws(picked))).body;
  assert.equal(view.name, 'Picked by hand');
  assert.deepEqual(view.request.stages.map((s) => s.profile), ['recon', 'escalate']);
  assert.equal(view.planError, null, 'ready: no objective needed in a workspace');
  assert.deepEqual(view.plan.stages.map((s) => s.profile), ['recon', 'escalate']);
});

test('5. a workspace is a blank template: /run asks for the objective', async () => {
  const r = await call('POST', ws(picked, '/run'));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Give the run an objective/);
  const before_ = (await call('GET', ws(picked))).body.request;
  assert.equal((await call('PATCH', ws(picked), { request: { ...before_, prompt: 'x' } })).status, 400, 'no objective in a workspace');
});

let shortId;
test('6. /run + /watch until done', async () => {
  const r = await call('POST', ws(picked, '/run'), { objective: 'Map example.com (authorized).' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  shortId = r.body.id.slice(0, 8);
  let cursor = '';
  const seen = [];
  let feed;
  for (let i = 0; i < 40; i++) {
    feed = (await call('GET', `/api/runs/${shortId}/feed?cursor=${cursor}&wait=20000`)).body;
    seen.push(...feed.items.map((it) => `${it.profile}:${it.kind}`));
    cursor = feed.cursor;
    if (feed.done && !feed.items.length) break;
  }
  assert.equal(feed.run.status, 'succeeded');
  for (const p of ['recon', 'escalate']) assert.ok(seen.includes(`${p}:message`) && seen.includes(`${p}:command`), `${p}: ${seen}`);
});

test('7. /runs and /download', async () => {
  const runs = (await call('GET', '/api/runs')).body;
  assert.equal(runs[0].id.slice(0, 8), shortId);
  assert.equal(runs[0].workspace.name, 'Picked by hand');
  const res = await fetch(`${base}/api/runs/${shortId}/download`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  assert.ok((await res.arrayBuffer()).byteLength > 100);
});

test('8. reset-auth locks the API until local provisioning; workspaces and runs are kept', async () => {
  const out = IN_CONTAINER
    ? execFileSync('docker', ['exec', names.container, 'node', 'server/reset-auth.js']).toString()
    : execFileSync(process.execPath, ['server/reset-auth.js'], { env: { ...process.env, CYSU_ENGINE_DATA: dir } }).toString();
  assert.match(out, /Engine token removed/);
  let r = await call('GET', '/api/status');
  assert.deepEqual([r.status, r.body.setupRequired], [401, true]);
  r = await call('PUT', '/api/settings', { token: TOKEN });
  assert.equal(r.status, 401, 'reset never reopens HTTP enrollment');
  const provisioned = await provisionToken({ dir, apiUrl: api.url, container: IN_CONTAINER ? names.container : undefined }, TOKEN);
  assert.equal(provisioned.code, 0, provisioned.output);
  assert.equal((await call('GET', '/api/status')).body.configured, true, 'passkey + LLM login kept');
  assert.equal((await call('GET', ws(picked))).body.name, 'Picked by hand');
  assert.equal((await call('GET', '/api/runs')).body[0].id.slice(0, 8), shortId);
});
