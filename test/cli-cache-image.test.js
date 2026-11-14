// The CLI cache for real: install the current CLI release from npm (and its
// skill from the cysu-cli release tag) into a throwaway volume, then start
// workers that use it read-only, and fall back to the image copy when it is
// unusable. Needs Docker, the worker image and the network (npm, GitHub);
// skipped when npm cannot be reached. Run: npm run test:image

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { CliCache, CLI_MOUNT } from '../server/cli-cache.js';
import { hardeningArgs, secretsLine, IMAGE } from '../server/docker.js';

const VOLUME = `cysu-cli-test-${randomBytes(4).toString('hex')}`;
const settings = { token: 'cli-cache-test-token', passkey: 'cli-cache-test-passkey', llm: { mode: 'none' } };
const latest = await fetch('https://registry.npmjs.org/@cyber-supplies%2fcysu/latest', { signal: AbortSignal.timeout(10_000) })
  .then((r) => r.json()).then((j) => j.version).catch(() => null);

function docker(args, input) {
  return new Promise((resolve) => {
    const child = execFile('docker', args, { timeout: 300_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.end(input ?? '');
  });
}
function worker(cli, command) {
  const env = { CYSU_WORKER_TEST_BOOTSTRAP: '0', CYSU_SECRETS: 'stdin', ...(cli.env || {}) };
  return docker(['run', '--rm', '-i', ...hardeningArgs(), ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...(cli.mounts || []), IMAGE, ...command], secretsLine(settings));
}
after(async () => { await docker(['volume', 'rm', '-f', VOLUME]); });

test('installs the newest CLI release once, and workers use it read-only', { skip: !latest && 'npm not reachable' }, async () => {
  const cache = new CliCache({ volume: VOLUME });
  const started = Date.now();
  const cli = await cache.prepare();
  assert.equal(cli.source, 'cache', cli.note);
  assert.equal(cli.version, latest);
  assert.match(cli.note, /just downloaded/);
  const installTook = Date.now() - started;

  // What is in the volume: the CLI, its version, and the skill of that same version.
  const listing = await docker(['run', '--rm', '--entrypoint', 'sh', '-v', `${VOLUME}:/c:ro`, IMAGE, '-c',
    `cat /c/${latest}/version; test -x /c/${latest}/bin/cysu && echo cli-ok; head -5 /c/${latest}/skill/SKILL.md | grep -c '^name: *cysu'; ls -A /c | grep -c '^.tmp' || true`]);
  assert.equal(listing.code, 0, listing.stderr);
  assert.deepEqual(listing.stdout.split('\n'), [latest, 'cli-ok', '1', '0'], 'version, CLI, skill; no leftover temp folder');

  // A worker: that CLI first on PATH, that skill installed, and it cannot write the cache.
  const r = await worker(cli, ['sh', '-c', `command -v cysu; head -5 ~/.agents/skills/cysu/SKILL.md | grep -c '^name: *cysu'; touch ${CLI_MOUNT}/x 2>&1 || echo read-only`]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^${CLI_MOUNT}/${latest.replace(/\./g, '\\.')}/bin/cysu$`, 'm'));
  assert.match(r.stdout, /^1$/m, 'skill installed');
  assert.match(r.stdout, /read-only/);
  assert.match(r.stderr, new RegExp(`Cyber Supplies CLI ${latest.replace(/\./g, '\\.')} \\(the engine's copy\\)`));

  // The next run reuses it: no second download.
  const again = Date.now();
  const second = await new CliCache({ volume: VOLUME }).prepare();
  assert.equal(second.version, latest);
  assert.doesNotMatch(second.note, /just downloaded/);
  console.log(`install ${installTook} ms; next run ${Date.now() - again} ms`);
});

test('an unusable cache folder, or one outside the cache, falls back to the image copy', async () => {
  for (const dir of [`${CLI_MOUNT}/9.9.9`, '/tmp/elsewhere']) {
    const r = await worker({ env: { CYSU_CLI_DIR: dir }, mounts: ['-v', `${VOLUME}:${CLI_MOUNT}:ro`] }, ['sh', '-c', 'command -v cysu']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\/usr\/local\/bin\/cysu$/m, dir);
    assert.match(r.stderr, /the copy in this image/, dir);
    assert.match(r.stderr, /is not usable; using the one in this image/, dir);
  }
  // No cache at all (CYSU_CLI_VERSION=image): the image copy, quietly.
  const plain = await worker({}, ['sh', '-c', 'command -v cysu']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /^\/usr\/local\/bin\/cysu$/m);
  assert.doesNotMatch(plain.stderr, /not usable/);
});
