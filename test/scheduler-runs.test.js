// Scheduled runs for real: the scheduler starting real stage containers
// through Runs, waiting while a run is active and starting the moment it ends
// (Runs.onIdle). Fake clock; stand-in Cyber Supplies API and stand-in Codex.
// Needs Docker + the test image (npm run image:build:test).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeApi } from './fixtures/fake-api.js';

const DATA = await mkdtemp(join(tmpdir(), 'cysu-engine-sched-'));
process.env.CYSU_ENGINE_DATA = DATA; // before the server modules load
const { Runs } = await import('../server/runs.js');
const { Schedules } = await import('../server/schedules.js');
const { Scheduler } = await import('../server/scheduler.js');
const { fetchProfiles } = await import('../server/profiles.js');

const TOKEN = 'usr_sched-test-token-7a41';
const SETTINGS = { token: TOKEN, passkey: 'sched-pk', llm: { mode: 'openai-api-key', apiKey: 'sk-sched-test' } };
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = { now: Date.parse('2026-11-09T08:59:00Z') };
const WS = { id: 'ws-sched', name: 'sched recon', request: { prompt: 'scheduled hello', stages: [{ profile: 'recon', tag: '1' }] } };
let api, runs, schedules, scheduler;

before(async () => {
  const gateway = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gateway, TOKEN);
  runs = new Runs({
    dir: join(DATA, 'runs'),
    getSecrets: async () => ({ settings: structuredClone(SETTINGS), codexAuth: null }),
    listProfiles: (settings) => fetchProfiles(settings.token, { apiUrl: api.url }),
    stageOptions: { image: 'cysu-engine-workspace:test', extraEnv: { CYSU_API_URL: api.url, CYSU_EGRESS_GUARD: '0' } },
    onIdle: () => scheduler.tick(),
  });
  await runs.recover();
  schedules = new Schedules({ now: () => clock.now, workspaceExists: async (id) => id === WS.id });
  scheduler = new Scheduler({
    schedules, now: () => clock.now, tickMs: 1e9,
    getWorkspace: async (id) => (id === WS.id ? WS : null),
    startRun: (ws, s) => runs.create({ name: ws.name, ...ws.request, workspace: { id: ws.id, name: ws.name } }, { schedule: { id: s.id, name: s.name } }),
    isBusy: () => runs.busy,
  });
});
after(async () => {
  scheduler?.stop();
  await runs?.close();
  api?.server.close();
  await rm(DATA, { recursive: true, force: true });
});

async function waitFor(fn, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(250);
  }
}

test('a schedule starts a real run, marked as started by the schedule', async () => {
  const s = await schedules.create({ workspaceId: WS.id, name: 'nine o\'clock', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  await scheduler.start();
  assert.equal(runs.busy, false);
  clock.now += MIN + 2_000;
  await scheduler.tick();
  assert.equal(runs.busy, true);
  const { lastRun } = await schedules.get(s.id);
  const run = await waitFor(async () => { const r = await runs.get(lastRun.runId); return ['queued', 'running'].includes(r.status) ? null : r; });
  assert.equal(run.status, 'succeeded', JSON.stringify(run.stages.map((x) => x.errors)));
  assert.equal(run.trigger, 'schedule');
  assert.deepEqual(run.schedule, { id: s.id, name: 'nine o\'clock' });
  assert.deepEqual(run.workspace, { id: WS.id, name: WS.name });
  assert.equal(run.request.schedule, undefined, '"run again" is an ordinary run');
  const onDisk = JSON.parse(await readFile(join(DATA, 'runs', run.id, 'run.json'), 'utf8'));
  assert.equal(onDisk.trigger, 'schedule');
  const listed = (await runs.list()).find((r) => r.id === run.id);
  assert.equal(listed.trigger, 'schedule', 'run lists show who started it');
});

test('while a user run is active the schedule waits, then starts when it ends', async () => {
  const s = await schedules.create({ workspaceId: WS.id, when: { type: 'once', at: '2026-11-09T09:30' }, tz: 'UTC' });
  await waitFor(() => !runs.busy);
  const userRun = await runs.create({ name: 'by hand', ...WS.request });
  assert.equal(userRun.trigger, 'user');
  clock.now = Date.parse('2026-11-09T09:30:05Z');
  await scheduler.tick();
  let now = await schedules.get(s.id);
  assert.equal(now.queued, true);
  assert.equal(now.history[0].kind, 'waiting');
  // No more ticks from the test: the end of the user's run must start it (onIdle).
  now = await waitFor(async () => { const x = await schedules.get(s.id); return x.lastRun ? x : null; });
  assert.equal(now.history[0].kind, 'started');
  assert.equal((await runs.get(userRun.id)).status, 'succeeded');
  const scheduled = await runs.get(now.lastRun.runId);
  assert.equal(scheduled.trigger, 'schedule');
  assert.ok(Date.parse(scheduled.createdAt) >= Date.parse((await runs.get(userRun.id)).finishedAt), 'started after the user run ended');
  await waitFor(async () => !['queued', 'running'].includes((await runs.get(scheduled.id)).status));
});
