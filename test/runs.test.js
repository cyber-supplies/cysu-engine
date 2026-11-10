// Runs: storage on disk, cancel, delete, restart recovery, ChatGPT login
// copy-back, and the HTTP API the CLI builds on (incl. same-machine checks).
// Real cysu + stand-in Cyber Supplies API + stand-in `codex exec` (no LLM).
// Needs Docker + both images (npm run image:build && npm run image:build:test).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startFakeApi, llmTokenFor } from './fixtures/fake-api.js';

const DATA = await mkdtemp(join(tmpdir(), 'cysu-engine-runs-'));
process.env.CYSU_ENGINE_DATA = DATA; // before the server modules load
const { Runs } = await import('../server/runs.js');
const { save, load } = await import('../server/store.js');
const { LABEL } = await import('../server/docker.js');
const { fetchProfiles, fetchLlmToken } = await import('../server/profiles.js');

const TEST_IMAGE = 'cysu-engine-workspace:test';
const TOKEN = 'usr_runs-test-token-91c2';
const PASSKEY = 'runs-test-passkey-55e0';
const API_KEY = 'sk-runs-test-0f1e2d3c';
const FAKE_AUTH = { auth_mode: 'chatgpt', tokens: { access_token: 'at-1', refresh_token: 'rt-original' } };

let api, gateway;
const AUTH = { Authorization: `Bearer ${TOKEN}` }; // the engine token (= the user token, after setup)
const API_KEY_SETTINGS = { token: TOKEN, passkey: PASSKEY, llm: { mode: 'openai-api-key', apiKey: API_KEY } };
let secrets = { settings: structuredClone(API_KEY_SETTINGS), codexAuth: null };
let runs;

before(async () => {
  gateway = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gateway, TOKEN);
  runs = new Runs({
    dir: join(DATA, 'runs'),
    getSecrets: async () => structuredClone(secrets),
    listProfiles: (settings) => fetchProfiles(settings.token, { apiUrl: api.url }),
    stageOptions: { image: TEST_IMAGE, extraEnv: { CYSU_API_URL: api.url, CYSU_EGRESS_GUARD: '0' } },
  });
  await runs.recover();
});
after(async () => {
  await runs?.close();
  api?.server.close();
  await rm(DATA, { recursive: true, force: true });
});

const sh = (file, args) => new Promise((resolve) => execFile(file, args, (e, out, err) => resolve({ code: e ? e.code : 0, out: String(out).trim(), err: String(err).trim() })));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function finished(id, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const run = await runs.get(id);
    if (!['queued', 'running'].includes(run.status)) return run;
    if (Date.now() > end) throw new Error(`run still ${run.status}`);
    await sleep(300);
  }
}
async function rejects(promise, status, message) {
  await assert.rejects(promise, (e) => e.status === status && message.test(e.message));
}

// ---- runs module ----------------------------------------------------------------

test('create validates the request', async () => {
  await rejects(runs.create({ prompt: 'x', stages: [] }), 400, /at least one stage/);
  await rejects(runs.create({ prompt: 'x', stages: Array.from({ length: 21 }, () => ({ profile: 'attack' })) }), 400, /At most 20 stages/);
  await rejects(runs.create({ prompt: 'x', stages: [{ profile: 'attack' }], fromTags: {} }), 400, /either stages or fromTags/);
  await rejects(runs.create({ prompt: 'x', stages: [{ profile: 'bad id!' }] }), 400, /stage profile/);
  await rejects(runs.create({ prompt: '', stages: [{ profile: 'attack' }] }), 400, /An objective is required/);
  await rejects(runs.create({ objective: '  ', stages: [{ profile: 'attack' }] }), 400, /An objective is required/);
  const saved = secrets;
  secrets = { settings: { token: '', passkey: '' } };
  await rejects(runs.create({ prompt: 'x', stages: [{ profile: 'attack' }] }), 400, /token and passkey/);
  for (const [llm, codexAuth] of [[{ mode: 'none' }, null], [{ mode: 'openai-api-key', apiKey: '' }, null], [{ mode: 'codex' }, null]]) {
    secrets = { settings: { token: TOKEN, passkey: PASSKEY, llm }, codexAuth };
    await rejects(runs.create({ prompt: 'x', stages: [{ profile: 'attack' }] }), 400, /Log in to your LLM first: sign in with ChatGPT \(Codex\) or add an OpenAI API key/);
  }
  secrets = saved;
  assert.deepEqual(await runs.list(), [], 'a rejected request must not leave a run behind');
});

let firstRunId;
test('a run is stored on disk: run.json, numbered events, log; secrets stay out', async () => {
  const created = await runs.create({ name: 'first', prompt: 'Map the target', globalProfile: 'global', model: 'gpt-test', stages: [{ profile: 'attack', reasoningEffort: 'low' }] });
  firstRunId = created.id;
  assert.equal(created.status, 'queued');
  const run = await finished(created.id);
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  const [stage] = run.stages;
  assert.equal(stage.status, 'succeeded');
  assert.equal(stage.threadId, 'fake-thread-0001');
  assert.equal(stage.turns, 1);
  assert.equal(stage.reasoningEffort, 'low', 'per-stage setting');
  assert.equal(stage.model, 'gpt-test', 'run default applied to the stage');
  assert.match(JSON.parse(stage.result).args, /--model gpt-test -c model_reasoning_effort="low"/);

  const folder = join(DATA, 'runs', run.id);
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'run.json'), 'utf8')).status, 'succeeded');
  const lines = (await readFile(join(folder, 'stages/0/events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  // 5 Codex events + the engine.attempt start/finish markers
  assert.deepEqual(lines.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([lines[0].type, lines.at(-1).type], ['engine.attempt', 'engine.attempt.finished']);
  assert.equal(stage.eventCount, 7);
  const log = await readFile(join(folder, 'stages/0/log.txt'), 'utf8');
  assert.match(log, /installing global profile: global/);
  assert.match(log, /running Codex \(model gpt-test\) \(effort low\)/);
  for (const file of ['run.json', 'stages/0/events.jsonl', 'stages/0/log.txt']) {
    assert.equal((await stat(join(folder, file))).mode & 0o777, 0o600, `${file} permissions`);
    const text = await readFile(join(folder, file), 'utf8');
    assert.ok(!text.includes(TOKEN) && !text.includes(PASSKEY), `secret in ${file}`);
  }
  const left = await sh('docker', ['ps', '-a', '-q', '--filter', `name=${stage.container}`]);
  assert.equal(left.out, '', 'stage container not removed');
});

test('events are paged with a cursor; log is plain text', async () => {
  const page1 = await runs.events(firstRunId, 0, { after: 0, limit: 2 });
  assert.deepEqual(page1.events.map((e) => e.seq), [1, 2]);
  assert.equal(page1.next, 2);
  const page2 = await runs.events(firstRunId, 0, { after: page1.next });
  assert.deepEqual(page2.events.map((e) => e.seq), [3, 4, 5, 6, 7]);
  assert.equal(page2.done, true);
  const empty = await runs.events(firstRunId, 0, { after: 7 });
  assert.deepEqual(empty, { events: [], next: 7, done: true });
  await rejects(runs.events(firstRunId, 7), 404, /Stage not found/);
  await rejects(runs.events('not-a-run', 0), 404, /Run not found/);
});

test('one active run at a time; cancel stops it and removes its container', async () => {
  const created = await runs.create({ prompt: 'SLEEP please', stages: [{ profile: 'attack' }] });
  await rejects(runs.create({ prompt: 'x', stages: [{ profile: 'attack' }] }), 409, /already active/);
  await rejects(runs.delete(created.id), 409, /Cancel the run/);
  for (let i = 0; i < 100 && !(await runs.get(created.id)).stages[0].threadId; i++) await sleep(200);
  const startedCancel = Date.now();
  await runs.cancel(created.id);
  const run = await finished(created.id);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.stages[0].status, 'cancelled');
  assert.ok(Date.now() - startedCancel < 20_000);
  const left = await sh('docker', ['ps', '-a', '-q', '--filter', `name=${run.stages[0].container}`]);
  assert.equal(left.out, '');
  await rejects(runs.cancel(created.id), 409, /not active/);
});

test('failed stage → failed run, error kept', async () => {
  const run = await finished((await runs.create({ prompt: 'FAIL-TURN', stages: [{ profile: 'attack' }] })).id);
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.stages[0].errors, ['fake failure requested']);
});

test('list newest first; delete removes the run folder', async () => {
  const list = await runs.list();
  assert.equal(list.length, 3);
  assert.ok(list[0].createdAt >= list[1].createdAt && list[1].createdAt >= list[2].createdAt);
  assert.equal(list.at(-1).name, 'first');
  assert.equal(list[0].stages[0].profile, 'attack');
  assert.equal(list[0].result, undefined, 'list stays small');
  const victim = list[0].id;
  await runs.delete(victim);
  await rejects(runs.get(victim), 404, /Run not found/);
  assert.ok(!(await readdir(join(DATA, 'runs'))).includes(victim));
});

test('ChatGPT login: a token refreshed during the stage is saved back', async () => {
  await save('codex-auth', { savedAt: 'x', auth: FAKE_AUTH });
  secrets = { settings: { token: TOKEN, passkey: PASSKEY, llm: { mode: 'codex' } }, codexAuth: FAKE_AUTH };
  const run = await finished((await runs.create({ prompt: 'REFRESH-LOGIN', stages: [{ profile: 'attack' }] })).id);
  assert.equal(run.status, 'succeeded');
  const stored = (await load('codex-auth')).auth;
  assert.equal(stored.tokens.refresh_token, 'refreshed-by-stage');
  assert.match(await runs.log(run.id, 0), /saved the refreshed ChatGPT login/);
  assert.ok(!(await runs.log(run.id, 0)).includes('refreshed-by-stage'), 'login content in the log');
});

test('ChatGPT login: a newer sign-in during the stage is NOT overwritten', async () => {
  await save('codex-auth', { savedAt: 'x', auth: FAKE_AUTH });
  secrets.codexAuth = FAKE_AUTH;
  const created = await runs.create({ prompt: 'PAUSE REFRESH-LOGIN', stages: [{ profile: 'attack' }] });
  await sleep(1500);
  const newer = { auth_mode: 'chatgpt', tokens: { refresh_token: 'user-signed-in-again' } };
  await save('codex-auth', { savedAt: 'y', auth: newer });
  const run = await finished(created.id);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual((await load('codex-auth')).auth, newer);
  secrets = { settings: structuredClone(API_KEY_SETTINGS), codexAuth: null };
});

test('restart recovery: active runs become interrupted, leftover containers are removed', async () => {
  const id = randomUUID();
  const folder = join(DATA, 'runs', id);
  await mkdir(join(folder, 'stages/0'), { recursive: true });
  await writeFile(join(folder, 'run.json'), JSON.stringify({
    id, name: '', status: 'running', createdAt: new Date().toISOString(), prompt: 'x',
    stages: [{ index: 0, profile: 'attack', status: 'running' }],
  }));
  const orphan = `cysu-orphan-test-${id.slice(0, 6)}`;
  const started = await sh('docker', ['run', '-d', '--name', orphan, '--label', `${LABEL}=stage`, '--entrypoint', 'sleep', TEST_IMAGE, '300']);
  assert.equal(started.code, 0, started.err);

  const result = await runs.recover();
  assert.ok(result.removedContainers.includes(orphan));
  const run = await runs.get(id);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.stages[0].status, 'interrupted');
  assert.equal((await sh('docker', ['ps', '-a', '-q', '--filter', `name=${orphan}`])).out, '');
});

// ---- ordered stages from profile tags (the Windmill flow) -----------------------

const stagesOf = (run) => run.stages.map((s) => `${s.tag}:${s.profile}:${s.status}`);

test('plan: stages from tags, ordered; skip; per-tag models; nothing is started', async () => {
  const before = (await runs.list()).length;
  let plan = await runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: {} });
  assert.deepEqual(stagesOf(plan), ['1:recon:pending', '2:attack:pending', '2:attack-b:pending', '3:escalate:pending', '4:triage:pending']);
  assert.equal(plan.source, 'tags');
  assert.ok(plan.stages.every((s) => s.globalProfile === 'global' && s.prompt === 'p'));

  plan = await runs.plan({ prompt: 'p', globalProfile: 'global', model: 'base-model', fromTags: { skip: ['1', '4'] },
    modelOverrides: [{ stage: 2, model: 'stage2-model' }] });
  assert.deepEqual(plan.stages.map((s) => `${s.profile}=${s.model}`), ['attack=stage2-model', 'attack-b=stage2-model', 'escalate=base-model']);
  assert.deepEqual(plan.skip, ['1', '4']);
  assert.equal((await runs.list()).length, before, 'plan must not create a run');
});

test('plan: Daybreak for the whole run, per stage tag, or on one stage', async () => {
  let plan = await runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: {} });
  assert.ok(plan.stages.every((s) => s.daybreak === 'default'), 'default: OpenAI decides');
  assert.equal(plan.daybreak, 'default');

  plan = await runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: {}, daybreak: 'blue',
    daybreakOverrides: [{ stage: 2, daybreak: 'red' }, { stage: '4', daybreak: 'standard' }] });
  assert.deepEqual(plan.stages.map((s) => `${s.profile}=${s.daybreak}`),
    ['recon=blue', 'attack=red', 'attack-b=red', 'escalate=blue', 'triage=standard']);
  assert.deepEqual(plan.daybreakOverrides, [{ stage: 2, daybreak: 'red' }, { stage: 4, daybreak: 'standard' }]);

  plan = await runs.plan({ prompt: 'p', daybreak: 'blue', stages: [{ profile: 'recon' }, { profile: 'attack', daybreak: 'red' }] });
  assert.deepEqual(plan.stages.map((s) => s.daybreak), ['blue', 'red']);

  await rejects(runs.plan({ prompt: 'p', fromTags: {}, daybreak: 'purple' }), 400, /daybreak must be one of default, standard, blue, red/);
  await rejects(runs.plan({ prompt: 'p', fromTags: {}, daybreakOverrides: [{ stage: 2, daybreak: 'daybreak_red' }] }), 400, /Daybreak override needs a stage 1 to 4/);
  await rejects(runs.plan({ prompt: 'p', fromTags: {}, daybreakOverrides: [{ stage: 2, daybreak: 'red' }, { stage: 2, daybreak: 'blue' }] }), 400, /Duplicate Daybreak override for stage 2/);
  await rejects(runs.plan({ prompt: 'p', fromTags: {}, daybreakOverrides: 'red' }), 400, /must be a list/);
  await rejects(runs.plan({ prompt: 'p', stages: [{ profile: 'attack' }], daybreakOverrides: [{ stage: 2, daybreak: 'red' }] }), 400, /apply to tagged stages/);
  await rejects(runs.plan({ prompt: 'p', stages: [{ profile: 'attack', daybreak: 'pink' }] }), 400, /daybreak must be one of/);
});

test('plan: clear errors (untagged profile, unknown global, bad overrides, upstream down)', async () => {
  api.setProfiles([{ id: 'global', tag: [] }, { id: 'recon', tag: ['1'] }, { id: 'notes', tag: [] }]);
  await rejects(runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: {} }), 400, /Profile notes must have exactly one stage tag/);
  api.reset();
  await rejects(runs.plan({ prompt: 'p', globalProfile: 'gloabl', fromTags: {} }), 400, /Global profile gloabl is not one of your profiles/);
  await rejects(runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: { skip: ['1', '2', '3', '4'] } }), 400, /Every stage was skipped/);
  await rejects(runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: {}, modelOverrides: [{ stage: 2, model: 'a' }, { stage: 2, model: 'b' }] }), 400, /Duplicate model override for stage 2/);
  await rejects(runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: {}, modelOverrides: [{ stage: 9, model: 'a' }] }), 400, /stage 1 to 4/);
  await rejects(runs.plan({ prompt: 'p', stages: [{ profile: 'attack' }], modelOverrides: [{ stage: 2, model: 'a' }] }), 400, /apply to tagged stages/);
  api.setListStatus(500);
  await rejects(runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: {} }), 502, /profile lookup failed \(500\)/);
  api.reset();
});

test('Daybreak reaches each stage\'s Codex and shows in the run and the /watch feed', async () => {
  const created = await runs.create({ prompt: 'p', globalProfile: 'global', fromTags: { skip: ['3', '4'] }, daybreak: 'blue', daybreakOverrides: [{ stage: 2, daybreak: 'red' }] });
  const run = await finished(created.id, 180_000);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.stages.map((st) => `${st.profile}:${st.daybreak}:${st.attempts.map((a) => a.daybreak)}`), ['recon:blue:blue', 'attack:red:red', 'attack-b:red:red']);
  const args = run.stages.map((st) => JSON.parse(st.result).args);
  assert.match(args[0], /--cyber-access-program daybreak_blue -$/);
  assert.match(args[1], /--cyber-access-program daybreak_red -$/);
  assert.deepEqual(run.request.daybreakOverrides, [{ stage: 2, daybreak: 'red' }], '"run again" keeps it');
  const feed = await runs.feed(run.id, { cursor: '' });
  assert.deepEqual(feed.items.filter((it) => it.kind === 'attempt').map((it) => it.text), ['initial · Daybreak blue', 'initial · Daybreak red', 'initial · Daybreak red']);
});

test('Daybreak access error: advice saved on the stage and attached to the /watch feed error', async () => {
  const created = await runs.create({ prompt: 'p', stages: [{ profile: 'attack', model: 'daybreak-denied' }], daybreak: 'red' });
  const run = await finished(created.id, 180_000);
  assert.equal(run.status, 'failed');
  assert.equal(run.stages[0].hints.length, 1);
  assert.match(run.stages[0].hints[0], /Red only works with the cyber models/);
  const errors = (await runs.feed(run.id, { cursor: '' })).items.filter((it) => it.kind === 'error');
  assert.ok(errors.some((it) => /You do not have Daybreak access/.test(it.text) && /use daybreak "blue" instead/.test(it.hint)), JSON.stringify(errors));
  assert.ok(errors.filter((it) => /exit code/.test(it.text)).every((it) => !('hint' in it)), 'plain errors have no hint field');
});

test('while a Daybreak check holds the LLM login, new runs are refused with a clear 409', async () => {
  runs.hold = 'A Daybreak access check is running; start the run again in a minute';
  try {
    assert.equal(runs.busy, true, 'the scheduler sees the engine as busy and waits');
    await rejects(runs.create({ prompt: 'p', stages: [{ profile: 'attack' }] }), 409, /Daybreak access check is running/);
  } finally { runs.hold = ''; }
  assert.equal(runs.busy, false);
});

test('agent token "llm": the worker\'s agent gets the llm_ token (profiles install with it); a failed lookup fails the stage', async () => {
  const userDefault = runs.agentToken;
  runs.agentToken = async (settings) => ({ kind: 'llm', token: await fetchLlmToken(settings.token, { apiUrl: api.url }) });
  try {
    api.requests.length = 0;
    let run = await finished((await runs.create({ prompt: 'p', stages: [{ profile: 'attack' }] })).id);
    assert.equal(run.status, 'succeeded', JSON.stringify(run.stages[0].errors));
    assert.equal(run.stages[0].agentToken, 'llm');
    const byAuth = (auth) => api.requests.filter((r) => r.auth === `Bearer ${auth}`).map((r) => `${r.method} ${r.url}`);
    // The engine itself uses the user token (planning lists the profiles, then
    // it fetches the LLM token); the worker only ever has the LLM token.
    assert.deepEqual(byAuth(TOKEN), ['GET /api/profiles', 'GET /api/tokens/llm']);
    assert.deepEqual(byAuth(llmTokenFor(TOKEN)), ['GET /api/profiles/attack'], 'the worker installed the profile with the LLM token');
    assert.match(await runs.log(run.id, 0), /\[engine\] agent token: LLM token \(restricted\)/);

    api.llmTokens.status = 404;
    api.requests.length = 0;
    run = await finished((await runs.create({ prompt: 'p', stages: [{ profile: 'attack' }] })).id);
    assert.equal(run.status, 'failed');
    assert.match(run.stages[0].errors.join(' '), /no LLM token for your account.*agent token to "user"/);
    assert.deepEqual(api.requests.map((r) => r.url), ['/api/profiles', '/api/tokens/llm'], 'no worker started: nothing ran with the user token instead');
  } finally {
    api.llmTokens.status = 200;
    runs.agentToken = userDefault;
  }
  const run = await finished((await runs.create({ prompt: 'p', stages: [{ profile: 'attack' }] })).id);
  assert.equal(run.stages[0].agentToken, 'user', '"user": the full user token, as before');
});

test('ordered run: every stage in order, each in a FRESH container with global + its own profile', async () => {
  const created = await runs.create({ prompt: 'Objective X', globalProfile: 'global', fromTags: {} });
  const run = await finished(created.id, 180_000);
  assert.equal(run.status, 'succeeded', JSON.stringify(stagesOf(run)));
  assert.deepEqual(stagesOf(run), ['1:recon:succeeded', '2:attack:succeeded', '2:attack-b:succeeded', '3:escalate:succeeded', '4:triage:succeeded']);

  const containers = new Set(run.stages.map((s) => s.container));
  assert.equal(containers.size, 5, 'each stage needs its own container');
  for (let i = 1; i < run.stages.length; i++) {
    assert.ok(run.stages[i].startedAt >= run.stages[i - 1].finishedAt, `stage ${i} started before stage ${i - 1} finished`);
  }
  for (const stage of run.stages) {
    const seen = JSON.parse(stage.result);
    assert.equal(seen.prompt, 'Objective X');
    assert.match(seen.globalAgents, /GLOBAL-PROMPT-MARKER/, `${stage.profile}: global profile missing`);
    assert.match(seen.workspaceAgents, stage.profile === 'attack' ? /you are the attack stage/ : new RegExp(`you are the ${stage.profile} stage`));
    for (const other of run.stages.filter((o) => o !== stage)) {
      assert.ok(!seen.workspaceAgents.includes(`the ${other.profile} stage`), `${stage.profile} sees ${other.profile}'s files: not a fresh container`);
    }
  }
  for (const stage of run.stages) {
    assert.match(await runs.log(run.id, stage.index), new RegExp(`installing stage profile: ${stage.profile}`));
  }
});

test('a failed stage is recorded and the next stages still run (default)', async () => {
  api.setProfiles([{ id: 'global', tag: [] }, { id: 'recon', tag: ['1'] }, { id: 'broken', tag: ['2'] }, { id: 'escalate', tag: ['3'] }]);
  try {
    const run = await finished((await runs.create({ prompt: 'p', globalProfile: 'global', fromTags: {} })).id, 120_000);
    assert.deepEqual(stagesOf(run), ['1:recon:succeeded', '2:broken:failed', '3:escalate:succeeded']);
    assert.equal(run.status, 'failed', 'a run with a failed stage is not "succeeded"');
    assert.deepEqual(run.stages[1].errors, ['fake failure requested']);
  } finally { api.reset(); }
});

test('continueOnFailure: false stops after the first failed stage', async () => {
  api.setProfiles([{ id: 'global', tag: [] }, { id: 'recon', tag: ['1'] }, { id: 'broken', tag: ['2'] }, { id: 'escalate', tag: ['3'] }]);
  try {
    const run = await finished((await runs.create({ prompt: 'p', globalProfile: 'global', fromTags: {}, continueOnFailure: false })).id, 120_000);
    assert.deepEqual(stagesOf(run), ['1:recon:succeeded', '2:broken:failed', '3:escalate:skipped']);
    assert.equal(run.stages[2].container, undefined, 'skipped stage must not start a container');
  } finally { api.reset(); }
});

test('cancel during stage 2: stage 2 cancelled, later stages never start', async () => {
  api.setProfiles([{ id: 'global', tag: [] }, { id: 'recon', tag: ['1'] }, { id: 'slow', tag: ['2'] }, { id: 'escalate', tag: ['3'] }]);
  try {
    const created = await runs.create({ prompt: 'p', globalProfile: 'global', fromTags: {} });
    for (let i = 0; i < 300 && !(await runs.get(created.id)).stages[1].threadId; i++) await sleep(100);
    assert.equal((await runs.get(created.id)).stages[1].status, 'running', 'stage 2 never got going');
    await runs.cancel(created.id);
    const run = await finished(created.id);
    assert.equal(run.status, 'cancelled');
    assert.deepEqual(stagesOf(run), ['1:recon:succeeded', '2:slow:cancelled', '3:escalate:cancelled']);
    assert.equal(run.stages[2].container, undefined, 'stage 3 must not start');
    assert.equal((await sh('docker', ['ps', '-a', '-q', '--filter', `name=${run.stages[1].container}`])).out, '');
  } finally { api.reset(); }
});

// ---- fallback model + follow-up prompts in runs (step 8) -------------------------

test('plan: follow-up prompts go to the stages with that tag, in order', async () => {
  const plan = await runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: { skip: ['4'] }, fallbackModel: 'good-model',
    reprompts: [{ stage: '2', prompt: 'second wave' }, { stage: '3', prompt: 'escalate more' }, { stage: '2', prompt: 'final wave' }] });
  assert.deepEqual(plan.stages.map((s) => `${s.profile}:${JSON.stringify(s.reprompts)}`),
    ['recon:[]', 'attack:["second wave","final wave"]', 'attack-b:["second wave","final wave"]', 'escalate:["escalate more"]']);
  assert.ok(plan.stages.every((s) => s.fallbackModel === 'good-model'));
  await rejects(runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: {}, reprompts: [{ stage: '5', prompt: 'x' }] }), 400, /stage 1 to 4/);
  await rejects(runs.plan({ prompt: 'p', globalProfile: 'global', fromTags: {}, reprompts: [{ stage: '2', prompt: ' ' }] }), 400, /non-empty prompt/);
  await rejects(runs.plan({ prompt: 'p', stages: [{ profile: 'attack' }], reprompts: [{ stage: '2', prompt: 'x' }] }), 400, /apply to tagged stages/);
  const explicit = await runs.plan({ prompt: 'p', stages: [{ profile: 'attack', reprompts: ['own follow-up'], fallbackModel: 'fb' }] });
  assert.deepEqual([explicit.stages[0].reprompts, explicit.stages[0].fallbackModel], [['own follow-up'], 'fb']);
});

test('Windmill-style run: per-tag model, fallback when it fails, follow-ups on the same thread', async () => {
  const created = await runs.create({
    prompt: 'Objective', globalProfile: 'global', fromTags: { skip: ['3', '4'] },
    modelOverrides: [{ stage: 2, model: 'bad-model' }], fallbackModel: 'good-model',
    reprompts: [{ stage: '1', prompt: 'recon again' }, { stage: '2', prompt: 'second wave' }],
  });
  const run = await finished(created.id, 120_000);
  assert.equal(run.status, 'succeeded', JSON.stringify(run.stages.map((s) => s.attempts)));
  const shape = run.stages.map((s) => `${s.profile}: ${s.attempts.map((a) => `${a.kind}(${a.model || '-'})=${a.status}`).join(' → ')}`);
  assert.deepEqual(shape, [
    'recon: initial(-)=succeeded → reprompt(-)=succeeded',
    'attack: initial(bad-model)=failed → fallback(good-model)=succeeded → reprompt(good-model)=succeeded',
    'attack-b: initial(bad-model)=failed → fallback(good-model)=succeeded → reprompt(good-model)=succeeded',
  ]);
  // attempts survive on disk too
  const saved = JSON.parse(await readFile(join(DATA, 'runs', run.id, 'run.json'), 'utf8'));
  assert.equal(saved.stages[1].attempts.length, 3);
  const events = (await runs.events(run.id, 1, { limit: 5000 })).events;
  assert.deepEqual(events.filter((e) => e.type === 'engine.attempt').map((e) => e.kind), ['initial', 'fallback', 'reprompt']);
});

// ---- HTTP API (what the CLI uses) ----------------------------------------------------

async function startServer(dir, port) {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: TEST_IMAGE, CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false)) return { child, output: () => output };
    await sleep(200);
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${output}`);
}

test('HTTP: same-machine protection (loopback Host, no Origin, JSON bodies)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cysu-engine-http-'));
  const port = 19000 + Math.floor(Math.random() * 500);
  const { child } = await startServer(dir, port);
  try {
    const base = `http://127.0.0.1:${port}`;
    const raw = (path, headers, method = 'GET', body) => new Promise((resolve) => {
      // fetch() cannot set Host, so use curl for the forged-Host case.
      const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', method];
      for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
      if (body) args.push('--data', body);
      execFile('curl', [...args, `${base}${path}`], (e, out) => resolve(Number(out)));
    });
    // /api/health is the one route without the engine token, so it shows the
    // same-machine checks on their own (they come before the token check).
    assert.equal(await raw('/api/health', {}), 200, 'CLI-style request (no Origin)');
    assert.equal(await raw('/api/health', { Host: 'evil.example:' + port }), 403, 'DNS rebinding Host');
    assert.equal(await raw('/api/health', { Host: `localhost:${port}` }), 200);
    assert.equal(await raw('/api/settings', { Origin: 'https://evil.example' }), 403, 'other website');
    assert.equal(await raw('/api/settings', { Origin: `http://127.0.0.1:${port}` }), 403, 'no web UI any more: any Origin is refused');
    assert.equal(await raw('/api/health', { Host: 'localhost:9999' }), 200, 'loopback on another port (container port mapping)');
    assert.equal(await raw('/api/health', { Host: '[::1]:8787' }), 200);
    assert.equal(await raw('/api/health', { Host: '127.0.0.1.evil.example' }), 403, 'look-alike name');
    assert.equal(await raw('/api/health', { Origin: 'https://evil.example' }), 403, 'health is same-machine only too');
    assert.equal(await raw('/api/runs', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'POST', 'a=b'), 403, 'HTML form post');
    assert.equal(await raw('/api/runs', { 'Content-Type': 'text/plain' }, 'POST', '{}'), 403, 'text/plain post');
  } finally {
    child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP: full run lifecycle, then crash + restart marks it interrupted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cysu-engine-http-'));
  const port = 19500 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const json = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method, headers: { ...AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }));
  let server = await startServer(dir, port);
  try {
    assert.equal((await json('/api/settings', 'PUT', { token: TOKEN, passkey: PASSKEY, llm: { mode: 'openai-api-key', apiKey: API_KEY } })).status, 200);

    let p = await json('/api/runs/plan', 'POST', { prompt: 'p', globalProfile: 'global', fromTags: { skip: ['4'] } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body.stages.map((s) => s.profile), ['recon', 'attack', 'attack-b', 'escalate']);
    p = await json('/api/runs/plan', 'POST', { prompt: 'p', globalProfile: 'nope', fromTags: {} });
    assert.equal(p.status, 400);
    assert.match(p.body.error, /Global profile nope/);
    assert.equal((await json('/api/runs')).body.length, 0, 'plan must not create runs');

    let r = await json('/api/runs', 'POST', { prompt: 'hello', stages: [{ profile: 'attack' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id;
    let run;
    for (let i = 0; i < 200; i++) {
      run = (await json(`/api/runs/${id}`)).body;
      if (!['queued', 'running'].includes(run.status)) break;
      await sleep(300);
    }
    assert.equal(run.status, 'succeeded');
    const events = (await json(`/api/runs/${id}/stages/0/events?after=0`)).body;
    assert.equal(events.events.length, 7);
    assert.equal(events.done, true);
    const log = await fetch(`${base}/api/runs/${id}/stages/0/log`, { headers: AUTH }).then((x) => x.text());
    assert.match(log, /LLM login: OpenAI API key/);
    assert.ok(!log.includes(API_KEY), 'API key in log');
    assert.equal((await json('/api/runs')).body[0].id, id);
    assert.equal((await json(`/api/runs/${id}/cancel`, 'POST')).status, 409);
    assert.equal((await json('/api/runs', 'POST', { prompt: 'x', stages: [] })).status, 400);
    assert.equal((await json(`/api/runs/${id}`, 'DELETE')).status, 204);
    assert.equal((await json(`/api/runs/${id}`)).status, 404);

    // A long run, then the engine is killed hard (crash).
    r = await json('/api/runs', 'POST', { prompt: 'SLEEP', stages: [{ profile: 'attack' }] });
    const longId = r.body.id;
    for (let i = 0; i < 100 && !(await json(`/api/runs/${longId}`)).body.stages[0].threadId; i++) await sleep(200);
    const container = (await json(`/api/runs/${longId}`)).body.stages[0].container;
    server.child.kill('SIGKILL');
    await sleep(500);
    assert.notEqual((await sh('docker', ['ps', '-q', '--filter', `name=${container}`])).out, '', 'container should outlive the crashed engine');

    server = await startServer(dir, port);
    run = (await json(`/api/runs/${longId}`)).body;
    assert.equal(run.status, 'interrupted');
    assert.equal(run.stages[0].status, 'interrupted');
    assert.equal((await sh('docker', ['ps', '-a', '-q', '--filter', `name=${container}`])).out, '', 'leftover container not removed at restart');
    assert.match(server.output(), /removed 1 leftover container/);
  } finally {
    server.child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP: run again, download (.tar.gz), saved setups, no web UI + security headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cysu-engine-http-'));
  const port = 20000 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const json = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method, headers: { ...AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, headers: r.headers, body: r.status === 204 ? null : await r.json().catch(() => null) }));
  const server = await startServer(dir, port);
  const waitDone = async (id) => {
    for (let i = 0; i < 300; i++) {
      const r = (await json(`/api/runs/${id}`)).body;
      if (!['queued', 'running'].includes(r.status)) return r;
      await sleep(300);
    }
    throw new Error('run did not finish');
  };
  try {
    await json('/api/settings', 'PUT', { token: TOKEN, passkey: PASSKEY, llm: { mode: 'openai-api-key', apiKey: API_KEY } });
    const request = { name: 'again', prompt: 'hello', globalProfile: 'global', fromTags: { skip: ['3', '4'] }, reprompts: [{ stage: '1', prompt: 'more' }] };
    const first = await waitDone((await json('/api/runs', 'POST', request)).body.id);
    assert.equal(first.status, 'succeeded');
    assert.deepEqual(first.request, request, 'the run remembers what was asked');

    // run again → a new run with the same request
    const again = await json(`/api/runs/${first.id}/rerun`, 'POST');
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.notEqual(again.body.id, first.id);
    assert.equal(again.body.rerunOf, first.id);
    const second = await waitDone(again.body.id);
    assert.deepEqual(second.stages.map((s) => `${s.profile}:${s.status}:${s.reprompts.length}`), first.stages.map((s) => `${s.profile}:succeeded:${s.reprompts.length}`));

    // download → a real tar.gz with run.json, events, logs and results
    const res = await fetch(`${base}/api/runs/${first.id}/download`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/gzip');
    assert.match(res.headers.get('content-disposition'), new RegExp(`run-${first.id}\\.tar\\.gz`));
    const archive = join(dir, 'x.tar.gz');
    await writeFile(archive, Buffer.from(await res.arrayBuffer()));
    const listing = await sh('tar', ['-tzf', archive]);
    assert.equal(listing.code, 0, listing.err);
    const names = listing.out.split('\n');
    for (const n of ['run.json', 'stages/0/events.jsonl', 'stages/0/log.txt', 'stages/0/result.md', 'stages/2/log.txt']) {
      assert.ok(names.includes(`run-${first.id}/${n}`), `missing ${n} in: ${names.join(', ')}`);
    }
    const extracted = await sh('tar', ['-xzf', archive, '-C', dir]);
    assert.equal(extracted.code, 0, extracted.err);
    assert.equal(JSON.parse(await readFile(join(dir, `run-${first.id}`, 'run.json'), 'utf8')).id, first.id);
    const all = (await sh('tar', ['-xzOf', archive])).out;
    assert.ok(!all.includes(TOKEN) && !all.includes(PASSKEY) && !all.includes(API_KEY), 'secret inside the download');

    // workspaces (basic HTTP, by exact id; the full /load, /run tests are in workspaces-api.test.js)
    const { name: _n, prompt: _p, ...setup } = request; // a workspace has no objective
    let r = await json('/api/workspaces', 'POST', { name: 'Weekly recon', request: setup });
    assert.equal(r.status, 201);
    const setupId = r.body.id;
    r = await json(`/api/workspaces/${encodeURIComponent('Weekly recon')}`, 'PATCH', { request: { ...setup, model: 'changed' } });
    assert.equal(r.status, 404, 'a name is not a reference');
    r = await json(`/api/workspaces/${setupId}`, 'PATCH', { request: { ...setup, model: 'changed' } });
    assert.equal(r.status, 200);
    let list = (await json('/api/workspaces')).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].request.model, 'changed');
    assert.equal((await json('/api/workspaces', 'POST', { name: 'x', request })).status, 400, 'an objective is refused');
    assert.equal((await json('/api/workspaces', 'POST', { name: '', request: setup })).status, 400);
    assert.equal((await json('/api/workspaces', 'POST', { name: 'x', request: 'nope' })).status, 400);
    assert.equal((await json(`/api/workspaces/${setupId}`, 'DELETE')).status, 204);
    assert.deepEqual((await json('/api/workspaces')).body, []);

    // No web UI any more: "/" only describes the API, other paths are 404,
    // and nothing the engine sends can be rendered or framed by a browser.
    const root = await fetch(`${base}/`, { headers: AUTH });
    assert.equal(root.headers.get('content-type'), 'application/json');
    assert.match((await root.json()).ui, /cysu CLI/);
    for (const path of ['/index.html', '/app.js', '/style.css', '/web/app.js']) {
      assert.equal((await fetch(`${base}${path}`, { headers: AUTH })).status, 404, `${path} should not be served`);
    }
    for (const path of ['/', '/api/status', `/api/runs/${first.id}/download`]) {
      const h = (await fetch(`${base}${path}`, { headers: AUTH })).headers;
      assert.equal(h.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'", path);
      assert.equal(h.get('x-content-type-options'), 'nosniff');
      assert.equal(h.get('x-frame-options'), 'DENY');
    }
  } finally {
    server.child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
