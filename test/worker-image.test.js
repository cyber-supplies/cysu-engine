import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareWorkerImage } from '../server/worker-image.js';

const id = `sha256:${'a'.repeat(64)}`;
const latest = 'ghcr.io/cyber-supplies/cysu-engine-workspace:latest';

test('latest is pulled and fixed to an image ID for the run', async () => {
  const calls = [];
  const result = await prepareWorkerImage(latest, async (args) => {
    calls.push(args);
    return args[0] === 'pull' ? '' : id;
  });
  assert.deepEqual(calls, [['pull', '--quiet', latest], ['image', 'inspect', '--format', '{{.Id}}', latest]]);
  assert.deepEqual(result, { ref: latest, id, refreshed: true });
});

test('a pinned or local image is not pulled', async () => {
  const calls = [];
  const ref = 'cysu-engine-workspace:test';
  const result = await prepareWorkerImage(ref, async (args) => { calls.push(args); return id; });
  assert.deepEqual(calls, [['image', 'inspect', '--format', '{{.Id}}', ref]]);
  assert.deepEqual(result, { ref, id, refreshed: false });
});

test('failed refresh uses the cached image and says so', async () => {
  const result = await prepareWorkerImage(latest, async (args) => {
    if (args[0] === 'pull') throw new Error('registry unavailable');
    return id;
  });
  assert.equal(result.id, id);
  assert.equal(result.refreshed, false);
  assert.match(result.warning, /registry unavailable/);
});

test('failed refresh with no cached image stops the run', async () => {
  await assert.rejects(prepareWorkerImage(latest, async () => { throw new Error('registry unavailable'); }), /Could not refresh/);
});
