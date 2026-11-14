// Native CLI boundary with a stand-in login/model; real containers and cysu profiles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeApi } from './fixtures/fake-api.js';

const dir = await mkdtemp(join(tmpdir(), 'cysu-claude-stages-'));
process.env.CYSU_ENGINE_DATA = dir;
const { ClaudeLogin } = await import('../server/claude-login.js');
const { Runs } = await import('../server/runs.js');
const { loadSettings } = await import('../server/settings.js');
const image = 'cysu-engine-workspace:test';
const login = new ClaudeLogin({ image });
const token = 'usr_claude-stage-test';
let api, runs;
let codexAuth = { auth_mode: 'chatgpt', tokens: { access_token: 'fake-codex-access' } };
const settings = { token, passkey: 'claude-stage-test', llm: { mode: 'codex', openrouter: { apiKey: 'sk-or-claude-stage-test', model: 'test/model' } } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const deadline = Date.now() + 60_000;
  do { const value = await fn(); if (value) return value; await pause(100); } while (Date.now() < deadline);
  throw new Error('Timed out');
}
async function signIn() {
  await login.start();
  const state = await until(() => login.state().status === 'waiting' && login.state());
  await login.submitCode({ id: state.id, code: 'success#fake-state' });
  await until(() => login.state().status === 'succeeded');
  await login.exclusive(() => {});
  return login.savedVolume();
}
const finished = (id) => until(async () => { const run = await runs.get(id); return !['running', 'queued'].includes(run.status) && !runs.busy && run; });
before(async () => {
  const gateway = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gateway, token);
  await signIn();
  assert.equal((await loadSettings()).llm.mode, 'codex', 'saving Claude login enables execution');
  runs = new Runs({ dir: join(dir, 'runs'),
    getSecrets: async () => ({ settings, codexAuth, claudeAuth: (await login.authInfo()).saved }),
    acquireClaude: () => login.acquireVolume(),
    listProfiles: async () => [{ id: 'attack' }, { id: 'recon' }, { id: 'global' }],
    stageOptions: { image, extraEnv: { CYSU_API_URL: api.url, CYSU_EGRESS_GUARD: '0' } },
  });
});
after(async () => {
  await runs?.close();
  await login.forget();
  api?.server.close();
  await rm(dir, { recursive: true, force: true });
});

test('explicit Claude overrides other saved credentials, runs stages serially and resumes follow-ups', async () => {
  const request = { provider: 'claude', globalProfile: 'global', objective: 'go', model: 'bad-model', fallbackModel: 'sonnet', reasoningEffort: 'high',
    stages: [{ profile: 'attack', reprompts: ['finish'] }, { profile: 'recon', model: 'sonnet' }] };
  const created = await runs.create(request);
  const run = await finished(created.id);
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.equal(run.request.provider, 'claude');
  assert.equal(run.provider, 'claude');
  assert.deepEqual(run.stages[0].attempts.map((a) => [a.provider, a.kind, a.status]), [
    ['claude', 'initial', 'failed'], ['claude', 'fallback', 'succeeded'], ['claude', 'reprompt', 'succeeded'],
  ]);
  assert.ok(Date.parse(run.stages[1].startedAt) >= Date.parse(run.stages[0].finishedAt));
  const seen = JSON.parse(run.stages[0].result);
  assert.equal(seen.resumed, true);
  assert.equal(seen.thread, run.stages[0].threadId);
  assert.equal(seen.user, 'runner');
  assert.match(seen.args, /--model sonnet --effort high --resume/);
  assert.match(seen.globalAgents, /GLOBAL-PROMPT-MARKER/);
  assert.match(seen.workspaceAgents, /STAGE-PROMPT-MARKER/);
  assert.match(seen.mcp, /stagemcp/);
  assert.match(seen.files, /\.claude\/skills\/cysu\/SKILL.md/);
  assert.match(seen.files, /\.claude\/skills\/attack-playbook\/SKILL.md/);
  assert.equal(seen.otherAuth, '');
  assert.equal(run.stages[0].usage.output_tokens, 22);
  assert.doesNotMatch(JSON.stringify(run), /fake-claude-private|sk-or-claude-stage-test|fake-codex-access/);
  const repeated = await runs.rerun(run.id);
  assert.equal(repeated.provider, 'claude');
  assert.equal((await finished(repeated.id)).status, 'succeeded');
});

test('automatic Claude selection and a later stage without global profile reuse auth but not old global instructions', async () => {
  codexAuth = null;
  const created = await runs.create({ objective: 'go', stages: [{ profile: 'attack' }] });
  assert.equal(created.provider, 'claude');
  assert.equal(created.request.provider, undefined);
  const run = await finished(created.id);
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.equal(JSON.parse(run.stages[0].result).globalAgents, '');
});

test('Claude failures do not select OpenRouter, and missing final results fail closed', async () => {
  for (const objective of ['FAIL-TURN', 'NO-RESULT']) {
    const created = await runs.create({ objective, stages: [{ profile: 'attack' }] });
    const run = await finished(created.id);
    assert.equal(run.status, 'failed');
    assert.deepEqual(run.stages[0].attempts.map((a) => a.provider), ['claude']);
  }
});

test('a running Claude workflow owns its volume until cancellation; concurrent starts are refused', async () => {
  const outcomes = await Promise.allSettled([1, 2].map(() => runs.create({ provider: 'claude', objective: 'SLEEP', stages: [{ profile: 'attack' }] })));
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((o) => o.status === 'rejected').reason.status, 409);
  const created = outcomes.find((o) => o.status === 'fulfilled').value;
  await until(() => runs.active?.stage?.events.some((e) => e.type === 'system'));
  const oldVolume = await login.savedVolume();
  await assert.rejects(login.forget(), { status: 409 });
  await assert.rejects(login.acquireVolume(), { status: 409 });
  const newVolume = await signIn();
  assert.notEqual(newVolume, oldVolume);
  assert.ok(execFileSync('docker', ['volume', 'inspect', oldVolume]).length, 'replacement must preserve the running volume');
  await runs.cancel(created.id);
  assert.equal((await finished(created.id)).status, 'cancelled');
  assert.throws(() => execFileSync('docker', ['volume', 'inspect', oldVolume], { stdio: 'pipe' }));
  assert.equal((await login.authInfo()).saved, true);
});
