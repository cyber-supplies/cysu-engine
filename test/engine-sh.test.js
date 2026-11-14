// scripts/engine.sh with a stand-in docker/curl (test/fixtures/engine-sh):
// clear messages when an image cannot be downloaded, and `update` really
// downloads the newer engine image, keeping the old engine if it cannot.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURES = new URL('./fixtures/engine-sh/', import.meta.url).pathname;
const REF = 'ghcr.io/cyber-supplies/cysu-engine:latest';
const WORKER = 'ghcr.io/cyber-supplies/cysu-engine-workspace:0.3.3';
const key = (ref) => ref.replace(/[/:]/g, '_');

async function fake(state = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cysu-engine-sh-'));
  for (const [name, value] of Object.entries(state)) await writeFile(join(dir, name), value);
  return dir;
}
function engineSh(dir, args, env = {}) {
  return new Promise((resolve) => {
    execFile('sh', ['scripts/engine.sh', ...args], {
      env: { PATH: `${FIXTURES}:/usr/bin:/bin`, FAKE_DIR: dir, ...env }, timeout: 20_000,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }));
  });
}
const calls = async (dir) => (await readFile(join(dir, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
const has = (dir, name) => access(join(dir, name)).then(() => true, () => false);

test('start, image not on this machine, access denied: says why and how to log in; nothing is started', async (t) => {
  for (const how of ['denied', 'unauth']) {
    const dir = await fake({ [`pull-${key(REF)}`]: how });
    t.after(() => rm(dir, { recursive: true, force: true }));
    const r = await engineSh(dir, ['start']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Could not download the engine image \(ghcr\.io\/cyber-supplies\/cysu-engine:latest\): access denied/);
    assert.match(r.out, /not public yet, or this machine is not logged in/);
    assert.match(r.out, /docker login ghcr\.io/);
    assert.ok(!(await calls(dir)).some((c) => c.startsWith('run ')), 'no container was created');
  }
});

test('start: a version that does not exist, and no network, each get their own message', async (t) => {
  for (const [how, message] of [['missing', /that version does not exist/], ['network', /no connection to the registry/], ['other', /Could not download the engine image[^\n]*:\n  Error response from daemon: something odd happened/]]) {
    const dir = await fake({ [`pull-${key(REF)}`]: how });
    t.after(() => rm(dir, { recursive: true, force: true }));
    const r = await engineSh(dir, ['start']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, message, how);
  }
});

test('start: downloads a missing engine image, then the worker image', async (t) => {
  const dir = await fake({ [`pull-${key(REF)}`]: 'ok:sha256:new', [`pull-${key(WORKER)}`]: 'ok:sha256:w' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await engineSh(dir, ['start'], { FAKE_WORKER: WORKER });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Downloading the engine image/);
  assert.match(r.out, /Engine ready/);
  assert.match(r.out, /Worker image ready/);
});

test('start: a worker image that cannot be downloaded is explained, the engine keeps running', async (t) => {
  const dir = await fake({ [`image-${key(REF)}`]: 'sha256:old', [`pull-${key(WORKER)}`]: 'denied' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await engineSh(dir, ['start'], { FAKE_WORKER: WORKER });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Could not download the worker image .*access denied/);
  assert.match(r.out, /runs cannot start until the worker image is downloaded/);
  assert.ok(await has(dir, 'running'));
});

test('update: really downloads the newer image and replaces the container', async (t) => {
  const dir = await fake({ [`image-${key(REF)}`]: 'sha256:old', exists: '', running: '', [`pull-${key(REF)}`]: 'ok:sha256:new' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await engineSh(dir, ['update']);
  assert.equal(r.code, 0, r.out);
  const c = await calls(dir);
  const pulled = c.findIndex((x) => x === `pull ${REF}`);
  const removed = c.findIndex((x) => x.startsWith('rm '));
  assert.ok(pulled >= 0, 'pulled');
  assert.ok(pulled < removed, 'pulled before the old container was removed');
  assert.ok(c.some((x) => x.startsWith('run ')), 'started a new one');
});

test('update: already the newest image, engine running: nothing is restarted', async (t) => {
  const dir = await fake({ [`image-${key(REF)}`]: 'sha256:same', exists: '', running: '', [`pull-${key(REF)}`]: 'ok:sha256:same' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await engineSh(dir, ['update']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Already up to date/);
  assert.ok(!(await calls(dir)).some((x) => x.startsWith('stop') || x.startsWith('rm ')), 'running engine untouched');
});

test('update: when the download fails, the running engine is left alone', async (t) => {
  const dir = await fake({ [`image-${key(REF)}`]: 'sha256:old', exists: '', running: '', [`pull-${key(REF)}`]: 'denied' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await engineSh(dir, ['update']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /access denied/);
  assert.match(r.out, /Nothing was changed/);
  assert.ok(await has(dir, 'running'), 'still running');
  assert.ok(!(await calls(dir)).some((x) => x.startsWith('stop') || x.startsWith('rm ')));
});

test('a local build (cysu-engine:dev) is never pulled; missing, it says to build it', async (t) => {
  const dir = await fake({ 'image-cysu-engine_dev': 'sha256:dev', exists: '', running: '' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await engineSh(dir, ['update'], { CYSU_ENGINE_IMAGE_REF: 'cysu-engine:dev' });
  assert.equal(r.code, 0, r.out);
  assert.ok(!(await calls(dir)).some((x) => x.startsWith('pull')), 'no pull of a local build');
  const empty = await fake();
  t.after(() => rm(empty, { recursive: true, force: true }));
  const missing = await engineSh(empty, ['start'], { CYSU_ENGINE_IMAGE_REF: 'cysu-engine:dev' });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /build it first \(npm run engine:build\)/);
});

test('update with a setting (CYSU_CLI_VERSION) recreates the container even when the image is unchanged', async (t) => {
  const dir = await fake({ [`image-${key(REF)}`]: 'sha256:same', exists: '', running: '', [`pull-${key(REF)}`]: 'ok:sha256:same' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await engineSh(dir, ['update'], { CYSU_CLI_VERSION: '0.6.3' });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Already up to date/);
  const run = (await calls(dir)).find((x) => x.startsWith('run '));
  assert.match(run, /-e CYSU_CLI_VERSION=0\.6\.3/);
});
