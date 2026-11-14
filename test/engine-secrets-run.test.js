import { provisionToken } from './fixtures/provision-auth.js';
// End to end: a secret set with /api/secrets reaches a run's agent as an env
// var, and the run's saved events, log, result and download show only
// [secret:NAME]. Real engine + test image (stand-in codex) + stand-in API.
// Needs Docker and both images. Run: npm run test:image

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { startFakeApi } from './fixtures/fake-api.js';

const TOKEN = 'usr_secrets-run-token-4e1f';
const VALUE = 'bb_live_e2e_secret_value_5c6d';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let api, dir, server, base;

before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  dir = await mkdtemp(join(tmpdir(), 'cysu-secrets-run-'));
  const port = 25500 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test', CYSU_CLI_VERSION: 'image', CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50 && !(await fetch(`${base}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(200);
  assert.equal((await provisionToken({ dir, apiUrl: api.url }, TOKEN)).code, 0);
  await http('/api/settings', 'PUT', { passkey: 'pk', llm: { mode: 'openai-api-key', apiKey: 'sk-secrets-run' } });
});
after(async () => {
  server?.kill('SIGINT');
  await sleep(1500);
  api?.server.close();
  await rm(dir, { recursive: true, force: true });
});

async function http(path, method = 'GET', body) {
  const headers = { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const r = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const buffer = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buffer.toString()); } catch { /* not JSON */ }
  return { status: r.status, body: json, raw: buffer };
}

test('a secret set through the API reaches the agent and is masked in the run', async () => {
  assert.equal((await http('/api/secrets/BROWSERBASE_API_KEY', 'PUT', { value: VALUE })).status, 200);
  const ws = (await http('/api/workspaces', 'POST', { name: 'Secrets' })).body.id;
  assert.equal((await http(`/api/workspaces/${ws}/profiles`, 'POST', { add: ['recon'] })).status, 200);
  const run = await http(`/api/workspaces/${ws}/run`, 'POST', { objective: 'ECHO-SECRET' });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  let view;
  for (let i = 0; i < 120; i++) {
    view = (await http(`/api/runs/${run.body.id}`)).body;
    if (['succeeded', 'failed', 'cancelled'].includes(view.status)) break;
    await sleep(500);
  }
  assert.equal(view.status, 'succeeded', JSON.stringify(view));

  const events = await http(`/api/runs/${run.body.id}/stages/0/events`);
  const text = events.raw.toString();
  assert.ok(text.includes('key: [secret:BROWSERBASE_API_KEY]'), 'the agent had the value; the saved event shows the mask');
  assert.match(view.stages[0].result, /using \[secret:BROWSERBASE_API_KEY\]/);

  // Nowhere on disk under the run, and not in the API answers or the download.
  const files = (await readdir(join(dir, 'runs', run.body.id), { recursive: true })).map((f) => join(dir, 'runs', run.body.id, f));
  for (const file of files) {
    const content = await readFile(file).catch(() => null);
    if (content) assert.ok(!content.includes(VALUE), `${file} has the value`);
  }
  for (const path of [`/api/runs/${run.body.id}`, '/api/runs', `/api/runs/${run.body.id}/stages/0/events`, '/api/secrets']) {
    assert.ok(!(await http(path)).raw.includes(VALUE), `${path} has the value`);
  }
  // The download is a .tar.gz: look inside it.
  const download = await http(`/api/runs/${run.body.id}/download`);
  assert.equal(download.status, 200);
  const tar = gunzipSync(download.raw);
  assert.ok(tar.includes('[secret:BROWSERBASE_API_KEY]'), 'the download has the masked events');
  assert.ok(!tar.includes(VALUE), 'the download does not have the value');
});
