// Worker container hardening: runs real containers with the engine's flags.
// Needs Docker and the image (npm run image:build). Run: npm run test:image

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { hardeningArgs, IMAGE } from '../server/docker.js';

function sh(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// worker runs `command` as the hardened runner user (entrypoint command mode).
function worker(command, { env = {}, flags = hardeningArgs() } = {}) {
  const envArgs = Object.entries({ CYSU_WORKER_TEST_BOOTSTRAP: '0', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return sh('docker', ['run', '--rm', ...flags, ...envArgs, IMAGE, 'sh', '-c', command]);
}

// A web server on the host's Docker bridge address stands in for "your machine".
let server, hostUrl;
before(async () => {
  const gw = await sh('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']);
  assert.equal(gw.code, 0, gw.stderr);
  server = createServer((req, res) => res.end('host-reached'));
  await new Promise((resolve) => server.listen(0, gw.stdout, resolve));
  hostUrl = `http://${gw.stdout}:${server.address().port}/`;
});
after(() => server?.close());

test('agent runs as runner (uid 10001) with no capabilities and no-new-privileges', async () => {
  const r = await worker('id -u; grep -E "^(CapEff|CapPrm|NoNewPrivs)" /proc/self/status');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^10001$/m);
  assert.match(r.stdout, /CapEff:\s+0+$/m);
  assert.match(r.stdout, /CapPrm:\s+0+$/m);
  assert.match(r.stdout, /NoNewPrivs:\s+1$/m);
});

test('agent cannot change the firewall or become root', async () => {
  const r = await worker('iptables -F OUTPUT 2>&1 && echo FLUSHED; su -c id root </dev/null 2>&1 || true; sudo id 2>&1 || true');
  assert.doesNotMatch(r.stdout, /FLUSHED/);
  assert.doesNotMatch(r.stdout, /uid=0/);
});

test('public internet and DNS work', async () => {
  const r = await worker('getent hosts example.com >/dev/null && echo DNS-OK; curl -sS -o /dev/null -w "%{http_code}" --max-time 15 https://example.com');
  assert.match(r.stdout, /DNS-OK/);
  assert.match(r.stdout, /[23]\d\d$/, `curl output: ${r.stdout} ${r.stderr}`);
});

test('control: with the firewall off, the host IS reachable (proves the next test means something)', async () => {
  const r = await worker(`curl -sS --max-time 5 ${hostUrl}`, { env: { CYSU_EGRESS_GUARD: '0' } });
  assert.equal(r.stdout, 'host-reached', `host not reachable even without firewall: ${r.stderr}`);
});

test('host machine, LAN and cloud metadata are blocked', async () => {
  for (const url of [hostUrl, 'http://169.254.169.254/', 'http://192.168.1.1/', 'http://10.0.0.1/']) {
    const r = await worker(`curl -sS --max-time 5 ${url}; echo "exit=$?"`);
    assert.doesNotMatch(r.stdout, /host-reached/, url);
    // curl exit 7 = connection refused/rejected, i.e. the firewall answered (not a timeout).
    assert.match(r.stdout, /exit=7$/, `${url}: ${r.stdout} ${r.stderr}`);
  }
});

test('refuses to run when the firewall cannot be installed (no NET_ADMIN)', async () => {
  const flags = hardeningArgs().filter((a, i, all) => !(a === 'NET_ADMIN' || (a === '--cap-add' && all[i + 1] === 'NET_ADMIN')));
  const r = await worker('echo SHOULD-NOT-RUN', { flags });
  assert.equal(r.code, 3);
  assert.doesNotMatch(r.stdout, /SHOULD-NOT-RUN/);
  assert.match(r.stderr, /refusing to run/);
});

test('docker stop is forwarded to the agent (graceful stop, needed for cancel)', async () => {
  const name = `cysu-stop-test-${process.pid}`;
  const started = await sh('docker', ['run', '-d', '--name', name, ...hardeningArgs(), '-e', 'CYSU_WORKER_TEST_BOOTSTRAP=0', IMAGE,
    'sh', '-c', 'trap "echo GOT-SIGTERM; exit 0" TERM; while :; do sleep 0.2; done']);
  assert.equal(started.code, 0, started.stderr);
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await sh('docker', ['stop', '-t', '10', name]);
    const logs = await sh('docker', ['logs', name]);
    const state = await sh('docker', ['inspect', '-f', '{{.State.ExitCode}}', name]);
    assert.match(logs.stdout, /GOT-SIGTERM/, `agent never saw SIGTERM: ${logs.stderr}`);
    assert.doesNotMatch(logs.stderr, /FATAL tini/);
    assert.equal(state.stdout, '0');
  } finally {
    await sh('docker', ['rm', '-f', name]);
  }
});

test('memory and process limits are applied', async () => {
  const r = await worker('cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max');
  assert.equal(r.code, 0, r.stderr);
  const [memory, pids] = r.stdout.split('\n');
  assert.equal(Number(memory), 4 * 1024 ** 3);
  assert.equal(pids, '512');
});
