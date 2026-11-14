// Which CLI a run uses (server/cli-cache.js), with a stand-in docker and npm:
// one install per release, an hourly npm check, and fallbacks that never
// block a run. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliCache, cliSetting, byVersionDesc, LATEST_CHECK_MS } from '../server/cli-cache.js';

// fakeDocker: a volume holding `installed` versions; `install` decides how an install goes.
function fakeDocker({ installed = [], install = () => true } = {}) {
  const state = { installed: new Set(installed), calls: [] };
  state.docker = async (args) => {
    const script = args.at(-1);
    const version = (args.find((a) => a.startsWith('V=')) || '').slice(2);
    state.calls.push(version ? `install ${version}` : script.includes('rm -rf') ? 'prune' : 'list');
    if (version) {
      if (!install(version)) throw new Error('npm ERR! 404');
      state.installed.add(version);
      return '';
    }
    if (script.includes('rm -rf')) {
      for (const v of script.match(/'([\d.]+)'/g).map((q) => q.slice(1, -1))) state.installed.delete(v);
      return '';
    }
    return [...state.installed].join('\n');
  };
  return state;
}

test('the setting: latest (default), image, or an exact version', () => {
  assert.equal(cliSetting(undefined), 'latest');
  assert.equal(cliSetting(''), 'latest');
  assert.equal(cliSetting('LATEST'), 'latest');
  assert.equal(cliSetting('image'), 'image');
  assert.equal(cliSetting(' 0.6.3 '), '0.6.3');
  assert.equal(cliSetting('0.6'), 'latest', 'not a full version');
  assert.equal(cliSetting('0.6.3; rm -rf /'), 'latest');
  assert.deepEqual(['0.6.10', '0.6.9', '1.0.0', '0.10.0'].sort(byVersionDesc), ['1.0.0', '0.10.0', '0.6.10', '0.6.9']);
});

test('a new release is downloaded once; later runs reuse it; npm is asked at most hourly', async () => {
  const d = fakeDocker();
  let clock = 0; let lookups = 0;
  const cache = new CliCache({ docker: d.docker, latest: async () => { lookups++; return '0.6.3'; }, now: () => clock });
  const first = await cache.prepare();
  assert.equal(first.source, 'cache');
  assert.equal(first.version, '0.6.3');
  assert.match(first.note, /just downloaded/);
  assert.deepEqual(first.env, { CYSU_CLI_DIR: '/opt/cysu-cache/0.6.3' });
  assert.deepEqual(first.mounts, ['-v', 'cysu-engine-cli:/opt/cysu-cache:ro'], 'read-only for workers');
  const second = await cache.prepare();
  assert.equal(second.version, '0.6.3');
  assert.equal(d.calls.filter((c) => c.startsWith('install')).length, 1, 'installed once');
  assert.equal(lookups, 1, 'npm asked once within the hour');
  clock = LATEST_CHECK_MS + 1;
  await cache.prepare();
  assert.equal(lookups, 2, 'asked again after an hour');
});

test('a newer release arrives: it is installed and used; old ones beyond three are removed', async () => {
  const d = fakeDocker({ installed: ['0.6.0', '0.6.1', '0.6.2'] });
  const cache = new CliCache({ docker: d.docker, latest: async () => '0.6.3' });
  const r = await cache.prepare();
  assert.equal(r.version, '0.6.3');
  assert.deepEqual([...d.installed].sort(byVersionDesc), ['0.6.3', '0.6.2', '0.6.1']);
});

test('npm unreachable: the newest version already downloaded; nothing downloaded: the image copy', async () => {
  const down = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); };
  const d = fakeDocker({ installed: ['0.6.1', '0.6.2'] });
  const r = await new CliCache({ docker: d.docker, latest: down }).prepare();
  assert.equal(r.source, 'cache');
  assert.equal(r.version, '0.6.2');
  assert.match(r.note, /newest already downloaded: could not check npm/);
  const empty = await new CliCache({ docker: fakeDocker().docker, latest: down }).prepare();
  assert.equal(empty.source, 'image');
  assert.deepEqual(empty.env, {});
  assert.deepEqual(empty.mounts, []);
  assert.match(empty.note, /copy in the worker image: could not check npm/);
});

test('an install that fails falls back the same way, and is tried again next run', async () => {
  let works = false;
  const d = fakeDocker({ installed: ['0.6.2'], install: () => works });
  const cache = new CliCache({ docker: d.docker, latest: async () => '0.6.3' });
  const r = await cache.prepare();
  assert.equal(r.version, '0.6.2');
  assert.match(r.note, /could not download CLI 0\.6\.3/);
  works = true;
  assert.equal((await cache.prepare()).version, '0.6.3');
});

test('an exact version is used as is; "image" never touches docker or npm', async () => {
  const d = fakeDocker();
  let lookups = 0;
  const pinned = await new CliCache({ setting: '0.6.1', docker: d.docker, latest: async () => { lookups++; return '0.6.3'; } }).prepare();
  assert.equal(pinned.version, '0.6.1');
  assert.equal(lookups, 0, 'no npm check for a pinned version');
  const none = fakeDocker();
  const image = await new CliCache({ setting: 'image', docker: none.docker, latest: async () => { throw new Error('no'); } }).prepare();
  assert.equal(image.source, 'image');
  assert.deepEqual(none.calls, []);
});

test('runs starting together share one install', async () => {
  const d = fakeDocker();
  const cache = new CliCache({ docker: d.docker, latest: async () => '0.6.3' });
  const all = await Promise.all([cache.prepare(), cache.prepare(), cache.prepare()]);
  assert.deepEqual(all.map((r) => r.version), ['0.6.3', '0.6.3', '0.6.3']);
  assert.equal(d.calls.filter((c) => c.startsWith('install')).length, 1);
});
