// Schedules: timing rules (with clock changes), validation and storage.
// No Docker needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schedules, ScheduleError, nextTime, toInstant, checkWhen, checkTimezone, describe, HISTORY_LIMIT } from '../server/schedules.js';

const at = (s) => Date.parse(s);
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const next = (when, tz, after, anchor) => iso(nextTime(checkWhen(when), tz, at(after), anchor === undefined ? undefined : at(anchor)));

function memoryStore() {
  const data = {};
  return { data, load: async (k, f) => (k in data ? structuredClone(data[k]) : f), save: async (k, v) => { data[k] = structuredClone(v); } };
}

test('daily: later today, else tomorrow; follows the timezone', () => {
  assert.equal(next({ type: 'daily', time: '09:00' }, 'UTC', '2026-11-07T08:00:00Z'), '2026-11-07T09:00:00.000Z');
  assert.equal(next({ type: 'daily', time: '09:00' }, 'UTC', '2026-11-07T09:00:00Z'), '2026-11-08T09:00:00.000Z'); // strictly after
  // 09:00 in New York (EST, UTC-5) is 14:00 UTC
  assert.equal(next({ type: 'daily', time: '09:00' }, 'America/New_York', '2026-11-07T12:00:00Z'), '2026-11-07T14:00:00.000Z');
  // 09:00 in Tokyo on the 8th is 00:00 UTC on the 8th
  assert.equal(next({ type: 'daily', time: '09:00' }, 'Asia/Tokyo', '2026-11-07T12:00:00Z'), '2026-11-08T00:00:00.000Z');
});

test('weekdays skip the weekend; weekly picks listed days', () => {
  // 2026-11-07 is a Saturday
  assert.equal(next({ type: 'weekdays', time: '09:00' }, 'UTC', '2026-11-07T08:00:00Z'), '2026-11-09T09:00:00.000Z');
  assert.equal(next({ type: 'weekdays', time: '09:00' }, 'UTC', '2026-11-13T10:00:00Z'), '2026-11-16T09:00:00.000Z'); // Fri after 9 → Mon
  assert.equal(next({ type: 'weekly', time: '18:30', days: ['thu', 'tue'] }, 'UTC', '2026-11-07T08:00:00Z'), '2026-11-10T18:30:00.000Z');
  assert.equal(next({ type: 'weekly', time: '18:30', days: ['sat'] }, 'UTC', '2026-11-07T19:00:00Z'), '2026-11-14T18:30:00.000Z'); // a week on
});

test('once: the time if still ahead, else nothing', () => {
  assert.equal(next({ type: 'once', at: '2026-11-08T21:00' }, 'Europe/London', '2026-11-07T00:00:00Z'), '2026-11-08T21:00:00.000Z');
  assert.equal(next({ type: 'once', at: '2026-07-08T21:00' }, 'Europe/London', '2026-07-01T00:00:00Z'), '2026-07-08T20:00:00.000Z'); // BST
  assert.equal(next({ type: 'once', at: '2026-11-06T21:00' }, 'Europe/London', '2026-11-07T00:00:00Z'), null);
});

test('every N hours: from when it was saved, or from its start', () => {
  assert.equal(next({ type: 'every', hours: 6 }, 'UTC', '2026-11-07T10:00:00Z', '2026-11-07T10:00:00Z'), '2026-11-07T16:00:00.000Z');
  assert.equal(next({ type: 'every', hours: 6 }, 'UTC', '2026-11-07T16:00:00Z', '2026-11-07T10:00:00Z'), '2026-11-07T22:00:00.000Z');
  // after a long gap it lands on the grid, not now + 6h
  assert.equal(next({ type: 'every', hours: 6 }, 'UTC', '2026-11-09T01:00:00Z', '2026-11-07T10:00:00Z'), '2026-11-09T04:00:00.000Z');
  // with a start: the first run is AT the start, then every N hours from it
  assert.equal(next({ type: 'every', hours: 2, start: '2026-11-08T08:00' }, 'Europe/London', '2026-11-07T00:00:00Z'), '2026-11-08T08:00:00.000Z');
  assert.equal(next({ type: 'every', hours: 2, start: '2026-11-08T08:00' }, 'Europe/London', '2026-11-08T08:00:00Z'), '2026-11-08T10:00:00.000Z');
  assert.equal(next({ type: 'every', hours: 2, start: '2026-11-08T08:00' }, 'Europe/London', '2026-11-08T13:59:00Z'), '2026-11-08T14:00:00.000Z');
});

test('clock changes: gaps move forward, repeated times run once', () => {
  // London springs forward 2027-03-28 01:00 → 02:00; 01:30 does not exist → runs at 02:30 BST = 01:30 UTC
  assert.equal(iso(toInstant({ year: 2027, month: 3, day: 28, hour: 1, minute: 30 }, 'Europe/London')), '2027-03-28T01:30:00.000Z');
  // London falls back 2026-10-25 02:00 → 01:00; 01:30 happens twice → the first (BST) one, 00:30 UTC
  assert.equal(iso(toInstant({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, 'Europe/London')), '2026-10-25T00:30:00.000Z');
  // daily 01:30 around fall back: once on the 25th, then normal on the 26th
  const first = next({ type: 'daily', time: '01:30' }, 'Europe/London', '2026-10-24T12:00:00Z');
  assert.equal(first, '2026-10-25T00:30:00.000Z');
  assert.equal(next({ type: 'daily', time: '01:30' }, 'Europe/London', first), '2026-10-26T01:30:00.000Z');
  // 09:00 New York keeps local 09:00 across the US change (2026-11-01)
  assert.equal(next({ type: 'daily', time: '09:00' }, 'America/New_York', '2026-10-31T14:00:00Z'), '2026-11-01T14:00:00.000Z');
  assert.equal(next({ type: 'daily', time: '09:00' }, 'America/New_York', '2026-10-30T12:00:00Z'), '2026-10-30T13:00:00.000Z');
  // a half-hour zone
  assert.equal(next({ type: 'daily', time: '09:00' }, 'Asia/Kolkata', '2026-11-07T00:00:00Z'), '2026-11-07T03:30:00.000Z');
});

test('validation gives clear messages', () => {
  const bad = (when, re) => assert.throws(() => checkWhen(when), (e) => e instanceof ScheduleError && e.status === 400 && re.test(e.message));
  bad(undefined, /needs "when"/);
  bad({ type: 'cron', time: '* * * * *' }, /one of once, daily/);
  bad({ type: 'daily', time: '9:00' }, /HH:MM/);
  bad({ type: 'daily', time: '24:00' }, /HH:MM/);
  bad({ type: 'daily', time: '09:00', days: ['mon'] }, /don't take: days/);
  bad({ type: 'weekly', time: '09:00', days: [] }, /must list days/);
  bad({ type: 'weekly', time: '09:00', days: ['mon', 'funday'] }, /Unknown day.*funday/);
  bad({ type: 'once', at: '2026-02-30T09:00' }, /not a real date/);
  bad({ type: 'once', at: '2026-11-08 09:00' }, /YYYY-MM-DDTHH:MM/);
  bad({ type: 'every', hours: 0 }, /1 to 168/);
  bad({ type: 'every', hours: 1.5 }, /1 to 168/);
  assert.deepEqual(checkWhen({ type: 'weekly', time: '09:00', days: ['Thursday', 'mon', 'MON'] }), { type: 'weekly', time: '09:00', days: ['mon', 'thu'] });
  assert.equal(checkTimezone('europe/london'), 'Europe/London');
  assert.throws(() => checkTimezone('Mars/Olympus'), /Unknown timezone/);
  assert.throws(() => checkTimezone(''), /needs a timezone/);
  assert.equal(describe(checkWhen({ type: 'weekdays', time: '09:00' }), 'Europe/London'), 'every weekday at 09:00 (Europe/London)');
});

test('storage: create, list, get, update, pause, resume, delete', async () => {
  const store = memoryStore();
  let now = at('2026-11-07T10:00:00Z');
  const s = new Schedules({ store, now: () => now, workspaceExists: async (id) => id === 'ws-1' || id === 'ws-2' });

  await assert.rejects(s.create({ workspaceId: 'nope', when: { type: 'daily', time: '09:00' }, tz: 'UTC' }), /No workspace/);
  await assert.rejects(s.create({ workspaceId: 'ws-1', when: { type: 'once', at: '2026-11-01T09:00' }, tz: 'UTC' }), /in the past/);

  const a = await s.create({ workspaceId: 'ws-1', name: '  morning   recon ', when: { type: 'weekdays', time: '09:00' }, tz: 'Europe/London' });
  assert.equal(a.name, 'morning recon');
  assert.equal(a.nextAt, '2026-11-09T09:00:00.000Z');
  assert.equal(a.summary, 'every weekday at 09:00 (Europe/London)');
  assert.equal(a.enabled, true);
  assert.deepEqual(a.history, []);
  assert.equal(store.data.schedules.length, 1);

  const b = await s.create({ workspaceId: 'ws-2', when: { type: 'every', hours: 4 }, tz: 'UTC' });
  assert.equal(b.nextAt, '2026-11-07T14:00:00.000Z');
  assert.deepEqual((await s.list()).map((x) => x.id), [a.id, b.id]);
  assert.equal((await s.get(a.id)).workspaceId, 'ws-1');
  await assert.rejects(s.get(a.id.slice(0, 8)), /No schedule/); // exact ids only

  const paused = await s.pause(a.id);
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextAt, null);

  now = at('2026-11-09T12:00:00Z'); // Monday after 09:00
  const resumed = await s.resume(a.id);
  assert.equal(resumed.nextAt, '2026-11-10T09:00:00.000Z'); // no catch-up for the time it was paused

  const moved = await s.update(b.id, { when: { type: 'daily', time: '07:15' }, tz: 'Asia/Tokyo', workspaceId: 'ws-1' });
  assert.equal(moved.nextAt, '2026-11-09T22:15:00.000Z');
  assert.equal(moved.workspaceId, 'ws-1');
  await assert.rejects(s.update(b.id, { colour: 'red' }), /Can't change: colour/);
  await assert.rejects(s.update(b.id, { workspaceId: 'gone' }), /No workspace/);
  await assert.rejects(s.update(b.id, { enabled: 'yes' }), /true or false/);

  const removed = await s.delete(b.id);
  assert.equal(removed.id, b.id);
  assert.deepEqual((await s.list()).map((x) => x.id), [a.id]);
  await assert.rejects(s.delete(b.id), (e) => e.status === 404);
});

test('change keeps a short newest-first history', async () => {
  const store = memoryStore();
  const s = new Schedules({ store, now: () => at('2026-11-07T10:00:00Z') });
  const a = await s.create({ workspaceId: 'ws', when: { type: 'daily', time: '09:00' }, tz: 'UTC' });
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
    await s.change(a.id, (x) => ({ schedule: x, event: { kind: 'missed', n: i } }));
  }
  const got = await s.get(a.id);
  assert.equal(got.history.length, HISTORY_LIMIT);
  assert.equal(got.history[0].n, HISTORY_LIMIT + 4);
  assert.equal(got.history[0].at, '2026-11-07T10:00:00.000Z');
  assert.equal(await s.change('missing', (x) => ({ schedule: x })), null);
});

test('limit on the number of schedules', async () => {
  const store = memoryStore();
  store.data.schedules = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, createdAt: '2026-01-01T00:00:00.000Z' }));
  const s = new Schedules({ store });
  await assert.rejects(s.create({ workspaceId: 'ws', when: { type: 'daily', time: '09:00' }, tz: 'UTC' }), (e) => e.status === 409 && /at most 100/.test(e.message));
});
