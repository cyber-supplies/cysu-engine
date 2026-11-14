// Exercise the standalone shell installer without touching host Docker/services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'usr_installer-test-token';
const IMAGE = 'engine:installer-test';
const installer = fileURLToPath(new URL('../install.sh', import.meta.url));

async function fixture(t, initial = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cysu-installer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state.json');
  await writeFile(state, JSON.stringify({ calls: [], mount: 'volume:cysu-engine-data', ...initial }));
  const mock = `#!${process.execPath}
const fs = require('node:fs');
const command = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.INSTALLER_TEST_STATE));
const call = { command, args, tokenEnv: process.env.TOKEN };
state.calls.push(call);
const save = () => fs.writeFileSync(process.env.INSTALLER_TEST_STATE, JSON.stringify(state));
const fail = () => { save(); process.exit(1); };
if (command === 'id') console.log('0');
else if (command === 'uname') console.log('x86_64');
else if (command === 'curl') {
  if (!args.at(-1).endsWith('/api/health')) fail();
  console.log('{"ok":true}');
} else if (command === 'docker') {
  if (args[0] === 'ps') {
    const proxy = args.at(-1).includes('proxy');
    if (proxy ? state.proxy : state.exists) console.log('test-container');
  } else if (args[0] === 'inspect') {
    const format = args[2];
    if (format.includes('.Mounts')) console.log(state.mount);
    else if (format === '{{.Config.Image}}') console.log('${IMAGE}');
    else if (format.includes('Labels')) console.log('8.8.8.8');
  } else if (args[0] === 'run' && args.at(-1) === 'server/provision-auth.js') {
    call.stdin = fs.readFileSync(0, 'utf8');
    if (state.failProvision) fail();
    state.token = call.stdin;
  } else if (args[0] === 'run' && args.includes('--name')) {
    state.exists = true;
    console.log('test-container');
  }
}
save();
`;
  for (const name of ['id', 'uname', 'docker', 'curl', 'systemctl']) {
    await writeFile(join(dir, name), mock, { mode: 0o700 });
  }
  return {
    state: async () => JSON.parse(await readFile(state, 'utf8')),
    run: (args) => new Promise((resolve) => execFile('sh', [installer, ...args], {
      env: { PATH: `${dir}:${process.env.PATH}`, INSTALLER_TEST_STATE: state,
        CYSU_ENGINE_IMAGE_REF: IMAGE, CYSU_TOKEN: TOKEN, TOKEN: 'inherited-value' }, timeout: 10000,
    }, (error, stdout, stderr) => resolve({ code: error?.code || 0, output: stdout + stderr }))),
  };
}

test('installer requires --token explicitly, even when CYSU_TOKEN is set', async (t) => {
  const f = await fixture(t);
  for (const args of [[], ['--ip', '8.8.8.8'], ['--token', ''], ['--token']]) {
    const r = await f.run(args);
    assert.notEqual(r.code, 0);
    assert.match(r.output, /--token/);
  }
  assert.equal((await f.state()).calls.some((c) => c.command === 'docker'), false);
});

test('installer provisions via local stdin before startup, using only health over HTTP', async (t) => {
  const f = await fixture(t);
  const r = await f.run(['--token', TOKEN]);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /Engine ready at http:\/\/127.0.0.1:8787/);
  assert.ok(!r.output.includes(TOKEN));
  const { calls, token } = await f.state();
  assert.equal(token, TOKEN);
  const provision = calls.findIndex((c) => c.args.includes('server/provision-auth.js'));
  const start = calls.findIndex((c) => c.args.includes('--name'));
  assert.ok(provision >= 0 && start > provision);
  assert.equal(calls[provision].stdin, TOKEN);
  assert.ok(calls[provision].args.includes('none'), 'disable Docker logs for provisioning');
  assert.ok(calls[provision].args.includes('cysu-engine-data:/data'));
  assert.ok(calls[start].args.includes('cysu-engine-data:/data'));
  assert.ok(calls.every((c) => !c.args.join(' ').includes(TOKEN)), 'no token in Docker/curl arguments');
  assert.ok(calls.every((c) => c.tokenEnv === undefined), 'do not export the CLI token into child processes');
  assert.ok(calls.filter((c) => c.command === 'curl').every((c) => c.args.at(-1).endsWith('/api/health')));
});

test('installer failure does not start or replace an engine', async (t) => {
  const f = await fixture(t, { exists: true, token: 'usr_previous', failProvision: true });
  const r = await f.run(['--token', TOKEN]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /Local token provisioning failed/);
  const { token, calls } = await f.state();
  assert.equal(token, 'usr_previous');
  assert.ok(!calls.some((c) => ['stop', 'rm', 'start'].includes(c.args[0]) || c.args.includes('--name')));
});

test('installer rekeys an existing engine and retains HTTPS when --ip is omitted', async (t) => {
  const f = await fixture(t, { exists: true, proxy: true, token: 'usr_previous' });
  const r = await f.run(['--token', TOKEN]);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /Engine ready at https:\/\/8.8.8.8/);
  const { calls, token } = await f.state();
  assert.equal(token, TOKEN);
  assert.ok(!calls.some((c) => c.args.includes('--name')));
});

test('installer refuses a custom data mount before writing credentials', async (t) => {
  const f = await fixture(t, { exists: true, mount: 'bind:' });
  const r = await f.run(['--token', TOKEN]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /different data mount/);
  assert.ok(!(await f.state()).calls.some((c) => c.args.includes('server/provision-auth.js')));
});
