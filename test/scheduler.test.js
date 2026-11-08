// Scheduler: starting runs on time, waiting while busy (one per schedule),
// missed times, restarts, deleted workspaces, runs that can't start.
// A fake clock and a stand-in for runs; no Docker needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schedules } from '../server/schedules.js';
import { Scheduler } from '../server/scheduler.js';

const at = (s) => Date.parse(s);
const MIN = 60_000;

function setup({ start = '2026-11-09T08:00:00Z', workspaces = { 'ws-1': { id: 'ws-1', name: 'recon' }, 'ws-2': { id: 'ws-2', name: 'triage' } } } = {}) {
  const data = {};
  const store = { load: async (k, f) => (k in data ? structuredClone(data[k]) : f), save: async (k, v) => { data[k] = structuredClone(v); } };
  const clock = { now: at(start) };
  const now = () => clock.now;
  const schedules = new Schedules({ store, now, workspaceExists: async (id) => id in workspaces });
  const fake = { busy: false, started: [], failWith: null, n: 0 };
  const scheduler = new Scheduler({
    schedules, now, tickMs: 1e9, log: { error() {} },
    getWorkspace: async (id) => workspaces[id] ?? null,
    isBusy: () => fake.busy,
    startRun: async (ws, s) => {
      if (fake.failWith) throw fake.failWith;
      fake.busy = true;
      const run = { id: `run-${++fake.n}`, createdAt: new Date(clock.now).toISOString() };
      fake.started.push({ run: run.id, workspace: ws.id, schedule: s.id, objective: s.objective });
      return run;
    },
  });
  const advance = async (ms) => { clock.now += ms; await scheduler.tick(); };
  const finishRun = async () => { fake.busy = false; await scheduler.tick(); }; // like Runs.onIdle
  return { data, clock, schedules, scheduler, fake, advance, finishRun, workspaces };
}
const kinds = (s) => s.history.map((h) => h.kind);

test('starts a run when the time comes, then moves to the next time', async () => {
  const t = setup();
  const s = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', name: 'morning', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  await t.scheduler.start();
  await t.advance(59 * MIN);
  assert.equal(t.fake.started.length, 0, 'not before 09:00');
  await t.advance(1 * MIN + 3_000); // 09:00:03, a tick later
  assert.deepEqual(t.fake.started, [{ run: 'run-1', workspace: 'ws-1', schedule: s.id, objective: 'scan it' }]);
  const after = await t.schedules.get(s.id);
  assert.equal(after.nextAt, '2026-11-10T09:00:00.000Z');
  assert.equal(after.queued, false);
  assert.equal(after.lastRun.runId, 'run-1');
  assert.deepEqual(kinds(after), ['started']);
  assert.equal(after.history[0].due, '2026-11-09T09:00:00.000Z');
  await t.advance(10 * MIN);
  assert.equal(t.fake.started.length, 1, 'once per time');
  t.scheduler.stop();
});

test('engine busy: waits, then starts the moment the run ends', async () => {
  const t = setup();
  const s = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  await t.scheduler.start();
  t.fake.busy = true; // the user's own run is going
  await t.advance(60 * MIN + 1_000);
  assert.equal(t.fake.started.length, 0);
  let now = await t.schedules.get(s.id);
  assert.equal(now.queued, true);
  assert.deepEqual(kinds(now), ['waiting']);
  await t.advance(45 * MIN); // still busy, long after the grace time: waiting is not "missed"
  assert.equal(t.fake.started.length, 0);
  await t.finishRun();
  assert.equal(t.fake.started.length, 1);
  now = await t.schedules.get(s.id);
  assert.equal(now.queued, false);
  assert.deepEqual(kinds(now), ['started', 'waiting']);
  assert.equal(now.history[0].due, '2026-11-09T09:00:00.000Z');
});

test('at most one waiting per schedule; several schedules start in the order they came due', async () => {
  const t = setup();
  const hourly = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'every', hours: 1 }, tz: 'UTC' }); // 09:00, 10:00…
  const daily = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-2', when: { type: 'daily', time: '09:30' }, tz: 'UTC' });
  await t.scheduler.start();
  t.fake.busy = true;
  await t.advance(60 * MIN + 1_000); // 09:00 hourly waits
  await t.advance(30 * MIN);          // 09:30 daily waits
  await t.advance(30 * MIN);          // 10:00 hourly again: already waiting → skipped
  const h = await t.schedules.get(hourly.id);
  assert.deepEqual(kinds(h), ['skipped', 'waiting']);
  await t.finishRun();
  assert.deepEqual(t.fake.started.map((x) => x.schedule), [hourly.id], 'the first one due starts first');
  await t.finishRun();
  assert.deepEqual(t.fake.started.map((x) => x.schedule), [hourly.id, daily.id]);
  await t.finishRun();
  assert.equal(t.fake.started.length, 2, 'nothing else was waiting');
});

test('missed while off or asleep: not run, noted once with a count', async () => {
  const t = setup();
  const s = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'every', hours: 1 }, tz: 'UTC' }); // 09:00, 10:00, …
  await t.scheduler.start();
  await t.advance(5 * 60 * MIN + 30 * MIN); // "asleep" until 13:30: 09,10,11,12,13 all missed
  assert.equal(t.fake.started.length, 0);
  const now = await t.schedules.get(s.id);
  assert.deepEqual(kinds(now), ['missed']);
  assert.equal(now.history[0].count, 5);
  assert.equal(now.history[0].due, '2026-11-09T09:00:00.000Z');
  assert.equal(now.nextAt, '2026-11-09T14:00:00.000Z');
  await t.advance(30 * MIN + 1_000);
  assert.equal(t.fake.started.length, 1, 'back to normal at 14:00');
});

test('a little late (within 2 minutes) still runs', async () => {
  const t = setup();
  await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  await t.scheduler.start();
  await t.advance(61 * MIN + 50_000); // 09:01:50
  assert.equal(t.fake.started.length, 1);
});

test('missed at startup: times that passed while the engine was off', async () => {
  const t = setup();
  const s = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  t.clock.now = at('2026-11-11T12:00:00Z'); // the engine was off for 3 days
  await t.scheduler.start();
  assert.equal(t.fake.started.length, 0);
  const now = await t.schedules.get(s.id);
  assert.equal(now.history[0].kind, 'missed');
  assert.equal(now.history[0].count, 3);
  assert.equal(now.nextAt, '2026-11-12T09:00:00.000Z');
});

test('a restart drops runs that were waiting, with a note', async () => {
  const t = setup();
  const s = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  await t.scheduler.start();
  t.fake.busy = true;
  await t.advance(60 * MIN + 1_000);
  assert.equal((await t.schedules.get(s.id)).queued, true);
  t.scheduler.stop();
  // engine restarts: the active run is interrupted, nothing is busy
  t.fake.busy = false;
  const fresh = new Scheduler({ schedules: t.schedules, now: () => t.clock.now, tickMs: 1e9, log: { error() {} },
    getWorkspace: async (id) => t.workspaces[id], isBusy: () => false, startRun: async () => { throw new Error('must not start'); } });
  await fresh.start();
  fresh.stop();
  const now = await t.schedules.get(s.id);
  assert.equal(now.queued, false);
  assert.deepEqual(kinds(now), ['dropped', 'waiting']);
});

test('one-off: runs once, then switches itself off', async () => {
  const t = setup();
  const s = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'once', at: '2026-11-09T09:15' }, tz: 'UTC' });
  await t.scheduler.start();
  t.fake.busy = true; // and it still starts after waiting, although it is switched off
  await t.advance(75 * MIN + 1_000);
  let now = await t.schedules.get(s.id);
  assert.equal(now.enabled, false);
  assert.equal(now.nextAt, null);
  assert.equal(now.queued, true);
  await t.finishRun();
  now = await t.schedules.get(s.id);
  assert.equal(t.fake.started.length, 1);
  assert.equal(now.lastRun.runId, 'run-1');
  await t.advance(48 * 60 * MIN);
  assert.equal(t.fake.started.length, 1);
});

test('pausing while waiting cancels the wait', async () => {
  const t = setup();
  const s = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  await t.scheduler.start();
  t.fake.busy = true;
  await t.advance(60 * MIN + 1_000);
  await t.schedules.pause(s.id);
  await t.finishRun();
  assert.equal(t.fake.started.length, 0);
});

test('deleted workspace: the schedule pauses itself and says why', async () => {
  const t = setup();
  const s = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  delete t.workspaces['ws-1'];
  await t.scheduler.start();
  await t.advance(60 * MIN + 1_000);
  const now = await t.schedules.get(s.id);
  assert.equal(t.fake.started.length, 0);
  assert.equal(now.enabled, false);
  assert.equal(now.nextAt, null);
  assert.equal(now.history[0].kind, 'paused');
  assert.match(now.history[0].reason, /workspace \(ws-1\) was deleted/);
});

test("a run that can't start is noted and not retried", async () => {
  const t = setup();
  const s = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  await t.scheduler.start();
  t.fake.failWith = Object.assign(new Error('Log in to your LLM first'), { status: 400 });
  await t.advance(60 * MIN + 1_000);
  await t.advance(60_000);
  const now = await t.schedules.get(s.id);
  assert.equal(now.history[0].kind, 'failed');
  assert.match(now.history[0].reason, /Log in to your LLM first/);
  assert.equal(now.history.length, 1, 'no retry loop');
  assert.equal(now.queued, false);
  assert.equal(now.lastRun.error, 'Log in to your LLM first');
  assert.equal(now.enabled, true, 'still on for tomorrow');
  assert.equal(now.nextAt, '2026-11-10T09:00:00.000Z');
});

test('the user starting a run at the same moment wins; the schedule keeps waiting', async () => {
  const t = setup();
  const s = await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  await t.scheduler.start();
  t.fake.failWith = Object.assign(new Error('A run is already active'), { status: 409 });
  const realBusy = t.scheduler.isBusy;
  let calls = 0;
  t.scheduler.isBusy = () => (calls++ >= 1 ? true : realBusy()); // free when checked, busy by the time it starts
  await t.advance(60 * MIN + 1_000);
  t.scheduler.isBusy = realBusy;
  t.fake.failWith = null;
  assert.equal((await t.schedules.get(s.id)).queued, true);
  await t.finishRun();
  assert.equal(t.fake.started.length, 1);
});

test('ticks never overlap', async () => {
  const t = setup();
  await t.schedules.create({ objective: 'scan it', workspaceId: 'ws-1', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  await t.scheduler.start();
  t.clock.now += 60 * MIN + 1_000;
  await Promise.all([t.scheduler.tick(), t.scheduler.tick(), t.scheduler.tick()]);
  assert.equal(t.fake.started.length, 1);
});

test("runs get the schedule's own objective; a schedule without one pauses itself", async () => {
  const t = setup();
  await t.schedules.create({ objective: 'nightly recon of example.com', workspaceId: 'ws-1', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  await t.scheduler.start();
  await t.advance(60 * MIN);
  assert.equal(t.fake.started[0].objective, 'nightly recon of example.com');
  await t.finishRun();

  // An older schedule saved before objectives moved (none to adopt).
  const old = await t.schedules.create({ objective: 'x', workspaceId: 'ws-2', when: { type: 'daily', time: '09:30' }, tz: 'UTC' });
  t.data.schedules = t.data.schedules.map((x) => (x.id === old.id ? { ...x, objective: '' } : x));
  await t.advance(30 * MIN);
  const got = await t.schedules.get(old.id);
  assert.equal(got.enabled, false);
  assert.equal(got.history[0].kind, 'paused');
  assert.match(got.history[0].reason, /no objective/);
  assert.equal(t.fake.started.length, 1, 'no run without an objective');
  await assert.rejects(t.schedules.resume(old.id), /needs an objective/);
  assert.equal((await t.schedules.update(old.id, { objective: 'triage', enabled: true })).enabled, true);
});
