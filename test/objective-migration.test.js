// Upgrading: older engines kept the objective in the workspace. On start, the
// engine gives it to that workspace's schedules (so they keep working) and
// removes it from the workspace. A real engine process on seeded data; no
// Docker needed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'usr_migrate-test-token-3c88';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = '2026-11-01T10:00:00.000Z';
const schedule = (id, workspaceId, extra = {}) => ({
  id, name: id, workspaceId, when: { type: 'daily', time: '09:00' }, tz: 'UTC', enabled: true,
  anchorAt: T, createdAt: T, updatedAt: T, nextAt: null, queued: false, lastRun: null, history: [], ...extra,
});
let dir, server, base, out = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cysu-migrate-'));
  const put = (name, value) => writeFile(join(dir, `${name}.json`), JSON.stringify(value));
  await put('auth', { token: TOKEN });
  await put('settings', { passkey: 'pk' });
  await put('workspaces', [
    { id: 'ws-old', name: 'Old', request: { prompt: 'recon example.com', stages: [{ profile: 'recon', prompt: 'own' }] }, createdAt: T, updatedAt: T },
    { id: 'ws-new', name: 'New', request: { stages: [{ profile: 'recon' }] }, createdAt: T, updatedAt: T },
  ]);
  await put('schedules', [schedule('s-old', 'ws-old'), schedule('s-own', 'ws-old', { objective: 'its own' }), schedule('s-none', 'ws-new')]);
  const port = 25900 + Math.floor(Math.random() * 90);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (c) => { out += c; });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
});
after(async () => {
  server?.kill('SIGINT');
  await sleep(500);
  await rm(dir, { recursive: true, force: true });
});

const get = (path) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());

test('older workspaces lose their objective; their schedules keep it', async () => {
  const saved = JSON.parse(await readFile(join(dir, 'workspaces.json'), 'utf8'));
  assert.deepEqual(saved.map((w) => w.request), [{ stages: [{ profile: 'recon' }] }, { stages: [{ profile: 'recon' }] }]);
  const byId = Object.fromEntries((await get('/api/schedules')).map((s) => [s.id, s]));
  assert.equal(byId['s-old'].objective, 'recon example.com', 'handed over from its workspace');
  assert.equal(byId['s-own'].objective, 'its own', 'a schedule keeps its own');
  assert.equal(byId['s-none'].objective, '', 'nothing to hand over: it will pause itself with a note when due');
  assert.match(out, /moved 1 objective/);
});
