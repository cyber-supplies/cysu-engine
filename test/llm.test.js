// LLM login: OpenAI API key and Codex (ChatGPT) device login.
// Needs Docker and the image (npm run image:build). Run: npm run test:image
// The device login is exercised with a stand-in for OpenAI (no real account):
// it prints the same link/code text Codex prints, then writes a fake auth.json.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startFakeApi } from './fixtures/fake-api.js';

const DATA = await mkdtemp(join(tmpdir(), 'cysu-engine-test-'));
process.env.CYSU_ENGINE_DATA = DATA; // before the server modules load
const { hardeningArgs, secretsLine, IMAGE } = await import('../server/docker.js');
const llm = await import('../server/llm.js');
const { load, save } = await import('../server/store.js');

const API_KEY = `sk-test-${randomBytes(8).toString('hex')}`;
const FAKE_AUTH = { auth_mode: 'chatgpt', tokens: { access_token: 'fake-at', refresh_token: `fake-rt-${randomBytes(4).toString('hex')}` } };
const base = { token: 'test-token', passkey: 'test-passkey' };

after(() => rm(DATA, { recursive: true, force: true }));

function docker(args, input) {
  return new Promise((resolve) => {
    const child = execFile('docker', args, { timeout: 90_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.end(input ?? '');
  });
}
const worker = (command, input) =>
  docker(['run', '--rm', '-i', ...hardeningArgs(), '-e', 'CYSU_SECRETS=stdin', IMAGE, 'sh', '-c', command], input);

async function waitFor(fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---- in the worker ------------------------------------------------------------

test('API key mode: Codex is logged in from auth.json and the key is NOT in the agent env', async () => {
  const line = secretsLine({ ...base, llm: { mode: 'openai-api-key', apiKey: API_KEY } });
  const r = await worker('codex login status 2>&1; env | grep -c -e OPENAI -e CODEX_API || true; stat -c "auth=%U %a" ~/.codex/auth.json', line);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /API key configured/);
  assert.match(r.stdout, /^0$/m, 'an OpenAI/Codex key variable is still in the agent env');
  assert.match(r.stdout, /^auth=runner 600$/m);
});

test('Codex login mode: the saved auth.json is installed exactly, owner-only', async () => {
  const line = secretsLine({ ...base, llm: { mode: 'codex' } }, FAKE_AUTH);
  const r = await worker('cat ~/.codex/auth.json; stat -c "auth=%U %a" ~/.codex/auth.json', line);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^\[engine\] LLM login: Codex \(ChatGPT\)$/m);
  assert.deepEqual(JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('{'))), FAKE_AUTH);
  assert.match(r.stdout, /^auth=runner 600$/m);
});

test('no LLM login: worker still starts, and says so', async () => {
  const r = await docker(['run', '--rm', '-i', ...hardeningArgs(), '-e', 'CYSU_SECRETS=stdin', IMAGE, 'true'], secretsLine({ ...base, llm: { mode: 'none' } }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /LLM login: none/);
});

// ---- device login (engine side) --------------------------------------------------

const FAKE_LOGIN = (seconds) => `printf "Follow these steps\\n1. Open this link\\n   https://auth.openai.com/codex/device\\n2. Enter this one-time code\\n   TEST-12345\\n"; sleep ${seconds}; mkdir -p ~/.codex; printf '%s' '${JSON.stringify(FAKE_AUTH)}' > ~/.codex/auth.json`;

test('device login: shows link + code, then saves the login (0600) and selects Codex mode', async () => {
  await save('settings', { ...base, llm: { mode: 'none' } });
  llm.startCodexLogin({ loginCommand: FAKE_LOGIN(3) });
  const waiting = await waitFor(() => { const s = llm.codexLoginState(); return s.status === 'waiting' && s; });
  assert.equal(waiting.url, 'https://auth.openai.com/codex/device');
  assert.equal(waiting.code, 'TEST-12345');

  const done = await waitFor(() => { const s = llm.codexLoginState(); return !['starting', 'waiting'].includes(s.status) && s; });
  assert.equal(done.status, 'succeeded', done.error);
  assert.ok(!JSON.stringify(done).includes('fake-rt'), 'login state exposes the tokens');

  assert.deepEqual(await llm.loadCodexAuth(), FAKE_AUTH);
  assert.equal((await stat(join(DATA, 'codex-auth.json'))).mode & 0o777, 0o600);
  assert.equal((await load('settings')).llm.mode, 'codex');
});

test('device login: cancel stops the container', async () => {
  llm.startCodexLogin({ loginCommand: FAKE_LOGIN(300) });
  const waiting = await waitFor(() => { const s = llm.codexLoginState(); return s.status === 'waiting' && s; });
  const cancelled = await llm.cancelCodexLogin();
  assert.equal(cancelled.status, 'cancelled');
  const ps = await docker(['ps', '-a', '--filter', `name=${waiting.name}`, '--format', '{{.Names}}']);
  assert.equal(ps.stdout, '', 'login container still exists');
});

test('device login: a failed login is reported, and the saved login is kept', async () => {
  llm.startCodexLogin({ loginCommand: 'echo "Error: device code expired" >&2; exit 1' });
  const done = await waitFor(() => { const s = llm.codexLoginState(); return !['starting', 'waiting'].includes(s.status) && s; });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /device code expired/);
  assert.deepEqual(await llm.loadCodexAuth(), FAKE_AUTH);
});

test('forget login: removes it and switches back to no LLM login', async () => {
  await llm.forgetCodexAuth();
  assert.equal(await llm.loadCodexAuth(), null);
  assert.deepEqual(await llm.codexAuthInfo(), { saved: false });
  assert.equal((await load('settings')).llm.mode, 'none');
});

// ---- HTTP API ---------------------------------------------------------------------

test('HTTP API: login endpoints and the "sign in first" guard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cysu-engine-http-'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const TOKEN = 'usr_llm-http-test-4a1b';
  const api = await startFakeApi('127.0.0.1', TOKEN);
  const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_API_URL: api.url }, stdio: 'ignore' });
  try {
    const url = (p) => `http://127.0.0.1:${port}${p}`;
    await waitFor(() => fetch(url('/api/health')).then((r) => r.ok, () => false), 10_000);
    const JSON_AUTH = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(url('/api/llm/codex-login'))).status, 401, 'not set up yet');
    let r = await fetch(url('/api/settings'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN, passkey: 'pk' }) });
    assert.equal(r.status, 200, 'setup');

    r = await fetch(url('/api/llm/codex-login'), { headers: JSON_AUTH });
    assert.deepEqual(await r.json(), { status: 'idle' });

    r = await fetch(url('/api/settings'), { method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ llm: { mode: 'codex' } }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Sign in with ChatGPT first/);

    r = await fetch(url('/api/settings'), { method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ llm: { mode: 'openai-api-key', apiKey: API_KEY } }) });
    const s = await r.json();
    assert.equal(s.llm.mode, 'openai-api-key');
    assert.ok(!JSON.stringify(s).includes(API_KEY), 'API key returned unmasked');
    assert.deepEqual(s.llm.codex, { saved: false });
  } finally {
    server.kill();
    api.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
