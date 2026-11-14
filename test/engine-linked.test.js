import { provisionToken } from './fixtures/provision-auth.js';
// Engine linked, end to end with the engine as a CONTAINER (the only setup it
// supports): the engine joins its own private network, opens the agent port
// there, and a linked stage's worker gets CYSU_ENGINE_URL and reaches it.
// Then a worker WITH its firewall on proves only that one address:port opens.
// Needs Docker + all images (npm run image:build && npm run image:build:test
// && npm run engine:build). Run: npm run test:image

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { startFakeApi } from './fixtures/fake-api.js';
import { hardeningArgs, IMAGE } from '../server/docker.js';

const TOKEN = 'usr_linked-test-token-4e1a';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(16).slice(2, 8);
const names = { container: `cysu-engine-linked-${tag}`, data: `cysu-engine-linked-data-${tag}`, network: `cysu-engine-linked-net-${tag}` };
let api, base;

const sh = (file, args) => new Promise((resolve) => execFile(file, args, { timeout: 60_000 }, (e, out, err) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: String(out).trim(), err: String(err).trim() })));
const call = (method, path, body) => fetch(`${base}${path}`, {
  method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));

before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  const port = 27000 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  // Firewall off for the stage itself: the stand-in Cyber Supplies API runs on
  // this machine (the firewall is checked separately below).
  const env = { CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test', CYSU_CLI_VERSION: 'image', CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1', CYSU_ENGINE_NETWORK: names.network };
  execFileSync('docker', ['run', '-d', '--name', names.container, '--init', '-p', `127.0.0.1:${port}:8787`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${names.data}:/data`,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'cysu-engine:dev']);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return;
    await sleep(200);
  }
  throw new Error(`engine container did not start: ${execFileSync('docker', ['logs', names.container]).toString()}`);
});
after(async () => {
  await sh('docker', ['rm', '-f', names.container]);
  await sh('docker', ['volume', 'rm', names.data]);
  await sh('docker', ['network', 'rm', names.network]);
  api?.server.close();
});

let engineIp;
test('setting: off by default, can be turned on; must be true/false', async () => {
  assert.equal((await provisionToken({ container: names.container }, TOKEN)).code, 0);
  let r = await call('PUT', '/api/settings', { passkey: 'pk', llm: { mode: 'openai-api-key', apiKey: 'sk-linked' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.engineLinked, false, 'off by default');
  assert.equal((await call('PUT', '/api/settings', { engineLinked: 'yes' })).status, 400);
  r = await call('PUT', '/api/settings', { engineLinked: true });
  assert.equal(r.body.engineLinked, true);
  assert.equal((await call('GET', '/api/settings')).body.engineLinked, true);
});

test('a linked stage: the engine joins its network, and the agent reaches the engine at CYSU_ENGINE_URL', async () => {
  const created = await call('POST', '/api/runs', { objective: 'learn from earlier runs', stages: [{ profile: 'attack' }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await finished(created.body.id);
  assert.equal(run.status, 'succeeded', JSON.stringify(run.stages[0]));
  assert.equal(run.engineLinked, true);
  assert.equal(run.stages[0].engineLinked, true);
  const report = JSON.parse(run.stages[0].result);
  engineIp = execFileSync('docker', ['inspect', '-f', `{{(index .NetworkSettings.Networks "${names.network}").IPAddress}}`, names.container]).toString().trim();
  assert.match(engineIp, /^\d+\.\d+\.\d+\.\d+$/, 'the engine container joined the network');
  assert.equal(report.engineUrl, `http://${engineIp}:8788`);
  assert.equal(report.engineProbe, '{"ok":true}');
  const log = await fetch(`${base}/api/runs/${run.id}/stages/0/log`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.text());
  assert.match(log, /\[engine\] engine linked: the agent can read earlier runs/);
});

async function finished(id) {
  for (let i = 0; i < 300; i++) {
    const run = (await call('GET', `/api/runs/${id}`)).body;
    if (!['queued', 'running'].includes(run.status)) return run;
    await sleep(300);
  }
  throw new Error('run did not finish');
}
const inEngine = (path, auth = '', method = 'GET') => sh('docker', ['exec', names.container, 'node', '-e',
  `fetch("http://${engineIp}:8788${path}", { method: "${method}", headers: ${JSON.stringify(auth ? { Authorization: `Bearer ${auth}` } : {})} }).then(async (r) => console.log(r.status, await r.text()))`]);

test('the agent port: only /api/health without a key; the engine token never works there', async () => {
  assert.match((await inEngine('/api/health')).out, /^200 /);
  assert.match((await inEngine('/api/status')).out, /^401 /);
  assert.match((await inEngine('/api/runs', TOKEN)).out, /^401 /, 'the engine token does not work here');
  assert.match((await inEngine('/api/runs', 'usr_engine_made-up-key')).out, /^401 /);
});

let read, wsA, runA1, runB;
test('a linked stage reads earlier runs of ITS workspace with the real cysu CLI and its stage key — nothing else', async () => {
  wsA = (await call('POST', '/api/workspaces', { name: 'A', request: { stages: [{ profile: 'attack' }] } })).body.id;
  const wsB = (await call('POST', '/api/workspaces', { name: 'B', request: { stages: [{ profile: 'attack' }] } })).body.id;
  runB = (await finished((await call('POST', `/api/workspaces/${wsB}/run`, { objective: 'B secret objective' })).body.id)).id;
  runA1 = (await finished((await call('POST', `/api/workspaces/${wsA}/run`, { objective: 'A first objective' })).body.id)).id;
  const runA2 = await finished((await call('POST', `/api/workspaces/${wsA}/run`, { objective: `ENGINE-READ OTHER=${runB}` })).body.id);
  assert.equal(runA2.status, 'succeeded', JSON.stringify(runA2.stages[0]));
  read = JSON.parse(JSON.parse(runA2.stages[0].result).engineRead);

  assert.match(read.key, /^usr_engine_[\w-]{43}$/, 'the stage got its key as CYSU_ENGINE_TOKEN');
  const status = JSON.parse(read.status);
  assert.deepEqual(status.agent, { readOnly: true, workspace: { id: wsA, name: 'A' }, runId: runA2.id });
  const ids = JSON.parse(read.runs).map((r) => r.id);
  assert.deepEqual(new Set(ids), new Set([runA1, runA2.id]), `only workspace A's runs: ${read.runs}`);
  assert.deepEqual(JSON.parse(read.workflows).map((w) => w.id), [wsA], 'only its own workspace');
  const events = JSON.parse(read.events);
  assert.ok(events.events.length > 0, 'it can read an earlier run\'s transcript');
  assert.equal(read.otherRun, '404', 'another workspace\'s run is not found, even by its full id');
  assert.equal(read.delete, '403', 'read-only: no delete');
  assert.equal(read.settings, '404', 'no settings');
  assert.equal(read.withUserToken, '401', 'the agent\'s Cyber Supplies token does not work on the engine');
  assert.match(read.skill, /name: engine-history/, 'linked workers get the engine-history skill');
  const got = JSON.parse(read.getRun);
  assert.equal(got.success, true, read.getRun);
  assert.equal(got.run, runA1, 'get-run saved the earlier run');
  assert.match(read.plain, /usr_/, 'without --token the CLI refuses the agent\'s LLM token (by design: not the engine key)');
});

test('the key stops working when its stage ends', async () => {
  assert.match((await inEngine('/api/runs', read.key)).out, /^401 /);
  assert.match((await inEngine(`/api/runs/${runA1}`, read.key)).out, /^401 /);
});

test('a firewalled worker on the network reaches ONLY the agent port: not the engine API port, not the host', async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  const cmd = [
    `curl -sS --max-time 5 http://${engineIp}:8788/api/health; echo " agent=$?"`,
    `curl -sS --max-time 5 http://${engineIp}:8787/api/health; echo " api=$?"`,
    `curl -sS --max-time 5 ${api.url}/api/profiles; echo " host=$?"`,
    `echo "url=$CYSU_ENGINE_URL"`,
  ].join('; ');
  const r = await sh('docker', ['run', '--rm', ...hardeningArgs(), '--network', names.network,
    '-e', 'CYSU_WORKER_TEST_BOOTSTRAP=0', '-e', `CYSU_ENGINE_ALLOW=${engineIp}:8788`, '-e', `CYSU_ENGINE_URL=http://${engineIp}:8788`,
    IMAGE, 'sh', '-c', cmd]);
  assert.match(r.out, /\{"ok":true\} agent=0/, `${r.out} ${r.err}`);
  assert.match(r.out, / api=7$/m, 'the engine\'s own API port is rejected');
  assert.match(r.out, / host=7$/m, `the host is rejected (${gw})`);
  assert.match(r.out, new RegExp(`url=http://${engineIp.replace(/\./g, '\\.')}:8788`));
});
