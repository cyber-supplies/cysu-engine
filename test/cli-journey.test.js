// The whole `cysu engine` journey, done exactly the way docs/CLI.md tells the
// CLI to do it: setup → chat (the assistant builds a workspace) → /load →
// /workspace → /run → /watch → /runs → /download → ask the assistant about
// the results → /new. Real engine, REAL Codex as the assistant (Code Mode, like
// a real model) against a stand-in LLM, stand-in Cyber Supplies API, stand-in
// Codex in the stage containers. If this passes, the CLI only has to make
// these same calls.
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
import { startFakeLlm } from './fixtures/fake-llm.js';

const TOKEN = 'usr_journey-test-token-8b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let api, llm, dir, server, base;
const IN_CONTAINER = process.env.CYSU_TEST_ENGINE === 'container';
const tag = Math.random().toString(16).slice(2, 8);
const names = { container: `cysu-engine-test-${tag}`, data: `cysu-engine-test-data-${tag}`, agent: `cysu-engine-test-agent-${tag}` };

before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  llm = await startFakeLlm(gw);
  dir = await mkdtemp(join(tmpdir(), 'cysu-cli-'));
  const port = 26000 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  if (IN_CONTAINER) {
    const testEnv = { CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test', CYSU_ENGINE_AGENT_IMAGE: 'cysu-engine-workspace:dev', CYSU_API_URL: api.url,
      CYSU_ENGINE_TEST_NO_FIREWALL: '1', CYSU_ENGINE_TEST_LLM_CONFIG: llm.codexConfig({ codeMode: true }), CYSU_ENGINE_AGENT_VOLUME: names.agent };
    execFileSync('docker', ['run', '-d', '--name', names.container, '--init', '-p', `127.0.0.1:${port}:8787`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${names.data}:/data`, '-v', `${names.agent}:/run/cysu-engine`,
      ...Object.entries(testEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'cysu-engine:dev']);
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) return;
      await sleep(200);
    }
    throw new Error(`engine container did not start: ${execFileSync('docker', ['logs', names.container]).toString()}`);
  }
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test',
      CYSU_ENGINE_AGENT_IMAGE: 'cysu-engine-workspace:dev', CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1',
      CYSU_ENGINE_TEST_LLM_CONFIG: llm.codexConfig({ codeMode: true }) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) return;
    await sleep(200);
  }
  throw new Error('engine did not start');
});
after(async () => {
  if (IN_CONTAINER) {
    execFileSync('docker', ['stop', '-t', '15', names.container]);
    try { execFileSync('docker', ['rm', '-f', names.container]); execFileSync('docker', ['volume', 'rm', names.data, names.agent]); } catch { /* best effort */ }
  }
  server?.kill('SIGINT');
  await sleep(2000);
  api?.server.close();
  llm?.server.close();
  await rm(dir, { recursive: true, force: true });
});

// The CLI's HTTP calls: JSON body, no Origin header.
const call = (method, path, body) => fetch(`${base}${path}`, {
  method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
const ws = (ref, rest = '') => `/api/workspaces/${encodeURIComponent(ref)}${rest}`;

// The CLI's chat loop (docs/CLI.md §3): send, then print messages as they come.
let chatId;
let after_ = 0;
async function say(text) {
  const sent = await call('POST', `/api/chats/${chatId}/messages`, { text });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const printed = [];
  for (let i = 0; i < 100; i++) {
    const page = (await call('GET', `/api/chats/${chatId}/messages?after=${after_}&wait=20000`)).body;
    printed.push(...page.messages.filter((m) => m.role !== 'user'));
    after_ = page.next;
    if (page.status === 'idle' && page.messages.length === 0) return printed;
  }
  throw new Error('the assistant did not finish');
}

test('1. start: not set up yet', async () => {
  const s = (await call('GET', '/api/status')).body;
  assert.deepEqual([s.configured, s.cysu, s.llm.ready, s.workspace], [false, false, false, null]);
  assert.ok(s.docker, 'Docker available');
});

test('2. setup: user token (an LLM token is refused) + passkey, then the LLM login', async () => {
  let r = await call('PUT', '/api/settings', { token: 'llm_0011223344556677', passkey: 'my passkey' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /user token \(it starts with usr_\)/);
  r = await call('PUT', '/api/settings', { token: TOKEN, passkey: 'my passkey' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.passkey, r.body.token.startsWith('••••')], ['set', true], 'secrets come back masked');
  assert.equal((await call('GET', '/api/status')).body.configured, false, 'LLM still missing');
  r = await call('PUT', '/api/settings', { llm: { mode: 'openai-api-key', apiKey: 'sk-journey' } });
  assert.equal(r.body.llm.mode, 'openai-api-key');
  assert.equal((await call('GET', '/api/status')).body.configured, true);
});

test('3. chat: the assistant builds a workspace from the user\'s profiles; it becomes current', async () => {
  chatId = (await call('POST', '/api/chats', {})).body.id;
  const printed = await say('CALL create_workspace {"name":"Recon then attack","request":{"prompt":"Map example.com (authorized).","globalProfile":"global","fromTags":{"skip":["3","4"]}}}');
  assert.deepEqual(printed.map((m) => `${m.role}${m.tool ? `:${m.tool}:${m.status}` : ''}`), ['tool:create_workspace:done', 'agent']);
  assert.match(printed[1].text, /\/run Recon then attack/);
  assert.equal((await call('GET', '/api/status')).body.workspace, 'Recon then attack', 'shown in the prompt');
  assert.deepEqual((await call('GET', '/api/runs')).body, [], 'nothing started');
});

test('4. /workspace new + /load + /load --global + /unload, then /workspace shows what is missing', async () => {
  let r = await call('POST', '/api/workspaces', { name: 'Picked by hand' });
  assert.equal(r.status, 201);
  r = await call('POST', ws('current', '/profiles'), { add: ['recon', 'escalate', 'triage'] });
  assert.deepEqual(r.body.added, ['recon', 'escalate', 'triage']);
  r = await call('POST', ws('current', '/profiles'), { global: 'global' });
  r = await call('POST', ws('current', '/profiles'), { remove: ['triage'] });
  const view = (await call('GET', ws('current'))).body;
  assert.equal(view.name, 'Picked by hand');
  assert.deepEqual(view.request.stages.map((s) => s.profile), ['recon', 'escalate']);
  assert.equal(view.plan, null);
  assert.match(view.planError, /prompt/i, 'it says the objective is missing');
  assert.equal((await call('POST', ws('current', '/run'))).status, 400, '/run refuses until it is complete');
});

test('5. the assistant sets the objective (it can read and change the current workspace)', async () => {
  const printed = await say('CALL update_workspace {"workspace":"current","request":{"prompt":"Map example.com (authorized).","globalProfile":"global","stages":[{"profile":"recon"},{"profile":"escalate"}]}}');
  assert.equal(printed[0].status, 'done', JSON.stringify(printed));
  const view = (await call('GET', ws('current'))).body;
  assert.deepEqual(view.plan.stages.map((s) => s.profile), ['recon', 'escalate']);
  assert.equal(view.planError, null);
});

let shortId;
test('6. /run + /watch until done', async () => {
  const r = await call('POST', ws('current', '/run'));
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
  const res = await fetch(`${base}/api/runs/${shortId}/download`);
  assert.equal(res.status, 200);
  assert.ok((await res.arrayBuffer()).byteLength > 100);
});

test('8. the assistant shows the results when asked (short run id is fine)', async () => {
  const printed = await say(`CALL get_run {"run_id":"${shortId}"}`);
  assert.equal(printed[0].tool, 'get_run');
  assert.equal(printed[0].status, 'done', printed[0].result);
  assert.match(printed[1].text, /"status":"succeeded"/);
  assert.match(printed[0].result, /untrusted_agent_output/, 'stage answers reach the assistant marked untrusted');
});

test('9. /new starts a fresh chat; the old one keeps its history', async () => {
  const old = chatId;
  chatId = (await call('POST', '/api/chats', {})).body.id;
  after_ = 0;
  assert.notEqual(chatId, old);
  const printed = await say('hello again');
  assert.equal(printed.at(-1).text, 'echo: hello again');
  assert.ok((await call('GET', `/api/chats/${old}`)).body.messages.length > 4);
});
