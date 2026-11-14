import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { startFakeApi } from './fixtures/fake-api.js';
import { provisionToken } from './fixtures/provision-auth.js';

const DATA = await mkdtemp(join(tmpdir(), 'cysu-claude-test-'));
process.env.CYSU_ENGINE_DATA = DATA;
const { ClaudeLogin, CLAUDE_CONFIG_DIR, claudeAuthorizationUrl } = await import('../server/claude-login.js');
const { hardeningArgs } = await import('../server/docker.js');
const { load, save } = await import('../server/store.js');
const image = 'cysu-engine-workspace:test';
const login = new ClaudeLogin({ image });
after(async () => { await login.forget(); await rm(DATA, { recursive: true, force: true }); });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 15_000) {
  const end = Date.now() + timeout;
  do { const value = await fn(); if (value) return value; await pause(100); } while (Date.now() < end);
  throw new Error('Timed out waiting for Claude login');
}
const waiting = (manager = login) => waitFor(() => manager.state().status === 'waiting' && manager.state());
const finished = (manager = login) => waitFor(() => !['starting', 'waiting', 'exchanging'].includes(manager.state().status) && manager.state());
function docker(args) {
  return new Promise((resolve) => execFile('docker', args, { timeout: 30_000 }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr })));
}
async function successfulLogin(manager = login) {
  await manager.start();
  const state = await waiting(manager);
  await manager.submitCode({ id: state.id, code: 'success#fake-state' });
  const done = await finished(manager);
  assert.equal(done.status, 'succeeded', done.error);
  // The completion handler also retires the previous volume under its lock.
  await manager.exclusive(() => {});
  return manager.savedVolume();
}

test('URL parser accepts complete native URLs, rejects partial and unrelated links', () => {
  const url = 'https://claude.com/cai/oauth/authorize?client_id=test&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=test&state=test';
  assert.equal(claudeAuthorizationUrl(`\x1b[32mVisit: ${url}\n\x1b[0m`), url);
  assert.equal(claudeAuthorizationUrl(`Visit: ${url}`), '');
  for (const invalid of [url.replace('claude.com', 'evil.example'), url.replace('claude.com', 'claude.com.evil.example'), url.replace('claude.com', 'user@claude.com'), url.replace('response_type=code', 'response_type=token'), url.replace('state=test', 'state='), 'https://claude.ai/other?token=secret']) {
    assert.equal(claudeAuthorizationUrl(`${invalid}\n`), '');
  }
});

test('native CLI login: concurrent starts share one container; credentials stay in a private reusable volume', async () => {
  await save('settings', { llm: { mode: 'codex' } });
  const starts = await Promise.all([login.start(), login.start(), login.start()]);
  assert.equal(new Set(starts.map((s) => s.id)).size, 1);
  const state = await waiting();
  assert.equal(new URL(state.url).hostname, 'claude.com');
  const pending = await load('claude-login-pending');
  await login.submitCode({ id: state.id, code: 'slow-private-code#fake-state' });
  const inspect = await docker(['inspect', pending.container]);
  assert.equal(inspect.ok, true, inspect.stderr);
  assert.ok(!inspect.stdout.includes('slow-private-code'));
  const container = JSON.parse(inspect.stdout)[0];
  assert.equal(container.HostConfig.LogConfig.Type, 'none');
  assert.deepEqual(container.HostConfig.PortBindings, {});
  await assert.rejects(login.submitCode({ id: state.id, code: 'duplicate' }), { status: 409 });
  assert.equal((await finished()).status, 'succeeded');
  assert.equal((await docker(['inspect', pending.container])).ok, false);
  const saved = await load('claude-auth');
  assert.equal(saved.volume, pending.volume);
  assert.equal((await stat(join(DATA, 'claude-auth.json'))).mode & 0o777, 0o600);
  assert.equal((await load('settings')).llm.mode, 'codex', 'login must not silently change the run provider');
  assert.equal(login.state().url, '');
  assert.equal((await login.authInfo()).saved, true);
  for (const file of await readdir(DATA)) {
    const contents = await readFile(join(DATA, file), 'utf8');
    assert.ok(!/fake-claude-private|slow-private-code/.test(contents), 'engine persisted a credential or one-time code');
  }
  for (let i = 0; i < 2; i++) {
    const reused = await docker(['run', '--rm', ...hardeningArgs(), '--mount', `type=volume,source=${saved.volume},target=${CLAUDE_CONFIG_DIR}`,
      '-e', `CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}`, image, 'sh', '-c', 'claude auth status; stat -c "%u %a" "$CLAUDE_CONFIG_DIR" "$CLAUDE_CONFIG_DIR/.credentials.json"']);
    assert.equal(reused.ok, true, reused.stderr);
    assert.match(reused.stdout, /"loggedIn":true/);
    assert.match(reused.stdout, /10001 700\n10001 600/);
  }
  const restarted = new ClaudeLogin({ image });
  await restarted.recover();
  assert.equal(await restarted.savedVolume(), saved.volume);
  assert.equal((await restarted.authInfo()).saved, true);
});

test('failure and unverified success preserve the old login and never expose native error output', async () => {
  const original = await login.savedVolume();
  for (const code of ['fail-sensitive-code', 'unverified']) {
    await login.start();
    const state = await waiting();
    const pending = await load('claude-login-pending');
    await login.submitCode({ id: state.id, code });
    const done = await finished();
    assert.equal(done.status, 'failed');
    assert.ok(!JSON.stringify(done).includes(code));
    assert.equal(await login.savedVolume(), original);
    assert.equal((await docker(['volume', 'inspect', pending.volume])).ok, false);
  }
});

test('cancel and timeout clean up pending volumes while preserving the saved login', async () => {
  const original = await login.savedVolume();
  await login.start();
  const state = await waiting();
  const pending = await load('claude-login-pending');
  await login.submitCode({ id: state.id, code: 'slow-cancelled-code' });
  const cancelled = await login.cancel();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await docker(['inspect', pending.container])).ok, false);
  assert.equal((await docker(['volume', 'inspect', pending.volume])).ok, false);
  await pause(200);
  assert.equal(await login.savedVolume(), original, 'late close handler revived a cancelled login');
  const short = new ClaudeLogin({ image, timeoutMs: 2500 });
  await short.start();
  await waiting(short);
  const expiring = await load('claude-login-pending');
  assert.equal((await finished(short)).status, 'expired');
  await short.exclusive(() => {});
  assert.equal((await docker(['volume', 'inspect', expiring.volume])).ok, false);
  assert.equal(await short.savedVolume(), original);
});

test('recovery removes an interrupted login but preserves a committed volume after a crash', async () => {
  await login.start();
  await waiting();
  const pending = await load('claude-login-pending');
  // Simulate losing the engine process; its close callback must not commit.
  login.terminal(login.session, 'failed');
  const recovered = new ClaudeLogin({ image });
  await recovered.recover();
  assert.equal(recovered.state().status, 'failed');
  assert.equal((await docker(['volume', 'inspect', pending.volume])).ok, false);
  assert.equal((await recovered.authInfo()).saved, true);
  await save('claude-login-pending', { ...pending, volume: await recovered.savedVolume() });
  await recovered.recover();
  assert.equal(recovered.state().status, 'succeeded', 'a committed login is still successful after a crash');
  assert.equal((await docker(['volume', 'inspect', await recovered.savedVolume()])).ok, true);
});

test('replacement retires the previous volume; forget cancels login and removes all credentials', async () => {
  const previous = await login.savedVolume();
  const next = await successfulLogin();
  assert.notEqual(next, previous);
  assert.equal((await docker(['volume', 'inspect', previous])).ok, false);
  await login.start();
  const state = await waiting();
  const pending = await load('claude-login-pending');
  await login.submitCode({ id: state.id, code: 'slow-forgotten-code' });
  assert.deepEqual(await login.forget(), { saved: false });
  for (const volume of [pending.volume, next]) assert.equal((await docker(['volume', 'inspect', volume])).ok, false);
  await pause(200);
  assert.deepEqual(await login.authInfo(), { saved: false });
  assert.equal(await load('claude-auth', null), null);
});

test('HTTP login endpoints: auth, code validation, successful persistence, restart and deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cysu-claude-http-'));
  const port = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
  const TOKEN = 'usr_claude-http-test-token';
  const inContainer = process.env.CYSU_TEST_ENGINE === 'container';
  const container = `cysu-claude-engine-test-${randomUUID()}`;
  const dataVolume = `${container}-data`;
  const gateway = (await docker(['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}'])).stdout.trim();
  const fakeApi = await startFakeApi(gateway, TOKEN);
  let output = '';
  const start = async () => {
    if (inContainer) {
      const started = await docker(['run', '-d', '--name', container, '--init', '-p', `127.0.0.1:${port}:8787`,
        '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${dataVolume}:/data`,
        '-e', `CYSU_API_URL=${fakeApi.url}`, '-e', `CYSU_ENGINE_IMAGE=${image}`, '-e', 'CYSU_ENGINE_TEST_NO_FIREWALL=1', '-e', 'CYSU_CLI_VERSION=image', 'cysu-engine:dev']);
      assert.equal(started.ok, true, started.stderr);
      await waitFor(() => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false));
      return { container };
    }
    const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_API_URL: fakeApi.url, CYSU_ENGINE_IMAGE: image, CYSU_ENGINE_TEST_NO_FIREWALL: '1', CYSU_CLI_VERSION: 'image' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (b) => { output += b; }); server.stderr.on('data', (b) => { output += b; });
    await waitFor(() => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false));
    return server;
  };
  const stop = async (server) => {
    if (server.container) {
      await docker(['stop', '-t', '15', container]);
      const logs = await docker(['logs', container]); output += logs.stdout + logs.stderr;
      await docker(['rm', '-f', container]);
      return;
    }
    if (server.exitCode !== null || server.signalCode !== null) return;
    const done = new Promise((resolve) => server.once('close', resolve)); server.kill(); await done;
  };
  const request = async (path, method = 'GET', data, authenticated = true) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path.startsWith('/') ? path : `/llm/${path}`}`, { method,
      headers: { ...(authenticated && { Authorization: `Bearer ${TOKEN}` }), 'Content-Type': 'application/json' },
      ...(data !== undefined && { body: JSON.stringify(data) }) });
    return { status: response.status, json: await response.json() };
  };
  let server;
  let savedVolume;
  try {
    server = await start();
    assert.equal((await provisionToken({ dir, apiUrl: fakeApi.url, container: inContainer ? container : undefined }, TOKEN)).code, 0);
    for (const [path, method] of [['claude-login', 'GET'], ['claude-login', 'POST'], ['claude-login', 'DELETE'], ['claude-login/code', 'POST'], ['claude-auth', 'GET'], ['claude-auth', 'DELETE']]) {
      assert.equal((await request(path, method, undefined, false)).status, 401);
    }
    assert.equal((await request('claude-login', 'POST', { token: 'not-accepted' })).status, 400);
    assert.equal((await request('claude-login', 'POST')).status, 202);
    const state = await waitFor(async () => { const r = await request('claude-login'); return r.json.status === 'waiting' && r.json; });
    for (const input of [null, [], {}, { id: state.id, code: 'a\nb' }, { id: state.id, code: 'a', apiKey: 'bad' }]) {
      assert.equal((await request('claude-login/code', 'POST', input)).status, 400);
    }
    assert.equal((await request('claude-login/code', 'POST', { id: 'stale-login', code: 'success' })).status, 409);
    assert.equal((await request('claude-login/code', 'POST', { id: state.id, code: 'success#fake-state' })).status, 202);
    await waitFor(async () => (await request('claude-login')).json.status === 'succeeded');
    const auth = (await request('claude-auth')).json;
    assert.equal(auth.saved, true);
    assert.deepEqual(Object.keys(auth).sort(), ['saved', 'savedAt']);
    assert.equal((await request('/settings', 'PUT', { passkey: 'claude-http-test' })).status, 200);
    assert.equal((await request('/status')).json.llm.provider, 'claude');
    assert.equal((await request('/status')).json.configured, true);
    for (const provider of ['codex', 'openrouter', '', null, 'invalid']) {
      assert.equal((await request('/runs/plan', 'POST', { provider, objective: 'go', stages: [{ profile: 'attack' }] })).status, 400);
    }
    const ws = await request('/workspaces', 'POST', { name: 'Claude workflow', request: { provider: 'claude', stages: [{ profile: 'attack', reprompts: ['finish'] }] } });
    assert.equal(ws.status, 201);
    assert.equal(ws.json.request.provider, 'claude');
    const view = (await request(`/workspaces/${ws.json.id}`)).json;
    assert.equal(view.plan.provider, 'claude');
    const created = await request(`/workspaces/${ws.json.id}/run`, 'POST', { objective: 'go' });
    assert.equal(created.status, 201);
    const run = await waitFor(async () => { const r = (await request(`/runs/${created.json.id}`)).json; return !['queued', 'running'].includes(r.status) && r; }, 30_000);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.equal(run.provider, 'claude');
    assert.deepEqual(run.stages[0].attempts.map((a) => a.provider), ['claude', 'claude']);
    savedVolume = inContainer
      ? (await docker(['exec', container, 'node', '-e', "process.stdout.write(JSON.parse(require('fs').readFileSync('/data/claude-auth.json')).volume)"])).stdout
      : JSON.parse(await readFile(join(dir, 'claude-auth.json'), 'utf8')).volume;
    await stop(server);
    server = await start();
    assert.deepEqual((await request('claude-auth')).json, auth);
    assert.deepEqual((await request('claude-auth', 'DELETE')).json, { saved: false });
    assert.equal((await docker(['volume', 'inspect', savedVolume])).ok, false);
    assert.ok(!/fake-claude-private|success#fake-state/.test(output), 'server logs leaked credentials or a code');
  } finally {
    if (server) await stop(server);
    if (savedVolume) await docker(['volume', 'rm', savedVolume]);
    if (inContainer) await docker(['volume', 'rm', dataVolume]);
    fakeApi.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
