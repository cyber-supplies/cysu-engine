// One stage end to end: real cysu CLI installs profiles from a stand-in
// Cyber Supplies API; a stand-in `codex exec` reports what it saw (no LLM).
// Needs Docker + both images (npm run image:build && npm run image:build:test).
// The fake API listens on the host, so these containers run with the firewall
// off (CYSU_EGRESS_GUARD=0); the firewall itself is covered by hardening.test.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { startFakeApi } from './fixtures/fake-api.js';
import { startStage, cancelStage, validateStage } from '../server/stage.js';

const TEST_IMAGE = 'cysu-engine-workspace:test';
const TOKEN = 'stage-test-token-7f3a';
const settings = { token: TOKEN, passkey: 'stage-test-passkey', llm: { mode: 'none' } };

let api;
before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
});
after(() => api?.server.close());

const run = (stage) => startStage({
  stage, settings, image: TEST_IMAGE,
  extraEnv: { CYSU_API_URL: api.url, CYSU_EGRESS_GUARD: '0' },
});
const report = (r) => JSON.parse(r.result);

test('stage definitions are validated before anything starts', () => {
  for (const [input, message] of [
    [{ prompt: 'x' }, /stage profile/],
    [{ profile: 'a b', prompt: 'x' }, /stage profile/],
    [{ profile: 'attack', prompt: '   ' }, /An objective is required/],
    [{ profile: 'attack', globalProfile: 'attack', prompt: 'x' }, /cannot be the global/],
    [{ profile: 'attack', prompt: 'x', model: 'gpt 5' }, /model/],
    [{ profile: 'attack', prompt: 'x', model: 'x"; rm -rf /' }, /model/],
    [{ profile: 'attack', prompt: 'x', reasoningEffort: 'turbo' }, /effort/],
  ]) assert.throws(() => validateStage(input), message);
  for (const [input, message] of [
    [{ profile: 'attack', prompt: 'x', fallbackModel: 'no spaces allowed' }, /fallback model/],
    [{ profile: 'attack', prompt: 'x', reprompts: 'second wave' }, /Follow-up prompts must be a list/],
    [{ profile: 'attack', prompt: 'x', reprompts: ['ok', '  '] }, /Follow-up prompts must be a list of non-empty/],
    [{ profile: 'attack', prompt: 'x', reprompts: Array(21).fill('again') }, /At most 20 follow-up/],
    [{ profile: 'attack', prompt: 'x', daybreak: 'daybreak_red' }, /daybreak must be one of default, standard, blue, red/],
  ]) assert.throws(() => validateStage(input), message);
  assert.deepEqual(validateStage({ profile: 'attack', prompt: 'go' }),
    { profile: 'attack', globalProfile: '', prompt: 'go', model: '', reasoningEffort: '', fallbackModel: '', reprompts: [], daybreak: 'default' });
});

test('full stage: installs global + stage profile, Codex sees both, run record filled in', async () => {
  const r = await run({ profile: 'attack', globalProfile: 'global', prompt: 'Map the target', model: 'gpt-test', reasoningEffort: 'high' }).done;
  assert.equal(r.status, 'succeeded', r.log);
  assert.equal(r.exitCode, 0);
  assert.equal(r.threadId, 'fake-thread-0001');
  assert.equal(r.turns, 1);
  assert.equal(r.usage.input_tokens, 111);

  const seen = report(r);
  assert.equal(seen.prompt, 'Map the target');
  assert.equal(seen.user, 'runner');
  assert.equal(seen.cwd, '/workspace');
  assert.match(seen.args, /--json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C \/workspace --model gpt-test -c model_reasoning_effort="high" -$/);
  assert.match(seen.globalAgents, /GLOBAL-PROMPT-MARKER/);
  assert.match(seen.workspaceAgents, /STAGE-PROMPT-MARKER/);
  assert.match(seen.mcp, /stagemcp\s+echo\s+hello.*enabled/, 'stage profile MCP server not loaded by Codex');
  assert.match(seen.files, /\/home\/runner\/\.agents\/skills\/house-rules\/SKILL\.md/);
  assert.match(seen.files, /\/workspace\/\.agents\/skills\/attack-playbook\/SKILL\.md/);

  assert.deepEqual(api.requests.slice(-2).map((q) => `${q.method} ${q.url} ${q.auth}`),
    [`GET /api/profiles/global Bearer ${TOKEN}`, `GET /api/profiles/attack Bearer ${TOKEN}`]);
  assert.ok(r.events.every((e) => typeof e.type === 'string'), 'non-Codex output leaked into the event stream');
  assert.match(r.log, /installing global profile: global/);
  assert.match(r.log, /installing stage profile: attack/);
  assert.ok(!JSON.stringify(r.events).includes(TOKEN) && !r.log.includes(TOKEN), 'token leaked into events/log');
  assert.ok(!r.log.includes('stage-test-passkey'), 'passkey leaked into log');
});

test('without a global profile only the stage profile is installed', async () => {
  const r = await run({ profile: 'attack', prompt: 'go' }).done;
  assert.equal(r.status, 'succeeded', r.log);
  const seen = report(r);
  assert.equal(seen.globalAgents, '');
  assert.match(seen.workspaceAgents, /STAGE-PROMPT-MARKER/);
  assert.match(seen.args, /-C \/workspace -$/, 'model/effort flags should be absent');
});

test('long prompts arrive intact (stdin, not argv)', async () => {
  const prompt = `start ${'x'.repeat(60_000)} "quotes" $HOME \`ticks\` end`;
  const r = await run({ profile: 'attack', prompt }).done;
  assert.equal(r.status, 'succeeded', r.log);
  assert.equal(report(r).prompt, prompt);
});

test('unknown profile: stage fails at install (exit 5) with a clear log line', async () => {
  const r = await run({ profile: 'does-not-exist', prompt: 'go' }).done;
  assert.equal(r.status, 'failed');
  assert.equal(r.exitCode, 5);
  assert.match(r.log, /stage failed: could not install stage profile does-not-exist/);
  assert.equal(r.events.length, 0, 'Codex should not have started');
});

test('missing global profile fails before the stage profile is touched', async () => {
  const r = await run({ profile: 'attack', globalProfile: 'nope', prompt: 'go' }).done;
  assert.equal(r.status, 'failed');
  assert.match(r.log, /could not install global profile nope/);
  assert.doesNotMatch(r.log, /installing stage profile/);
});

test('a failed Codex turn marks the stage failed and keeps the error', async () => {
  const r = await run({ profile: 'attack', prompt: 'please FAIL-TURN' }).done;
  assert.equal(r.status, 'failed');
  assert.equal(r.agentError, true);
  assert.deepEqual(r.errors, ['fake failure requested']);
  assert.equal(r.threadId, 'fake-thread-0001');
});

test('cancel stops a running stage and removes its container', async () => {
  const live = run({ profile: 'attack', prompt: 'SLEEP please' });
  for (let i = 0; i < 100 && !live.threadId; i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(live.threadId, 'fake-thread-0001', 'stage never started Codex');
  const started = Date.now();
  await cancelStage(live);
  const r = await live.done;
  assert.equal(r.status, 'cancelled');
  assert.ok(Date.now() - started < 15_000, 'cancel took too long');
  const left = await new Promise((resolve) => execFile('docker', ['ps', '-a', '-q', '--filter', `name=${live.container}`], (e, out) => resolve(out.trim())));
  assert.equal(left, '', 'stage container still exists');
});

// ---- attempts: fallback model and follow-up prompts (step 8) ----------------------

const kinds = (r) => r.attempts.map((a) => `${a.kind}:${a.model || '-'}:${a.status}`);
const messages = (r) => r.events.filter((e) => e.item?.type === 'agent_message').map((e) => JSON.parse(e.item.text));

test('fallback model: a failed first attempt is retried once, in the SAME workspace', async () => {
  const r = await run({ profile: 'attack', prompt: 'go', model: 'bad-model', fallbackModel: 'good-model' }).done;
  assert.equal(r.status, 'succeeded', r.log);
  assert.deepEqual(kinds(r), ['initial:bad-model:failed', 'fallback:good-model:succeeded']);
  assert.equal(r.attempts[0].exitCode, 1);
  assert.match(r.log, /first attempt failed \(exit 1\); retrying once with fallback model good-model/);
  const [report] = messages(r);
  assert.equal(report.model, 'good-model');
  assert.match(report.earlierAttempts, /bad-model/, 'fallback did not see the first attempt\'s workspace');
  assert.deepEqual(r.errors, ['model bad-model is not available'], 'the first failure is kept for the record');
});

test('fallback model: if it fails too, the stage fails (no third try)', async () => {
  const r = await run({ profile: 'attack', prompt: 'go', model: 'bad-model', fallbackModel: 'bad-model' }).done;
  assert.equal(r.status, 'failed');
  assert.deepEqual(kinds(r), ['initial:bad-model:failed', 'fallback:bad-model:failed']);
  assert.match(r.log, /fallback attempt failed/);
});

test('no fallback model: a failed first attempt fails the stage', async () => {
  const r = await run({ profile: 'attack', prompt: 'go', model: 'bad-model' }).done;
  assert.equal(r.status, 'failed');
  assert.deepEqual(kinds(r), ['initial:bad-model:failed']);
});

test('follow-up prompts: sent in order, each resuming the same Codex thread', async () => {
  const r = await run({ profile: 'attack', prompt: 'first wave', model: 'gpt-test', reprompts: ['second wave', 'final wave'] }).done;
  assert.equal(r.status, 'succeeded', r.log);
  assert.deepEqual(kinds(r), ['initial:gpt-test:succeeded', 'reprompt:gpt-test:succeeded', 'reprompt:gpt-test:succeeded']);
  const [first, second, third] = messages(r);
  assert.equal(first.prompt, 'first wave');
  assert.deepEqual([second.resumed, second.thread, second.prompt], [true, 'fake-thread-0001', 'second wave']);
  assert.deepEqual([third.resumed, third.thread, third.prompt], [true, 'fake-thread-0001', 'final wave']);
  assert.match(second.args, /^--json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --model gpt-test fake-thread-0001 -$/);
  assert.equal(r.turns, 3);
  assert.equal(r.threadId, 'fake-thread-0001');
  assert.match(r.log, /follow-up prompt 2\/2 \(resuming thread fake-thread-0001\)/);
});

test('follow-up prompts continue with the fallback model when the fallback was needed', async () => {
  const r = await run({ profile: 'attack', prompt: 'go', model: 'bad-model', fallbackModel: 'good-model', reprompts: ['more'] }).done;
  assert.equal(r.status, 'succeeded', r.log);
  assert.deepEqual(kinds(r), ['initial:bad-model:failed', 'fallback:good-model:succeeded', 'reprompt:good-model:succeeded']);
});

test('a failed follow-up fails the stage; later follow-ups are not sent', async () => {
  const r = await run({ profile: 'attack', prompt: 'go', reprompts: ['fine', 'please FAIL-TURN', 'never sent'] }).done;
  assert.equal(r.status, 'failed');
  assert.deepEqual(kinds(r), ['initial:-:succeeded', 'reprompt:-:succeeded', 'reprompt:-:failed']);
  assert.ok(!JSON.stringify(r.events).includes('never sent'));
  assert.match(r.log, /follow-up prompt 2 failed/);
});

test('follow-ups are not sent when the first attempt fails', async () => {
  const r = await run({ profile: 'attack', prompt: 'FAIL-TURN', reprompts: ['more'] }).done;
  assert.equal(r.status, 'failed');
  assert.deepEqual(kinds(r), ['initial:-:failed']);
});

test('cancel: no fallback attempt after a cancelled one', async () => {
  const live = run({ profile: 'attack', prompt: 'SLEEP', fallbackModel: 'good-model' });
  for (let i = 0; i < 100 && !live.threadId; i++) await new Promise((r) => setTimeout(r, 200));
  await cancelStage(live);
  const r = await live.done;
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(r.attempts.map((a) => a.kind), ['initial']);
  assert.doesNotMatch(r.log, /retrying once with fallback/);
});

// ---- the built-in cysu skill survives a global profile install (option a) ---------

test('cysu skill: added back when the global profile replaced the skill folders', async () => {
  const r = await run({ profile: 'attack', globalProfile: 'global', prompt: 'go' }).done;
  assert.equal(r.status, 'succeeded', r.log);
  const seen = JSON.parse(r.result);
  assert.match(seen.files, /\/home\/runner\/\.agents\/skills\/cysu\/SKILL\.md/, 'built-in cysu skill missing');
  assert.match(seen.files, /\/home\/runner\/\.agents\/skills\/house-rules\/SKILL\.md/, 'the profile\'s own skills must stay');
  assert.match(r.log, /cysu skill: added the built-in one/);
  assert.match(seen.cysuSkill, /^name: cysu$/m);
  assert.doesNotMatch(seen.cysuSkill, /PROFILE-OWN-CYSU-SKILL/);
});

test('cysu skill: without a global profile the built-in one is simply kept', async () => {
  const r = await run({ profile: 'attack', prompt: 'go' }).done;
  assert.match(JSON.parse(r.result).files, /\/home\/runner\/\.agents\/skills\/cysu\/SKILL\.md/);
  assert.match(r.log, /cysu skill: provided by the installed profiles/);
});

test('cysu skill: a profile that ships its own cysu skill is not overwritten', async () => {
  api.setProfiles([{ id: 'global-cysu', tag: [] }, { id: 'attack', tag: ['2'] }]);
  try {
    const r = await run({ profile: 'attack', globalProfile: 'global-cysu', prompt: 'go' }).done;
    assert.equal(r.status, 'succeeded', r.log);
    assert.match(r.log, /cysu skill: provided by the installed profiles/);
    assert.match(JSON.parse(r.result).cysuSkill, /PROFILE-OWN-CYSU-SKILL/, 'the profile\'s own cysu skill was replaced');
  } finally { api.reset(); }
});


test('Daybreak: every attempt (initial, fallback, follow-ups) asks Codex for the access program', async () => {
  const r = await run({ profile: 'attack', prompt: 'go', model: 'bad-model', fallbackModel: 'gpt-5.6-cyber', daybreak: 'red', reprompts: ['more'] }).done;
  assert.equal(r.status, 'succeeded', r.log);
  assert.deepEqual(r.attempts.map((a) => `${a.kind}:${a.daybreak}`), ['initial:red', 'fallback:red', 'reprompt:red']);
  const [fallback, followUp] = messages(r);
  assert.match(fallback.args, /--model gpt-5\.6-cyber --cyber-access-program daybreak_red -$/);
  assert.match(followUp.args, /--model gpt-5\.6-cyber --cyber-access-program daybreak_red fake-thread-\d+ -$/);
  assert.match(r.log, /running Codex \(model bad-model\) \(Daybreak: daybreak_red\)/);
  assert.equal(r.stage.daybreak, 'red');

  for (const [daybreak, flag] of [['blue', / --cyber-access-program daybreak_blue -$/], ['standard', / --cyber-access-program standard -$/], ['default', /-C \/workspace -$/]]) {
    const one = await run({ profile: 'attack', prompt: 'go', daybreak }).done;
    assert.equal(one.status, 'succeeded', one.log);
    assert.match(report(one).args, flag, daybreak);
    assert.equal(one.attempts[0].daybreak, daybreak);
  }
});

test('Daybreak access error: the stage gets plain advice in hints (once), next to the raw error', async () => {
  const r = await run({ profile: 'attack', prompt: 'go', model: 'daybreak-denied', daybreak: 'red' }).done;
  assert.equal(r.status, 'failed');
  assert.ok(r.errors.some((e) => /You do not have Daybreak access/.test(e)), 'raw OpenAI error kept');
  assert.equal(r.hints.length, 1, 'error + turn.failed carry the same message: one hint');
  assert.match(r.hints[0], /also appears for approved accounts/);
  assert.match(r.hints[0], /"daybreak-denied" is not a cyber model/);

  const ok = await run({ profile: 'attack', prompt: 'go', daybreak: 'red' }).done;
  assert.deepEqual(ok.hints, [], 'no hint without an error');
  const other = await run({ profile: 'attack', prompt: 'go FAIL-TURN', daybreak: 'red' }).done;
  assert.deepEqual(other.hints, [], 'no hint for unrelated errors');
});

test('Daybreak access check: the real worker asks Codex once per program and reports each', async () => {
  const { checkDaybreak } = await import('../server/daybreak.js');
  const r = await checkDaybreak({ settings, image: TEST_IMAGE });
  assert.deepEqual(r.results.map((x) => `${x.program}:${x.ok}`), ['standard:true', 'blue:true', 'red:false']);
  assert.match(r.results[2].error, /You do not have Daybreak access/);
  assert.match(r.results[2].hint, /Red only works with the cyber models/);
  const cyber = await checkDaybreak({ settings, image: TEST_IMAGE, model: 'gpt-5.6-cyber' });
  assert.ok(cyber.results.every((x) => x.ok), JSON.stringify(cyber.results));
});
