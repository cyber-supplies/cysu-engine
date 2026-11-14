// Secrets handling in worker containers: stdin delivery, one-shot passphrase,
// nothing in docker inspect / argv / process environments.
// Needs Docker and the image (npm run image:build). Run: npm run test:image

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hardeningArgs, secretsLine, IMAGE } from '../server/docker.js';

const TOKEN = `test-token-${randomBytes(6).toString('hex')}`;
const PASSKEY = `test-passkey-${randomBytes(6).toString('hex')}`;
const settings = { token: TOKEN, passkey: PASSKEY, llm: { mode: 'none' } };

// docker runs the docker CLI, optionally writing `input` to its stdin.
function docker(args, input) {
  return new Promise((resolve) => {
    const child = execFile('docker', args, { timeout: 90_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.end(input ?? '');
  });
}

// worker starts a hardened container the way the engine does (secrets on stdin).
function worker(command, { input = secretsLine(settings), env = { CYSU_SECRETS: 'stdin' }, extra = [] } = {}) {
  const envArgs = Object.entries({ CYSU_WORKER_TEST_BOOTSTRAP: '0', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return docker(['run', '--rm', '-i', ...hardeningArgs(), ...envArgs, ...extra, IMAGE, ...command], input);
}

const containers = [];
after(async () => { for (const name of containers) await docker(['rm', '-f', name]); });

test('agent gets the token and the key file, but not the passphrase', async () => {
  const r = await worker(['sh', '-c', 'echo "token=${CYSU_TOKEN:-}"; echo "passphrase=${CYSU_PASSPHRASE:-<unset>}"; stat -c "key=%U %a" ~/.config/cysu/master.key']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^token=${TOKEN}$`, 'm'));
  assert.match(r.stdout, /^passphrase=<unset>$/m);
  assert.match(r.stdout, /^key=runner 600$/m);
});

test('the key file is derived from the passkey (cysu key verify accepts it, rejects another)', async () => {
  const ok = await worker(['sh', '-c', `CYSU_PASSPHRASE='${PASSKEY}' cysu key verify`]);
  assert.match(ok.stdout, /^OK: passphrase matches/m, ok.stderr);
  const bad = await worker(['sh', '-c', `CYSU_PASSPHRASE='wrong-${PASSKEY}' cysu key verify`]);
  assert.notEqual(bad.code, 0);
});

test('passphrase is in no process (environ or argv); token search proves the scan works', async () => {
  const name = `cysu-secrets-test-${randomBytes(4).toString('hex')}`;
  containers.push(name);
  const started = await docker(['run', '-d', '-i', '--name', name, ...hardeningArgs(), '-e', 'CYSU_WORKER_TEST_BOOTSTRAP=0', '-e', 'CYSU_SECRETS=stdin', IMAGE, 'sleep', '120']);
  assert.equal(started.code, 0, started.stderr);
  // `docker run -d -i` keeps stdin open; send the secrets through attach.
  const attach = spawn('docker', ['attach', '--sig-proxy=false', name], { stdio: ['pipe', 'ignore', 'ignore'] });
  attach.stdin.end(secretsLine(settings));
  await new Promise((resolve) => setTimeout(resolve, 4000));
  attach.kill();

  // grep reads its pattern from stdin, so the secret is never in grep's own argv.
  const scan = (user, secret) => docker(['exec', '-i', '-u', user, name, 'sh', '-c',
    'grep -l -a -F -f /dev/stdin /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null; true'], secret);
  for (const user of ['10001', '0']) {
    const passHits = await scan(user, PASSKEY);
    assert.equal(passHits.stdout, '', `passphrase found as uid ${user} in: ${passHits.stdout}`);
  }
  const tokenHits = await scan('10001', TOKEN);
  assert.match(tokenHits.stdout, /environ/, 'control failed: token not found in the agent environment');
});

test('docker inspect shows neither the token nor the passphrase', async () => {
  const name = containers[0];
  const r = await docker(['inspect', name]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(TOKEN), 'token visible in docker inspect');
  assert.ok(!r.stdout.includes(PASSKEY), 'passphrase visible in docker inspect');
});

test('secrets passed as env vars are refused', async () => {
  for (const name of ['CYSU_TOKEN', 'CYSU_PASSPHRASE', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
    const r = await worker(['true'], { env: { CYSU_SECRETS: 'stdin', [name]: 'x' } });
    assert.equal(r.code, 4, `${name}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${name} was passed as an env var`));
  }
});

test('bad or missing secrets are refused', async () => {
  for (const input of ['', 'not json\n', '{"token":"t"}\n', '{"passphrase":"p"}\n', '{"token":1,"passphrase":2}\n']) {
    const r = await worker(['true'], { input });
    assert.equal(r.code, 4, `input ${JSON.stringify(input)}: ${r.stderr}`);
  }
  const noSecrets = await worker([], { env: {}, input: '' });
  assert.equal(noSecrets.code, 4, noSecrets.stderr);
});

// ---- the user's own secrets (engine /api/secrets) ------------------------------------

test('user secrets reach the agent as env vars, values exactly as given', async () => {
  const tricky = `it's "quoted" $HOME \`id\` ; rm -rf / & | \\ é ✓\nsecond line`;
  const input = secretsLine(settings, null, '', { BROWSERBASE_API_KEY: 'bb_live_test_123', TRICKY: tricky });
  const r = await worker(['sh', '-c', 'echo "bb=$BROWSERBASE_API_KEY"; printf "%s" "$TRICKY" | base64 -w0; echo; echo "token=$CYSU_TOKEN"; id -un'], { input });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^bb=bb_live_test_123$/m);
  assert.ok(r.stdout.includes(Buffer.from(tricky).toString('base64')), 'the tricky value arrives byte for byte');
  assert.match(r.stdout, new RegExp(`^token=${TOKEN}$`, 'm'));
  assert.match(r.stdout, /^runner$/m, 'still runs as the agent user');
  assert.match(r.stderr, /secrets for the agent: BROWSERBASE_API_KEY TRICKY/);
  assert.ok(!r.stderr.includes('bb_live_test_123'), 'the value is never logged');
});

test('a secret can never replace the worker\'s own variables', async () => {
  const input = secretsLine(settings, null, '', {
    CYSU_TOKEN: 'hijacked', PATH: '/nowhere', OPENAI_API_KEY: 'x', LD_PRELOAD: '/tmp/x.so', lower_case: 'x', 'BAD-NAME': 'x', GOOD_ONE: 'ok',
  });
  const r = await worker(['sh', '-c', 'echo "token=$CYSU_TOKEN"; echo "path=$PATH"; echo "openai=${OPENAI_API_KEY:-<unset>}"; echo "ld=${LD_PRELOAD:-<unset>}"; echo "lower=${lower_case:-<unset>}"; echo "good=$GOOD_ONE"'], { input });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^token=${TOKEN}$`, 'm'));
  assert.doesNotMatch(r.stdout, /path=\/nowhere/);
  assert.match(r.stdout, /^openai=<unset>$/m);
  assert.match(r.stdout, /^ld=<unset>$/m);
  assert.match(r.stdout, /^lower=<unset>$/m);
  assert.match(r.stdout, /^good=ok$/m);
  assert.match(r.stderr, /ignored 6 secret\(s\) with a reserved or invalid name/);
});

test('user secrets are not in docker inspect, and no secrets still works', async () => {
  const name = `cysu-secrets-inspect-${randomBytes(4).toString('hex')}`;
  containers.push(name);
  const child = spawn('docker', ['run', '-i', '--name', name, ...hardeningArgs(),
    '-e', 'CYSU_WORKER_TEST_BOOTSTRAP=0', '-e', 'CYSU_SECRETS=stdin', IMAGE, 'sh', '-c', 'echo up; sleep 30'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(secretsLine(settings, null, '', { INSPECT_ME: 'value-that-must-not-leak' }));
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const inspect = await docker(['inspect', name]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.ok(!inspect.stdout.includes('value-that-must-not-leak'), 'not in docker inspect');
  assert.ok(!inspect.stdout.includes('INSPECT_ME'), 'not even the name');
  child.kill('SIGKILL');
  await docker(['rm', '-f', name]);

  const none = await worker(['sh', '-c', 'echo "none=${BROWSERBASE_API_KEY:-<unset>}"']);
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /^none=<unset>$/m);
});
