// Run the actual installer against real Docker, redirecting ONLY resource
// names and the host port so an existing installation is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi } from './fixtures/fake-api.js';

const TOKEN = 'usr_installer-docker-original';
const NEW = 'usr_installer-docker-replacement';
const run = (file, args, options) => new Promise((resolve) => execFile(file, args, options,
  (error, stdout, stderr) => resolve({ code: error?.code || 0, output: stdout + stderr })));

test('standalone installer: provision, rerun, rotate, restart, reset and recover on real Docker', async (t) => {
  const docker = execFileSync('which', ['docker']).toString().trim();
  const curl = execFileSync('which', ['curl']).toString().trim();
  const container = `cysu-installer-test-${randomUUID()}`;
  const volume = `${container}-data`;
  const dir = await mkdtemp(join(tmpdir(), 'cysu-installer-docker-'));
  const gateway = execFileSync(docker, ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  const api = await startFakeApi(gateway, [TOKEN, NEW]);
  t.after(async () => {
    await run(docker, ['rm', '-f', container]);
    await run(docker, ['volume', 'rm', volume]);
    api.server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address(); server.close(() => resolve(port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const log = join(dir, 'commands.jsonl');
  const wrapper = `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const name = require('node:path').basename(process.argv[1]);
const original = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name, args: original }) + '\\n');
if (name === 'id') { console.log('0'); process.exit(0); }
if (name === 'systemctl') process.exit(0);
const args = original.map(a => a === 'cysu-engine' ? ${JSON.stringify(container)}
  : a === 'cysu-engine-data:/data' ? ${JSON.stringify(`${volume}:/data`)} : a
  .replace('name=^cysu-engine$', ${JSON.stringify(`name=^${container}$`)})
  .replace('name=^cysu-engine-proxy$', ${JSON.stringify(`name=^${container}-proxy$`)})
  .replaceAll('127.0.0.1:8787', ${JSON.stringify(`127.0.0.1:${port}`)}));
try {
  let output = execFileSync(name === 'docker' ? ${JSON.stringify(docker)} : ${JSON.stringify(curl)}, args,
    { stdio: [0, 'pipe', 'pipe'] }).toString();
  if (name === 'docker' && original[0] === 'inspect' && original[2].includes('.Mounts')) {
    output = output.replaceAll(${JSON.stringify(volume)}, 'cysu-engine-data');
  }
  process.stdout.write(output);
} catch (e) { process.stderr.write(e.stderr || ''); process.exit(e.status || 1); }
`;
  for (const name of ['docker', 'curl', 'id', 'systemctl']) await writeFile(join(dir, name), wrapper, { mode: 0o700 });
  const install = (token) => run('sh', [fileURLToPath(new URL('../install.sh', import.meta.url)), '--token', token], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CYSU_TOKEN: 'usr_ignored_environment',
      CYSU_ENGINE_IMAGE_REF: 'cysu-engine:dev', CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test', CYSU_API_URL: api.url },
    timeout: 30000,
  });
  const call = async (token, path = '/api/status', method = 'GET', body) => {
    const res = await fetch(base + path, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const first = await install(TOKEN);
  assert.equal(first.code, 0, first.output);
  assert.equal((await call(TOKEN)).status, 200);
  assert.equal((await call(NEW)).status, 401);
  assert.equal((await call(TOKEN, '/api/settings', 'PUT', { token: NEW })).status, 400);
  assert.equal((await call(TOKEN, '/api/settings', 'PUT', { passkey: 'kept' })).status, 200);
  const workspace = await call(TOKEN, '/api/workspaces', 'POST', { name: 'Preserved across provisioning' });
  assert.equal(workspace.status, 201);
  assert.equal((await install(TOKEN)).code, 0, 'same-token rerun');
  assert.equal((await install('usr_invalid')).code, 1, 'refused token');
  assert.equal((await call(TOKEN)).status, 200, 'failed provisioning preserves old auth');
  assert.equal((await install(NEW)).code, 0, 'rotation');
  assert.equal((await call(TOKEN)).status, 401);
  assert.equal((await call(NEW)).status, 200);
  assert.equal((await run(docker, ['restart', container])).code, 0);
  for (let i = 0; i < 50; i++) {
    if (await fetch(base + '/api/health').then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await call(NEW)).status, 200, 'auth survives a restart');
  assert.equal((await run(docker, ['exec', container, 'node', 'server/reset-auth.js'])).code, 0);
  assert.equal((await call(NEW)).body.setupRequired, true);
  assert.equal((await call(NEW, '/api/settings', 'PUT', { token: NEW })).status, 401);
  assert.equal((await install(NEW)).code, 0, 'local recovery');
  assert.equal((await call(NEW, '/api/settings')).body.passkey, 'set');
  assert.equal((await call(NEW, `/api/workspaces/${workspace.body.id}`)).body.name, 'Preserved across provisioning');
  const commands = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(commands.filter((c) => c.name === 'curl').every((c) => c.args.at(-1).endsWith('/api/health')));
  const inspect = await run(docker, ['inspect', container]);
  const logs = await run(docker, ['logs', container]);
  for (const token of [TOKEN, NEW]) {
    assert.ok(!JSON.stringify(commands).includes(token), 'no token in Docker or curl arguments');
    assert.ok(!inspect.output.includes(token), 'no token in Docker configuration');
    assert.ok(!logs.output.includes(token), 'no token in engine logs');
    assert.ok(!first.output.includes(token), 'no token in installer output');
  }
});
