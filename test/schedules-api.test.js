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

const TOKEN = 'usr_schedapi-test-token-5e19';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let api, dir, server, base, ws;

before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  dir = await mkdtemp(join(tmpdir(), 'cysu-schedapi-'));
  const port = 25500 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test', CYSU_API_URL: api.url,
      CYSU_ENGINE_TEST_NO_FIREWALL: '1', CYSU_ENGINE_TEST_SCHEDULER_TICK_MS: '500' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  await http('/api/settings', 'PUT', { token: TOKEN, passkey: 'pk', llm: { mode: 'openai-api-key', apiKey: 'sk-schedapi' } });
  ws = (await http('/api/workspaces', 'POST', { name: 'nightly recon', request: { prompt: 'scheduled hello', stages: [{ profile: 'recon', tag: '1' }] } })).body;
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

// The next whole minute (UTC) as "YYYY-MM-DDTHH:MM", at least 5s away.
function nextMinute() {
  const t = new Date(Math.ceil((Date.now() + 5_000) / 60_000) * 60_000);
  return t.toISOString().slice(0, 16);
}

test('schedules need the engine token', async () => {
  assert.equal((await http('/api/schedules', 'GET', undefined, { auth: false })).status, 401);
  assert.equal((await http('/api/schedules', 'POST', {}, { auth: false })).status, 401);
});

test('create, list, get, edit, pause, resume, delete', async () => {
  let r = await http('/api/schedules', 'POST', { workspaceId: ws.id, name: 'mornings', when: { type: 'weekdays', time: '09:00' }, tz: 'Europe/London' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const s = r.body;
  assert.equal(s.summary, 'every weekday at 09:00 (Europe/London)');
  assert.deepEqual(s.workspace, { id: ws.id, name: 'nightly recon', exists: true });
  assert.equal(s.enabled, true);
  assert.ok(Date.parse(s.nextAt) > Date.now());
  assert.equal(s.waiting, null);
  assert.equal(s.lastRun, null);
  assert.equal(s.anchorAt, undefined, 'internal fields are not shown');

  assert.equal((await http('/api/schedules')).body.length, 1);
  assert.equal((await http(`/api/schedules/${s.id}`)).body.id, s.id);
  assert.equal((await http(`/api/schedules/${s.id.slice(0, 8)}`)).status, 404, 'exact ids only');

  r = await http(`/api/schedules/${s.id}`, 'PATCH', { when: { type: 'weekly', time: '18:30', days: ['sat'] }, tz: 'UTC', name: 'weekend' });
  assert.equal(r.status, 200);
  assert.equal(r.body.summary, 'every sat at 18:30 (UTC)');
  assert.equal(new Date(r.body.nextAt).getUTCDay(), 6);

  r = await http(`/api/schedules/${s.id}/pause`, 'POST');
  assert.equal(r.body.enabled, false);
  assert.equal(r.body.nextAt, null);
  r = await http(`/api/schedules/${s.id}/resume`, 'POST');
  assert.equal(r.body.enabled, true);
  assert.ok(r.body.nextAt);

  assert.equal((await http(`/api/schedules/${s.id}`, 'DELETE')).status, 204);
  assert.equal((await http(`/api/schedules/${s.id}`)).status, 404);
  assert.equal((await http(`/api/schedules/${s.id}`, 'DELETE')).status, 404);
});

test('clear errors for bad input', async () => {
  const bad = async (input, re, status = 400) => {
    const r = await http('/api/schedules', 'POST', input);
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.match(r.body.error, re);
  };
  await bad({ when: { type: 'daily', time: '09:00' }, tz: 'UTC' }, /needs a workspaceId/);
  await bad({ workspaceId: 'nope', when: { type: 'daily', time: '09:00' }, tz: 'UTC' }, /No workspace with id "nope"/);
  await bad({ workspaceId: ws.id, when: { type: 'daily', time: '9am' }, tz: 'UTC' }, /HH:MM/);
  await bad({ workspaceId: ws.id, when: { type: 'daily', time: '09:00' } }, /needs a timezone/);
  await bad({ workspaceId: ws.id, when: { type: 'daily', time: '09:00' }, tz: 'Moon/Base' }, /Unknown timezone/);
  await bad({ workspaceId: ws.id, when: { type: 'once', at: '2020-01-01T09:00' }, tz: 'UTC' }, /in the past/);
  await bad({ workspaceId: ws.id, when: { type: 'cron', expr: '* * * * *' }, tz: 'UTC' }, /one of once, daily/);
  const s = (await http('/api/schedules', 'POST', { workspaceId: ws.id, when: { type: 'daily', time: '09:00' }, tz: 'UTC' })).body;
  const r = await http(`/api/schedules/${s.id}`, 'PATCH', { history: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Can't change: history/);
  await http(`/api/schedules/${s.id}`, 'DELETE');
  assert.equal((await http('/api/runs?trigger=robot')).status, 400);
});

test('the engine starts the run by itself; the user checks on it later', async () => {
  const at = nextMinute();
  let r = await http('/api/schedules', 'POST', { workspaceId: ws.id, name: 'soon', when: { type: 'once', at }, tz: 'UTC' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  assert.equal(r.body.nextAt, `${at}:00.000Z`);
  // A user run by hand, for the filters below.
  const byHand = (await http(`/api/workspaces/${ws.id}/run`, 'POST')).body;
  assert.equal(byHand.trigger, 'user');

  // Nobody does anything now: wait for the engine to start it.
  let s;
  const end = Date.now() + 90_000;
  for (;;) {
    s = (await http(`/api/schedules/${id}`)).body;
    if (s.lastRun && !['queued', 'running'].includes(s.lastRun.status)) break;
    if (Date.now() > end) throw new Error(`not finished: ${JSON.stringify(s)}`);
    await sleep(1000);
  }
  assert.equal(s.lastRun.status, 'succeeded');
  assert.ok(Date.parse(s.lastRun.startedAt) >= Date.parse(`${at}:00Z`));
  assert.equal(s.history[0].kind, 'started');
  assert.equal(s.history[0].runId, s.lastRun.runId);
  assert.equal(s.enabled, false, 'a one-off switches itself off');
  assert.equal(s.nextAt, null);

  const run = (await http(`/api/runs/${s.lastRun.runId}`)).body;
  assert.equal(run.trigger, 'schedule');
  assert.deepEqual(run.schedule, { id, name: 'soon' });
  assert.equal(run.workspace.id, ws.id);
  assert.deepEqual((await http(`/api/runs?schedule=${id}`)).body.map((x) => x.id), [run.id]);
  assert.deepEqual((await http('/api/runs?trigger=schedule')).body.map((x) => x.id), [run.id]);
  assert.ok((await http('/api/runs?trigger=user')).body.some((x) => x.id === byHand.id));
  assert.ok(!(await http('/api/runs?trigger=user')).body.some((x) => x.id === run.id));
});

test('deleting a workspace pauses its schedules, with a note', async () => {
  const other = (await http('/api/workspaces', 'POST', { name: 'to delete', request: { prompt: 'x', stages: [{ profile: 'recon' }] } })).body;
  const s = (await http('/api/schedules', 'POST', { workspaceId: other.id, when: { type: 'daily', time: '09:00' }, tz: 'UTC' })).body;
  assert.equal((await http(`/api/workspaces/${other.id}`, 'DELETE')).status, 204);
  const now = (await http(`/api/schedules/${s.id}`)).body;
  assert.equal(now.enabled, false);
  assert.deepEqual(now.workspace, { id: other.id, name: null, exists: false });
  assert.equal(now.history[0].kind, 'paused');
  assert.match(now.history[0].reason, /"to delete" was deleted/);
  const r = await http(`/api/schedules/${s.id}/resume`, 'POST');
  assert.equal(r.status, 400, 'cannot resume without a workspace');
  assert.match(r.body.error, /No workspace/);
});
