// Engine API authentication: the engine token is the user's Cyber Supplies
// user token, set at setup; every request needs it (Authorization: Bearer).
// Real engine + stand-in Cyber Supplies API. No containers are started.
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startFakeApi } from './fixtures/fake-api.js';
import { provisionToken } from './fixtures/provision-auth.js';
import { bearerToken, sameToken, AuthLimiter } from '../server/auth.js';

const TOKEN = 'usr_auth-test-token-5f1e9a';
const OTHER = 'usr_auth-test-other-77b2c0'; // also a real token at Cyber Supplies (someone else's)
const NEWER = 'usr_auth-test-newer-0c3d4e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const ID = '00000000-0000-4000-8000-000000000000';

// Every route in openapi.yaml (path + method), with example path values, so a
// route added later is covered automatically.
async function routes() {
  const out = [];
  let path = null;
  for (const line of (await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8')).split('\n')) {
    const p = line.match(/^ {2}(\/\S*):\s*$/);
    if (p) { path = p[1]; continue; }
    if (/^\S/.test(line)) path = null;
    const m = line.match(/^ {4}(get|put|post|patch|delete):/);
    if (path && m) out.push([m[1].toUpperCase(), path.replace('{runId}', ID).replace('{workspaceId}', ID).replace('{index}', '0')]);
  }
  return out;
}

const servers = [];
let api;
before(async () => { api = await startFakeApi('127.0.0.1', [TOKEN, OTHER, NEWER]); });
after(async () => {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(300);
  for (const s of servers) await rm(s.dir, { recursive: true, force: true });
  api?.server.close();
});

// The route sweeps below send hundreds of wrong tokens on purpose: their
// engines allow that (SWEEP); the lockout has its own tests at the end.
const SWEEP = { CYSU_ENGINE_TEST_AUTH_MAX: '1000000' };
async function startEngine(apiUrl = api.url, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cysu-auth-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_API_URL: apiUrl, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  const engine = { child, dir, base, apiUrl, output: () => output };
  servers.push(engine);
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return engine;
    await sleep(200);
  }
  throw new Error(`engine did not start: ${output}`);
}

// req(engine, method, path, { token, headers, body })
async function req(e, method, path, { token, headers = {}, body } = {}) {
  const h = { ...headers };
  if (token !== undefined) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] ??= 'application/json';
  const r = await fetch(`${e.base}${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, body: json, text };
}

const setup = async (e, token, extra = {}) => {
  const provisioned = await provisionToken(e, token);
  assert.equal(provisioned.code, 0, provisioned.output);
  return req(e, 'PUT', '/api/settings', { token, body: { passkey: 'pk', ...extra } });
};

// ---- the pieces ---------------------------------------------------------------------

test('bearerToken / sameToken', () => {
  assert.equal(bearerToken(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(bearerToken(`bearer ${TOKEN}`), TOKEN, 'scheme is case-insensitive');
  for (const h of [undefined, '', TOKEN, `Basic ${TOKEN}`, 'Bearer', 'Bearer ', `Bearer ${TOKEN} extra`, `Bearer\t${TOKEN}`, `Bearer ${'a'.repeat(5000)}`, `Bearer ${TOKEN}é`]) {
    assert.equal(bearerToken(h), null, String(h).slice(0, 40));
  }
  assert.equal(sameToken(TOKEN, TOKEN), true);
  for (const [a, b] of [[TOKEN, OTHER], [TOKEN.slice(0, -1), TOKEN], [`${TOKEN}x`, TOKEN], ['', ''], [null, TOKEN], [TOKEN, ''], [TOKEN, undefined]]) {
    assert.equal(sameToken(a, b), false, `${a} vs ${b}`);
  }
});

// ---- before setup ---------------------------------------------------------------------

let fresh;
test('before setup: only /api/health answers; every route is 401 setupRequired', async () => {
  fresh = await startEngine(api.url, SWEEP);
  const health = await req(fresh, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true }, 'health says nothing else');

  const all = await routes();
  assert.ok(all.length >= 20, `found ${all.length} routes in openapi.yaml`);
  for (const [method, path] of [...all, ['GET', '/'], ['GET', '/nope'], ['GET', '/api/nope']]) {
    if (path === '/api/health') continue;
    for (const token of [undefined, TOKEN]) { // a token means nothing before setup
      const r = await req(fresh, method, path, { token, body: ['GET', 'DELETE'].includes(method) ? undefined : {} });
      assert.equal(r.status, 401, `${method} ${path} (token: ${Boolean(token)})`);
      assert.equal(r.body.setupRequired, true, `${method} ${path}`);
      assert.match(r.headers.get('www-authenticate'), /^Bearer realm="cysu-engine"$/);
      assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'", 'security headers on 401s too');
    }
  }
});

test('HTTP enrollment is always refused, including real tokens, without upstream calls', async () => {
  const before = api.requests.length;
  for (const token of [TOKEN, OTHER, 'llm_bad', 'usr_invalid']) {
    const r = await req(fresh, 'PUT', '/api/settings', { token, body: { token, passkey: 'pk' } });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /install.sh --token/);
  }
  assert.equal(api.requests.length, before);
  await assert.rejects(readFile(join(fresh.dir, 'auth.json')), { code: 'ENOENT' });
});

test('local provisioning rejects missing, malformed and refused tokens without saving', async () => {
  for (const token of ['', 'llm_bad', 'usr_bad\ninjected', 'usr_made-up-token']) {
    const r = await provisionToken(fresh, token);
    assert.equal(r.code, 1, r.output);
  }
  await assert.rejects(readFile(join(fresh.dir, 'auth.json')), { code: 'ENOENT' });
});

test('local provisioning fails closed if Cyber Supplies is unreachable', async () => {
  const down = await startEngine(`http://127.0.0.1:${await freePort()}`);
  const r = await provisionToken(down, TOKEN);
  assert.equal(r.code, 1);
  assert.match(r.output, /Could not check/);
  await assert.rejects(readFile(join(down.dir, 'auth.json')), { code: 'ENOENT' });
});

test('before setup: same-machine checks still come first (403 beats 401)', async () => {
  assert.equal((await req(fresh, 'GET', '/api/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req(fresh, 'PUT', '/api/settings', { body: `token=${TOKEN}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 403);
});

test('legacy settings tokens do not reopen enrollment or authenticate requests', async () => {
  const e = await startEngine();
  await writeFile(join(e.dir, 'settings.json'), JSON.stringify({ token: TOKEN, passkey: 'legacy' }));
  assert.equal((await req(e, 'GET', '/api/status', { token: TOKEN })).status, 401);
  assert.equal((await req(e, 'PUT', '/api/settings', { token: TOKEN, body: { token: OTHER } })).status, 401);
  assert.equal((await provisionToken(e, OTHER)).code, 0);
  assert.equal((await req(e, 'GET', '/api/settings', { token: OTHER })).body.passkey, 'set');
});

// ---- after setup ----------------------------------------------------------------------

let eng;
test('setup: the user token becomes the engine token (returned masked)', async () => {
  eng = await startEngine(api.url, SWEEP);
  const r = await setup(eng, TOKEN, { llm: { mode: 'openai-api-key', apiKey: 'sk-auth' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.token, `••••${TOKEN.slice(-4)}`);
  assert.ok(!r.text.includes(TOKEN));
  const s = await req(eng, 'GET', '/api/status', { token: TOKEN });
  assert.equal(s.status, 200);
  assert.equal(s.body.configured, true);
});

test('after setup: every route is 401 without the right token, in any form but the header', async () => {
  const all = await routes();
  const wrong = [
    {}, // no header
    { token: OTHER }, { token: TOKEN.slice(0, -1) }, { token: `${TOKEN}x` }, { token: TOKEN.toUpperCase() }, { token: '' },
    { headers: { Authorization: TOKEN } }, { headers: { Authorization: `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}` } },
    { headers: { Authorization: `Token ${TOKEN}` } }, { headers: { 'X-Api-Key': TOKEN } }, { headers: { Cookie: `token=${TOKEN}` } },
  ];
  for (const [method, path] of [...all, ['GET', '/'], ['GET', '/nope']]) {
    if (path === '/api/health') continue;
    for (const opts of wrong) {
      const r = await req(eng, method, path, { ...opts, body: ['GET', 'DELETE'].includes(method) ? undefined : {} });
      assert.equal(r.status, 401, `${method} ${path} ${JSON.stringify(opts)}`);
      assert.equal(r.body.setupRequired, false);
    }
    // The token in the query string never counts.
    const q = await req(eng, method, `${path}?token=${TOKEN}&access_token=${TOKEN}`, { body: ['GET', 'DELETE'].includes(method) ? undefined : {} });
    assert.equal(q.status, 401, `${method} ${path}?token=`);
  }
  // The right token in the header works (lower-case scheme too).
  assert.equal((await req(eng, 'GET', '/api/workspaces', { headers: { Authorization: `bearer ${TOKEN}` } })).status, 200);
  assert.equal((await req(eng, 'GET', '/api/profiles', { token: TOKEN })).status, 200);
});

test('after setup: a second "setup" without the token cannot take the engine over', async () => {
  const r = await req(eng, 'PUT', '/api/settings', { body: { token: OTHER } });
  assert.equal(r.status, 401);
  assert.equal((await req(eng, 'GET', '/api/status', { token: OTHER })).status, 401);
  assert.equal((await req(eng, 'GET', '/api/status', { token: TOKEN })).status, 200);
});

test('an unauthenticated request is refused before its body is read (huge body → 401, not 413)', async () => {
  const huge = JSON.stringify({ prompt: 'x'.repeat(2_000_000) });
  assert.equal((await req(eng, 'POST', '/api/runs', { body: huge })).status, 401);
  assert.equal((await req(eng, 'POST', '/api/runs', { body: '{not json', token: OTHER })).status, 401, 'no parse error either');
  assert.equal((await req(eng, 'POST', '/api/runs', { body: huge, token: TOKEN })).status, 413, 'with the token the size limit applies');
});

test('API token writes are rejected atomically; only local provisioning rotates it', async () => {
  const before = api.requests.length;
  for (const token of [NEWER, TOKEN, '', null, false, {}, []]) {
    const r = await req(eng, 'PUT', '/api/settings', { token: TOKEN, body: { token, passkey: 'must-not-save' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /install.sh --token/);
  }
  assert.equal(api.requests.length, before);
  assert.equal(JSON.parse(await readFile(join(eng.dir, 'settings.json'))).passkey, 'pk');
  assert.equal((await provisionToken(eng, 'usr_rejected')).code, 1);
  assert.equal((await req(eng, 'GET', '/api/status', { token: TOKEN })).status, 200);
  assert.equal((await provisionToken(eng, NEWER)).code, 0);
  assert.equal((await req(eng, 'GET', '/api/status', { token: TOKEN })).status, 401);
  assert.equal((await req(eng, 'GET', '/api/status', { token: NEWER })).status, 200);
  assert.equal((await stat(join(eng.dir, 'auth.json'))).mode & 0o777, 0o600);
  const settings = JSON.parse(await readFile(join(eng.dir, 'settings.json')));
  assert.equal(settings.token, undefined);
});

test('Cyber Supplies refusing the stored token is a 502 that says so, never a 401', async () => {
  api.tokens.delete(NEWER); // revoked at Cyber Supplies
  try {
    const r = await req(eng, 'GET', '/api/profiles', { token: NEWER });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /did not accept your user token .*install.sh --token/);
    const plan = await req(eng, 'POST', '/api/runs/plan', { token: NEWER, body: { prompt: 'p', fromTags: {} } });
    assert.equal(plan.status, 502);
    assert.equal((await req(eng, 'GET', '/api/status', { token: NEWER })).status, 200, 'the engine still lets the user in');
  } finally {
    api.tokens.add(NEWER);
  }
});

// ---- too many wrong tokens --------------------------------------------------------------

test('AuthLimiter: 10 wrong tokens within a minute lock for a minute; older ones expire', () => {
  let t = 1_000_000;
  const l = new AuthLimiter({ now: () => t });
  for (let i = 0; i < 9; i++) assert.equal(l.fail(), false);
  assert.equal(l.lockedFor(), 0);
  assert.equal(l.fail(), true, 'the 10th starts a lockout');
  assert.equal(l.lockedFor(), 60_000);
  t += 59_999; assert.equal(l.lockedFor(), 1);
  t += 1; assert.equal(l.lockedFor(), 0, 'over after a minute');
  for (let i = 0; i < 9; i++) l.fail();
  t += 60_000; // those 9 are now older than the window
  assert.equal(l.fail(), false, 'failures older than a minute do not count');
});

test('lockout over HTTP: wrong tokens lock everyone out (right token too) for the lock time; missing headers do not count', async () => {
  const e = await startEngine(api.url, { CYSU_ENGINE_TEST_AUTH_LOCK_MS: '2000' });
  assert.equal((await setup(e, TOKEN)).status, 200);
  for (let i = 0; i < 30; i++) assert.equal((await req(e, 'GET', '/api/status')).status, 401, 'no header: refused, not counted');
  for (let i = 0; i < 9; i++) assert.equal((await req(e, 'GET', '/api/status', { token: `usr_guess-${i}` })).status, 401);
  assert.equal((await req(e, 'GET', '/api/status', { token: TOKEN })).status, 200, 'not locked after 9 wrong tokens');
  assert.equal((await req(e, 'GET', '/api/status', { token: 'usr_guess-9' })).status, 401, 'the 10th wrong token');

  const locked = await req(e, 'GET', '/api/status', { token: TOKEN });
  assert.equal(locked.status, 429, 'the right token is refused too during a lockout');
  assert.equal(locked.headers.get('retry-after'), '2');
  assert.equal(locked.body.retryAfter, 2);
  assert.match(locked.body.error, /Too many wrong engine tokens/);
  assert.equal((await req(e, 'PUT', '/api/settings', { token: TOKEN, body: { token: OTHER } })).status, 429);
  assert.equal((await req(e, 'GET', '/api/health')).status, 200, 'health still answers');
  assert.match(e.output(), /10 wrong engine tokens within a minute; refusing all requests/);

  await sleep(2100);
  assert.equal((await req(e, 'GET', '/api/status', { token: TOKEN })).status, 200, 'over after the lock time');
});

test('repeated HTTP setup attempts never reach Cyber Supplies', async () => {
  const e = await startEngine();
  const before = api.requests.length;
  for (let i = 0; i < 20; i++) assert.equal((await req(e, 'PUT', '/api/settings', { body: { token: OTHER } })).status, 401);
  assert.equal(api.requests.length, before);
});

// ---- reset-auth ---------------------------------------------------------------------------

const resetAuth = (dir) => new Promise((resolve) => {
  execFile(process.execPath, ['server/reset-auth.js'], { env: { ...process.env, CYSU_ENGINE_DATA: dir } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }));
});

test('reset-auth: forgets ONLY the token; the engine needs setup again; everything else is kept', async () => {
  const e = await startEngine();
  assert.equal((await setup(e, TOKEN, { llm: { mode: 'openai-api-key', apiKey: 'sk-reset' } })).status, 200);
  const w = (await req(e, 'POST', '/api/workspaces', { token: TOKEN, body: { name: 'Kept' } })).body;

  let r = await resetAuth(e.dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Engine token removed/);
  assert.ok(!r.out.includes(TOKEN));
  const after = await req(e, 'GET', '/api/status', { token: TOKEN });
  assert.equal(after.status, 401, 'the old token no longer works');
  assert.equal(after.body.setupRequired, true);
  const saved = JSON.parse(await readFile(join(e.dir, 'settings.json'), 'utf8'));
  assert.deepEqual([saved.token, saved.passkey, saved.llm.mode, saved.llm.apiKey], [undefined, 'pk', 'openai-api-key', 'sk-reset'], 'only the token is gone');

  assert.equal((await req(e, 'PUT', '/api/settings', { body: { token: NEWER } })).status, 401, 'reset never reopens HTTP enrollment');
  assert.equal((await provisionToken(e, NEWER)).code, 0);
  assert.equal((await req(e, 'GET', `/api/workspaces/${w.id}`, { token: NEWER })).body.name, 'Kept', 'workspaces kept');
  assert.equal((await req(e, 'GET', '/api/status', { token: NEWER })).body.configured, true, 'passkey and LLM login kept');

  await resetAuth(e.dir);
  r = await resetAuth(e.dir);
  assert.match(r.out, /nothing to reset/, 'running it twice is harmless');
});

test('no token ever appears in the engine\'s output', async () => {
  for (const e of servers) {
    for (const t of [TOKEN, OTHER, NEWER]) assert.ok(!e.output().includes(t), `token in output: ${e.output().slice(0, 500)}`);
  }
});
