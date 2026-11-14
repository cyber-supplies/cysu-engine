import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runs } from '../server/runs.js';
import { Workspaces } from '../server/workspaces.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const settings = { token: 'usr-test', passkey: 'test', llm: { mode: 'codex', openrouter: { apiKey: 'sk-or-test', model: 'test/model' } } };
const request = { objective: 'test', stages: [{ profile: 'one' }, { profile: 'two' }] };
test('workflow plans resolve all stages once and explicit credentials are required', async () => {
  let codexAuth = {}, claudeAuth = true;
  const runs = new Runs({ getSecrets: async () => ({ settings, codexAuth, claudeAuth }), listProfiles: async () => [{ id: 'one' }, { id: 'two' }] });
  for (const expected of ['codex', 'claude', 'openrouter']) {
    const plan = await runs.plan(request);
    assert.equal(plan.provider, expected);
    assert.deepEqual(plan.stages.map((s) => s.provider), [expected, expected]);
    if (expected === 'openrouter') assert.equal(plan.stages[0].model, 'test/model');
    if (expected === 'codex') codexAuth = null; else claudeAuth = false;
  }
  await assert.rejects(runs.plan({ ...request, provider: 'claude' }), /claude is not configured/);
  await assert.rejects(runs.plan({ ...request, provider: 'codex' }), /codex is not configured/);
  codexAuth = {}; claudeAuth = true;
  for (const provider of ['codex', 'claude', 'openrouter']) assert.equal((await runs.plan({ ...request, provider })).provider, provider);
  await assert.rejects(runs.plan({ ...request, provider: 'invalid' }), /provider must be/);
  await assert.rejects(runs.plan({ ...request, stages: [{ profile: 'one', provider: 'claude' }] }), /workflow request/);
});

test('workspace configuration rejects unsupported providers without requiring saved credentials', () => {
  for (const provider of ['codex', 'claude', 'openrouter', undefined]) assert.doesNotThrow(() => Workspaces.check('workflow', { provider, stages: [] }));
  for (const provider of ['auto', '', null, 4]) assert.throws(() => Workspaces.check('workflow', { provider }), /provider must be/);
});

test('a lost Claude volume fails the run without switching provider or leaving stages pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cysu-provider-unavailable-'));
  const runs = new Runs({ dir,
    getSecrets: async () => ({ settings, claudeAuth: true }),
    listProfiles: async () => [{ id: 'one' }, { id: 'two' }],
    acquireClaude: async () => { throw new Error('Claude volume unavailable'); },
  });
  try {
    const created = await runs.create(request);
    await runs.active.finished;
    const run = await runs.get(created.id);
    assert.equal(run.provider, 'claude');
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'Claude volume unavailable');
    assert.deepEqual(run.stages.map((s) => s.status), ['skipped', 'skipped']);
    assert.equal(runs.busy, false);
  } finally { await runs.close(); await rm(dir, { recursive: true, force: true }); }
});
