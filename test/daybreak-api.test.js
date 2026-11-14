import { provisionToken } from './fixtures/provision-auth.js';
// The schedules API end to end: a real engine process creates a schedule,
// starts the run BY ITSELF when the time comes, and the user checks on it
// afterwards (schedule view, run list filters). Stand-in Cyber Supplies API +
// stand-in Codex. Needs Docker + both images (npm run image:build:test).
// Takes up to ~70s: it waits for the next whole minute.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeApi } from './fixtures/fake-api.js';
const TOKEN = 'usr_daybreakapi-test-token-7c21';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let api, dir, server, base;

before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  dir = await mkdtemp(join(tmpdir(), 'cysu-daybreakapi-'));
  const port = 25900 + Math.floor(Math.random() * 90);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test', CYSU_CLI_VERSION: 'image', CYSU_API_URL: api.url,
      CYSU_ENGINE_TEST_NO_FIREWALL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
});
after(async () => {
  server?.kill('SIGINT');
  await sleep(1500);
  api?.server.close();
  await rm(dir, { recursive: true, force: true });
});

async function http(path, method = 'GET', body, { auth = true } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('the check needs a set-up engine: token first, then an LLM login', async () => {
  assert.equal((await provisionToken({ dir, apiUrl: api.url }, TOKEN)).code, 0);
  let r = await http('/api/settings', 'PUT', { passkey: 'pk' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await http('/api/daybreak/check', 'POST', undefined, { auth: false })).status, 401);
  r = await http('/api/daybreak/check', 'POST');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Set an LLM login first/);
  assert.deepEqual((await http('/api/status')).body.daybreak, { checking: false, lastCheck: null });
});

test('POST /api/daybreak/check: per-program results with advice, saved for /status; runs wait meanwhile', async () => {
  assert.equal((await http('/api/settings', 'PUT', { llm: { mode: 'openai-api-key', apiKey: 'sk-daybreakapi' } })).status, 200);
  assert.equal((await http('/api/daybreak/check', 'POST', { model: 'bad model!' })).status, 400);

  const checking = http('/api/daybreak/check', 'POST');
  await sleep(300);
  const during = await http('/api/runs', 'POST', { prompt: 'p', stages: [{ profile: 'attack' }] });
  assert.equal(during.status, 409);
  assert.match(during.body.error, /Daybreak access check is running/);
  assert.equal((await http('/api/daybreak/check', 'POST')).status, 409, 'one check at a time');
  assert.equal((await http('/api/status')).body.daybreak.checking, true);

  const r = await checking;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x) => `${x.program}:${x.ok}`), ['standard:true', 'blue:true', 'red:false']);
  assert.match(r.body.results[2].hint, /use daybreak "blue" instead/);
  const status = (await http('/api/status')).body.daybreak;
  assert.equal(status.checking, false);
  assert.deepEqual(status.lastCheck, r.body);
  assert.deepEqual((await http('/api/daybreak/check')).body.lastCheck, r.body);
  assert.ok(!JSON.stringify(status).includes('sk-daybreakapi'), 'no secret in the result');
});

test('settings: agentToken defaults to "llm", accepts "user", refuses anything else', async () => {
  assert.equal((await http('/api/settings')).body.agentToken, 'llm');
  let r = await http('/api/settings', 'PUT', { agentToken: 'admin' });
  assert.deepEqual([r.status, r.body.error], [400, 'agentToken must be llm or user']);
  r = await http('/api/settings', 'PUT', { agentToken: 'user' });
  assert.equal(r.body.agentToken, 'user');
  r = await http('/api/settings', 'PUT', { agentToken: 'llm' });
  assert.equal(r.body.agentToken, 'llm');
  assert.ok(!JSON.stringify(r.body).includes('llm_'), 'the LLM token itself is never shown');
});
