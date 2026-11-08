// scheduler.js: starts scheduled runs by itself. Every few seconds (and the
// moment a run ends) it looks at the schedules (schedules.js):
//
//   due now            → wait in line (queued), then start when the engine is
//                        free: the same as /run <workspace>, marked as started
//                        by the schedule.
//   engine busy        → stays queued and starts as soon as the run ends. At
//                        most ONE waiting per schedule: a time that comes while
//                        one is already waiting is skipped and noted.
//   missed             → the time passed while the engine was off or the
//                        machine asleep (more than GRACE_MS late): not run,
//                        noted in the schedule's history, wait for the next.
//   engine restarted   → anything that was waiting is dropped and noted (no
//                        surprise late runs).
//   workspace deleted  → the schedule is paused and the reason noted.
//   can't start        → (no LLM login, a profile is gone…) noted, not retried.
//   no objective       → (an older schedule) paused, with a note.
//
// Every one of these is written to the schedule's history, so the user can
// come back any time and see what happened.

import { nextTime } from './schedules.js';

export const TICK_MS = 5_000;
export const GRACE_MS = 2 * 60_000;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

export class Scheduler {
  // schedules: a Schedules store.
  // getWorkspace(id) → workspace, or null if it no longer exists.
  // startRun(workspace, schedule) → the created run with the schedule's objective (throws when it can't).
  // isBusy() → true while a run is active.
  constructor({ schedules, getWorkspace, startRun, isBusy, now = () => Date.now(), tickMs = TICK_MS, graceMs = GRACE_MS, log = console }) {
    Object.assign(this, { schedules, getWorkspace, startRun, isBusy, now, tickMs, graceMs, log });
    this.timer = null;
    this.running = null; // the tick in progress
    this.again = false;  // a tick was asked for during one
  }

  // start: drop waits left from before a restart, note missed times, then tick.
  async start() {
    for (const s of await this.schedules.all()) {
      if (s.queued) {
        await this.schedules.change(s.id, (x) => ({
          schedule: { ...x, queued: false, queuedAt: null, queuedFor: null },
          event: { kind: 'dropped', due: x.queuedFor ?? null, reason: 'The engine restarted while this run was waiting; it was not started' },
        }));
      }
    }
    await this.tick();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // tick runs one check at a time; a tick asked for during one runs right after.
  tick() {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        try { await this.check(); } catch (error) { this.log.error('scheduler:', error); }
      } while (this.again);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async check() {
    const now = this.now();
    for (const s of await this.schedules.all()) {
      if (!s.enabled || !s.nextAt || Date.parse(s.nextAt) > now) continue;
      await this.due(s.id, now);
    }
    await this.startWaiting();
  }

  // due handles a schedule whose next time has come.
  async due(id, now) {
    await this.schedules.change(id, (s) => {
      if (!s.enabled || !s.nextAt) return { schedule: s };
      const dueAt = Date.parse(s.nextAt);
      if (dueAt > now) return { schedule: s }; // changed meanwhile
      const anchor = Date.parse(s.anchorAt);
      const onTime = now - dueAt <= this.graceMs;
      // Move on to the first time after now, counting the times that were
      // missed (a long sleep is one note, not many).
      let missed = onTime ? 0 : 1;
      let next = nextTime(s.when, s.tz, dueAt, anchor);
      while (next != null && next <= now && missed < 10_000) {
        if (now - next > this.graceMs) missed += 1;
        next = nextTime(s.when, s.tz, next, anchor);
      }
      s.nextAt = iso(next);
      if (s.when.type === 'once') { s.enabled = false; s.nextAt = null; }
      if (!onTime) {
        return { schedule: s, event: { kind: 'missed', due: iso(dueAt), count: missed, reason: 'The engine was off or the computer was asleep at that time; it was not run' } };
      }
      if (s.queued) {
        return { schedule: s, event: { kind: 'skipped', due: iso(dueAt), reason: 'An earlier run of this schedule is still waiting to start' } };
      }
      s.queued = true;
      s.queuedAt = iso(now);
      s.queuedFor = iso(dueAt);
      return { schedule: s, event: this.isBusy() ? { kind: 'waiting', due: iso(dueAt), reason: 'Another run is active; this one starts when it ends' } : null };
    });
  }

  // startWaiting starts the longest-waiting queued schedule if the engine is free.
  async startWaiting() {
    while (!this.isBusy()) {
      const waiting = (await this.schedules.all()).filter((s) => s.queued) // a one-off is already switched off while it waits
        .sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
      if (!waiting.length) return;
      const s = waiting[0];
      const started = await this.launch(s);
      if (started === 'busy') return;
    }
  }

  // launch starts one queued schedule. Returns 'started' | 'busy' | 'failed'.
  async launch(s) {
    const due = s.queuedFor ?? null;
    const clear = (x) => ({ ...x, queued: false, queuedAt: null, queuedFor: null });
    let ws;
    try { ws = await this.getWorkspace(s.workspaceId); } catch (error) {
      this.log.error(`scheduler: workspace lookup for ${s.id}:`, error);
      return 'busy'; // try again next tick
    }
    if (!ws) {
      await this.schedules.change(s.id, (x) => ({
        schedule: { ...clear(x), enabled: false, nextAt: null },
        event: { kind: 'paused', due, reason: `Its workspace (${s.workspaceId}) was deleted; the schedule is paused` },
      }));
      return 'failed';
    }
    if (!s.objective) { // only older schedules whose workspace had none to give
      await this.schedules.change(s.id, (x) => ({
        schedule: { ...clear(x), enabled: false, nextAt: null },
        event: { kind: 'paused', due, reason: 'This schedule has no objective; give it one (PATCH objective) and resume it' },
      }));
      return 'failed';
    }
    let run;
    try {
      run = await this.startRun(ws, s);
    } catch (error) {
      if (error.status === 409 && this.isBusy()) return 'busy'; // someone started a run first: keep waiting
      await this.schedules.change(s.id, (x) => ({
        schedule: { ...clear(x), lastRun: { runId: null, startedAt: iso(this.now()), error: error.message } },
        event: { kind: 'failed', due, reason: `The run could not start: ${error.message}` },
      }));
      return 'failed';
    }
    await this.schedules.change(s.id, (x) => ({
      schedule: { ...clear(x), lastRun: { runId: run.id, startedAt: run.createdAt, workspaceName: ws.name } },
      event: { kind: 'started', due, runId: run.id },
    }));
    return 'started';
  }
}
