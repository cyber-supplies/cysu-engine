import { provisionToken } from './fixtures/provision-auth.js';
// The user's own secrets (/api/secrets): names only out, values kept on this
// machine, env-var names, reserved names refused, owner token required.
// Real engine + stand-in Cyber Supplies API. No containers are started.
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startFakeApi } from './fixtures/fake-api.js';
import { secretNameError } from '../server/secrets.js';

const TOKEN = 'usr_secrets-test-token-91ab';
const VALUE = 'bb_live_TESTVALUE_not_a_real_key_123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let api; let engine;
before(async () => {
  api = await startFakeApi('127.0.0.1', [TOKEN]);
  const dir = await mkdtemp(join(tmpdir(), 'cysu-secrets-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_API_URL: api.url },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engine = { child, dir, base: `http://127.0.0.1:${port}` };
  for (let i = 0; i < 50 && !(await fetch(`${engine.base}/api/health`).then((r) => r.ok, () => false)); i++) await sleep(200);
  assert.equal((await provisionToken({ dir, apiUrl: api.url }, TOKEN)).code, 0);
  const setup = await call('PUT', '/api/settings', { body: { passkey: 'pk' } });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
});
after(async () => { engine?.child.kill('SIGKILL'); await sleep(200); await rm(engine.dir, { recursive: true, force: true }); api?.server.close(); });

async function call(method, path, { body, token = TOKEN } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${engine.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
}

test('names: env var names only, worker names reserved', () => {
  for (const ok of ['BROWSERBASE_API_KEY', 'A', 'X1_Y2', `A${'B'.repeat(63)}`]) assert.equal(secretNameError(ok), null, ok);
  for (const bad of ['', 'lower', 'Mixed', '1ABC', '_ABC', 'A-B', 'A B', `A${'B'.repeat(64)}`, 'ÄBC', null, 42]) assert.ok(secretNameError(bad), String(bad));
  for (const reserved of ['PATH', 'HOME', 'HTTPS_PROXY', 'NO_PROXY', 'CYSU_TOKEN', 'CYSU_ANYTHING', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CODEX_API_KEY', 'NODE_OPTIONS', 'LD_PRELOAD', 'GIT_SSH_COMMAND', 'PYTHONPATH', 'BASH_ENV']) {
    assert.match(secretNameError(reserved), /reserved/, reserved);
  }
});

test('set, list (names only), replace, delete', async () => {
  assert.deepEqual((await call('GET', '/api/secrets')).body, []);

  const set = await call('PUT', '/api/secrets/BROWSERBASE_API_KEY', { body: { value: VALUE } });
  assert.equal(set.status, 200);
  assert.equal(set.body.name, 'BROWSERBASE_API_KEY');
  assert.ok(!set.text.includes(VALUE), 'the value is not echoed');

  const listed = await call('GET', '/api/secrets');
  assert.deepEqual(listed.body.map((s) => s.name), ['BROWSERBASE_API_KEY']);
  assert.ok(!listed.text.includes(VALUE), 'listing never shows values');
  // Nor do the other read routes.
  for (const path of ['/api/settings', '/api/status']) assert.ok(!(await call('GET', path)).text.includes(VALUE), path);

  // On disk: in secrets.json, owner-only.
  const file = join(engine.dir, 'secrets.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).BROWSERBASE_API_KEY.value, VALUE);

  await sleep(5);
  const replaced = await call('PUT', '/api/secrets/BROWSERBASE_API_KEY', { body: { value: 'newer' } });
  assert.ok(replaced.body.updatedAt > set.body.updatedAt);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).BROWSERBASE_API_KEY.value, 'newer');

  assert.equal((await call('DELETE', '/api/secrets/BROWSERBASE_API_KEY')).status, 200);
  assert.deepEqual((await call('GET', '/api/secrets')).body, []);
  assert.equal((await call('DELETE', '/api/secrets/BROWSERBASE_API_KEY')).status, 404);
});

test('bad input is a 400 with a reason', async () => {
  const cases = [
    ['/api/secrets/lowercase', { value: 'x' }, /environment variable names/],
    ['/api/secrets/CYSU_TOKEN', { value: 'x' }, /reserved/],
    ['/api/secrets/OPENAI_API_KEY', { value: 'x' }, /reserved/],
    ['/api/secrets/GOOD', { value: '' }, /non-empty/],
    ['/api/secrets/GOOD', { value: 42 }, /non-empty string/],
    ['/api/secrets/GOOD', {}, /non-empty/],
    ['/api/secrets/GOOD', { value: 'x'.repeat(16 * 1024 + 1) }, /16384 bytes/],
    ['/api/secrets/GOOD', { value: 'a\0b' }, /NUL/],
    ['/api/secrets/%E0%A4', { value: 'x' }, /encoding/],
  ];
  for (const [path, body, reason] of cases) {
    const r = await call('PUT', path, { body });
    assert.equal(r.status, 400, `${path} ${JSON.stringify(body).slice(0, 40)}`);
    assert.match(r.body.error, reason);
  }
  assert.deepEqual((await call('GET', '/api/secrets')).body, [], 'nothing was saved');
});

test('at most 50 secrets; replacing one at the limit still works', async () => {
  for (let i = 0; i < 50; i++) assert.equal((await call('PUT', `/api/secrets/S${i}`, { body: { value: 'v' } })).status, 200);
  const over = await call('PUT', '/api/secrets/ONE_MORE', { body: { value: 'v' } });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /at most 50/);
  assert.equal((await call('PUT', '/api/secrets/S0', { body: { value: 'w' } })).status, 200);
  for (let i = 0; i < 50; i++) await call('DELETE', `/api/secrets/S${i}`);
});

test('the engine token is required', async () => {
  for (const [method, path, body] of [['GET', '/api/secrets'], ['PUT', '/api/secrets/X', { value: 'v' }], ['DELETE', '/api/secrets/X']]) {
    assert.equal((await call(method, path, { body, token: null })).status, 401, `${method} ${path} without a token`);
    assert.equal((await call(method, path, { body, token: 'usr_wrong-token-000' })).status, 401, `${method} ${path} with a wrong token`);
  }
});

test('secretMasker: every form of a value becomes [secret:NAME]; short values are left alone', async () => {
  const { secretMasker } = await import('../server/stage.js');
  const value = 'bb_live_abc"\\def';
  const mask = secretMasker({ BROWSERBASE_API_KEY: value, SHORT: 'abc', OTHER: 'other-secret-value' });
  assert.equal(mask(`key ${value} end`), 'key [secret:BROWSERBASE_API_KEY] end');
  const json = JSON.stringify({ text: `use ${value} and other-secret-value` });
  const masked = mask(json);
  assert.deepEqual(JSON.parse(masked), { text: 'use [secret:BROWSERBASE_API_KEY] and [secret:OTHER]' }, 'JSON stays valid JSON');
  assert.equal(mask('abc is short'), 'abc is short', 'values under 6 characters are not masked');
  assert.equal(secretMasker({})('nothing'), 'nothing');
  // One value inside another: the longer is masked whole.
  assert.equal(secretMasker({ A: 'secret12', B: 'secret1234' })('x secret1234 secret12'), 'x [secret:B] [secret:A]');
});
