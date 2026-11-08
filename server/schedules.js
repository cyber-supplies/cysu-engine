// schedules.js: runs that start by themselves at set times. A schedule points
// at one workspace (by exact id, so edits to the workspace reach future runs),
// has a timing rule and the user's timezone, and can be paused. Stored in
// <data>/schedules.json.
//
// Timing rules (no cron), all times are wall-clock in the schedule's timezone:
//   { type: 'once',     at: 'YYYY-MM-DDTHH:MM' }
//   { type: 'daily',    time: 'HH:MM' }
//   { type: 'weekdays', time: 'HH:MM' }                 Monday to Friday
//   { type: 'weekly',   time: 'HH:MM', days: ['mon', 'thu'] }
//   { type: 'every',    hours: N, start?: 'YYYY-MM-DDTHH:MM' }  N = 1..168;
//                       first run AT start if given, else N hours after saving
//
// Clock changes: a time that does not exist that day (spring forward) runs at
// the same moment the clock jumps past it (02:30 → 03:30); a time that
// happens twice (fall back) runs once, the first time.
//
// Starting the runs (the timer, queueing while busy, skipping missed times)
// lives in the scheduler; this file only stores schedules and works out times.

import { randomUUID } from 'node:crypto';
import { load, save } from './store.js';

export class ScheduleError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const MAX_SCHEDULES = 100;
export const HISTORY_LIMIT = 20;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TYPES = ['once', 'daily', 'weekdays', 'weekly', 'every'];
const HOUR = 3600_000;

// ---- timezones -------------------------------------------------------------

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

// checkTimezone returns the canonical IANA name ("europe/london" → "Europe/London").
export function checkTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) throw new ScheduleError(400, 'A schedule needs a timezone, like "Europe/London"');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw new ScheduleError(400, `Unknown timezone "${tz}"; use an IANA name like "Europe/London" or "UTC"`);
  }
}

// wallClock gives the local date and time of an instant in tz.
export function wallClock(ms, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

function offsetAt(ms, tz) {
  const w = wallClock(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

// toInstant turns a local date+time in tz into a UTC instant (ms). Gaps move
// forward by the jump; repeated times take the earlier instant.
export function toInstant({ year, month, day, hour, minute }, tz) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = [...new Set([offsetAt(asUtc - 36 * HOUR, tz), offsetAt(asUtc, tz), offsetAt(asUtc + 36 * HOUR, tz)])];
  const fits = offsets.map((o) => asUtc - o).filter((t) => {
    const w = wallClock(t, tz);
    return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute;
  }).sort((a, b) => a - b);
  if (fits.length) return fits[0];
  // Not on the clock that day (spring forward): use the offset from before the jump.
  return asUtc - offsetAt(asUtc - 36 * HOUR, tz);
}

// ---- timing rules ----------------------------------------------------------

function parseTime(value, what = 'time') {
  const m = typeof value === 'string' && /^(\d{2}):(\d{2})$/.exec(value);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new ScheduleError(400, `${what} must be HH:MM (24-hour), like "09:00"`);
  return { hour: +m[1], minute: +m[2] };
}

function parseLocal(value, what) {
  const m = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new ScheduleError(400, `${what} must be a local date and time, YYYY-MM-DDTHH:MM, like "2026-11-08T21:00"`);
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || check.getUTCDate() !== day || hour > 23 || minute > 59) throw new ScheduleError(400, `${what} "${value}" is not a real date and time`);
  return { year, month, day, hour, minute };
}

// checkWhen validates a timing rule and returns a clean copy.
export function checkWhen(when) {
  if (!when || typeof when !== 'object' || Array.isArray(when)) throw new ScheduleError(400, `A schedule needs "when", e.g. {"type":"daily","time":"09:00"}`);
  const { type } = when;
  if (!TYPES.includes(type)) throw new ScheduleError(400, `when.type must be one of ${TYPES.join(', ')}`);
  const allowed = { once: ['at'], daily: ['time'], weekdays: ['time'], weekly: ['time', 'days'], every: ['hours', 'start'] }[type];
  const extra = Object.keys(when).filter((k) => k !== 'type' && !allowed.includes(k));
  if (extra.length) throw new ScheduleError(400, `"${type}" schedules don't take: ${extra.join(', ')}`);
  if (type === 'once') { parseLocal(when.at, 'when.at'); return { type, at: when.at }; }
  if (type === 'every') {
    if (!Number.isInteger(when.hours) || when.hours < 1 || when.hours > 168) throw new ScheduleError(400, 'when.hours must be a whole number from 1 to 168');
    if (when.start !== undefined) parseLocal(when.start, 'when.start');
    return when.start === undefined ? { type, hours: when.hours } : { type, hours: when.hours, start: when.start };
  }
  parseTime(when.time, 'when.time');
  if (type !== 'weekly') return { type, time: when.time };
  if (!Array.isArray(when.days) || !when.days.length) throw new ScheduleError(400, `when.days must list days, e.g. ["mon","thu"]`);
  const days = [...new Set(when.days.map((d) => String(d).toLowerCase().slice(0, 3)))];
  const bad = when.days.filter((d) => !DAYS.includes(String(d).toLowerCase().slice(0, 3)));
  if (bad.length) throw new ScheduleError(400, `Unknown day(s): ${bad.join(', ')}; use mon tue wed thu fri sat sun`);
  return { type, time: when.time, days: DAYS.filter((d) => days.includes(d)) };
}

// nextTime: the first run time strictly after `after` (ms), or null if there
// is none (a one-off time that has passed). `anchor` (ms) is when an "every"
// schedule without a start was saved.
export function nextTime(when, tz, after, anchor = after) {
  if (when.type === 'once') {
    const t = toInstant(parseLocal(when.at, 'when.at'), tz);
    return t > after ? t : null;
  }
  if (when.type === 'every') {
    const step = when.hours * HOUR;
    if (when.start) {
      const start = toInstant(parseLocal(when.start, 'when.start'), tz);
      return after < start ? start : start + (Math.floor((after - start) / step) + 1) * step;
    }
    return anchor + Math.max(1, Math.floor((after - anchor) / step) + 1) * step;
  }
  const { hour, minute } = parseTime(when.time);
  const today = wallClock(after, tz);
  for (let i = 0; i <= 8; i++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const dow = DAYS[date.getUTCDay()];
    if (when.type === 'weekdays' && (dow === 'sat' || dow === 'sun')) continue;
    if (when.type === 'weekly' && !when.days.includes(dow)) continue;
    const t = toInstant({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute }, tz);
    if (t > after) return t;
  }
  return null; // not reached for valid rules
}

// describe gives a short human line, e.g. "every weekday at 09:00 (Europe/London)".
export function describe(when, tz) {
  const zone = ` (${tz})`;
  switch (when.type) {
    case 'once': return `once on ${when.at.replace('T', ' at ')}${zone}`;
    case 'daily': return `every day at ${when.time}${zone}`;
    case 'weekdays': return `every weekday at ${when.time}${zone}`;
    case 'weekly': return `every ${when.days.join(', ')} at ${when.time}${zone}`;
    case 'every': return `every ${when.hours} hour${when.hours === 1 ? '' : 's'}${when.start ? ` from ${when.start.replace('T', ' ')}` : ''}${zone}`;
    default: return '';
  }
}

// ---- storage ---------------------------------------------------------------

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim();
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

export class Schedules {
  // workspaceExists(id) → boolean: schedules can only point at real workspaces.
  constructor({ store = { load, save }, workspaceExists = async () => true, now = () => Date.now() } = {}) {
    this.store = store;
    this.workspaceExists = workspaceExists;
    this.now = now;
    this.queue = Promise.resolve(); // one write at a time
  }

  async all() {
    const items = await this.store.load('schedules', []);
    return Array.isArray(items) ? items : [];
  }

  async list() {
    return (await this.all()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id) {
    const s = typeof id === 'string' && id ? (await this.all()).find((x) => x.id === id) : null;
    if (!s) throw new ScheduleError(404, `No schedule with id "${String(id ?? '').slice(0, 100)}"`);
    return s;
  }

  write(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }

  // plan works out nextAt for a schedule from now; a one-off whose time has
  // passed has none.
  plan(s, from = this.now()) {
    const next = s.enabled ? nextTime(s.when, s.tz, from, Date.parse(s.anchorAt)) : null;
    return { ...s, nextAt: iso(next), summary: describe(s.when, s.tz) };
  }

  async checkWorkspace(workspaceId) {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new ScheduleError(400, 'A schedule needs a workspaceId');
    if (!(await this.workspaceExists(workspaceId))) throw new ScheduleError(400, `No workspace with id "${workspaceId.slice(0, 100)}"`);
  }

  async create({ workspaceId, when, tz, name, enabled = true } = {}) {
    await this.checkWorkspace(workspaceId);
    when = checkWhen(when);
    tz = checkTimezone(tz);
    name = cleanName(name);
    if (name.length > 80) throw new ScheduleError(400, 'Schedule names are limited to 80 characters');
    if (typeof enabled !== 'boolean') throw new ScheduleError(400, 'enabled must be true or false');
    return this.write(async () => {
      const items = await this.all();
      if (items.length >= MAX_SCHEDULES) throw new ScheduleError(409, `You can have at most ${MAX_SCHEDULES} schedules; delete some first`);
      const now = this.now();
      const s = this.plan({
        id: randomUUID(), name, workspaceId, when, tz, enabled,
        anchorAt: iso(now), createdAt: iso(now), updatedAt: iso(now),
        nextAt: null, queued: false, lastRun: null, history: [],
      }, now);
      if (s.enabled && !s.nextAt) throw new ScheduleError(400, `${describe(when, tz)} is in the past`);
      await this.store.save('schedules', [...items, s]);
      return s;
    });
  }

  // update changes name, workspace, timing or timezone. Changing the timing
  // restarts "every" schedules from now (unless they have a start).
  async update(id, changes = {}) {
    const known = ['name', 'workspaceId', 'when', 'tz', 'enabled'];
    const extra = Object.keys(changes).filter((k) => !known.includes(k));
    if (extra.length) throw new ScheduleError(400, `Can't change: ${extra.join(', ')}`);
    if (changes.workspaceId !== undefined) await this.checkWorkspace(changes.workspaceId);
    const when = changes.when === undefined ? undefined : checkWhen(changes.when);
    const tz = changes.tz === undefined ? undefined : checkTimezone(changes.tz);
    const name = changes.name === undefined ? undefined : cleanName(changes.name);
    if (name !== undefined && name.length > 80) throw new ScheduleError(400, 'Schedule names are limited to 80 characters');
    if (changes.enabled !== undefined && typeof changes.enabled !== 'boolean') throw new ScheduleError(400, 'enabled must be true or false');
    return this.write(async () => {
      const items = await this.all();
      const old = await this.get(id);
      const now = this.now();
      const timingChanged = when !== undefined || tz !== undefined;
      const resumed = changes.enabled === true && !old.enabled;
      if (resumed && changes.workspaceId === undefined) await this.checkWorkspace(old.workspaceId);
      let s = {
        ...old,
        name: name ?? old.name,
        workspaceId: changes.workspaceId ?? old.workspaceId,
        when: when ?? old.when,
        tz: tz ?? old.tz,
        enabled: changes.enabled ?? old.enabled,
        updatedAt: iso(now),
      };
      if (timingChanged || resumed) s.anchorAt = iso(now);
      if (!s.enabled) Object.assign(s, { queued: false, queuedAt: null, queuedFor: null });
      s = this.plan(s, now);
      if (s.enabled && !s.nextAt) throw new ScheduleError(400, `${describe(s.when, s.tz)} is in the past`);
      await this.store.save('schedules', items.map((x) => (x.id === s.id ? s : x)));
      return s;
    });
  }

  pause(id) { return this.update(id, { enabled: false }); }
  resume(id) { return this.update(id, { enabled: true }); }

  async delete(id) {
    return this.write(async () => {
      const s = await this.get(id);
      await this.store.save('schedules', (await this.all()).filter((x) => x.id !== s.id));
      return s;
    });
  }

  // pauseForWorkspace pauses every schedule of a deleted workspace, noting why.
  async pauseForWorkspace(workspaceId, reason) {
    for (const x of await this.all()) {
      if (x.workspaceId !== workspaceId || (!x.enabled && !x.queued)) continue;
      await this.change(x.id, (s) => ({
        schedule: { ...s, enabled: false, nextAt: null, queued: false, queuedAt: null, queuedFor: null },
        event: { kind: 'paused', reason },
      }));
    }
  }

  // change applies fn(schedule) → schedule under the write lock (used by the
  // scheduler to record runs, misses and queueing). Adds a history entry when
  // fn returns { schedule, event }.
  async change(id, fn) {
    return this.write(async () => {
      const items = await this.all();
      const old = items.find((x) => x.id === id);
      if (!old) return null;
      const { schedule, event } = fn(structuredClone(old));
      if (event) schedule.history = [{ at: iso(this.now()), ...event }, ...(schedule.history || [])].slice(0, HISTORY_LIMIT);
      await this.store.save('schedules', items.map((x) => (x.id === id ? schedule : x)));
      return schedule;
    });
  }
}
