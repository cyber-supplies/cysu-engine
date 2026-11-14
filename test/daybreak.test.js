import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daybreakHint } from '../server/daybreak.js';

// Real messages from engine runs on 2026-11-08 (ChatGPT login).
const CHATGPT_CYBER = "The 'gpt-5.6-cyber' model is not supported when using Codex with a ChatGPT account.";
const NO_ACCESS = JSON.stringify({ type: 'error', status: 400, error: {
  message: 'You do not have Daybreak access. If you’re doing authorized security work, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying.',
  type: 'invalid_request_error', param: 'access_programs.cyber', code: 'invalid_access_program' } });

test('cyber model on a ChatGPT login: needs a Red-approved API key, or blue with a regular model', () => {
  const hint = daybreakHint(CHATGPT_CYBER, { daybreak: 'red', model: 'gpt-5.6-cyber' });
  assert.match(hint, /"gpt-5\.6-cyber" cannot be used with a ChatGPT login/);
  assert.match(hint, /API key from a Daybreak Red–approved project/);
  assert.match(hint, /daybreak "blue"/);
  assert.match(daybreakHint(CHATGPT_CYBER), /cyber models need an OpenAI API key/, 'no context: still recognised from the text');
  assert.doesNotMatch(daybreakHint("The 'o9' model is not supported when using Codex with a ChatGPT account.", { model: 'o9' }), /cyber/);
});

test('"no Daybreak access" on red with a regular model: explains it, points to blue', () => {
  for (const model of ['', 'gpt-6']) {
    const hint = daybreakHint(NO_ACCESS, { daybreak: 'red', model });
    assert.match(hint, /also appears for approved accounts/);
    assert.match(hint, /use daybreak "blue" instead/);
    assert.match(hint, model ? /"gpt-6" is not a cyber model/ : /the default model is not a cyber model/);
  }
  assert.match(daybreakHint(NO_ACCESS, { daybreak: 'red', model: 'gpt-5.6-cyber' }), /API key belongs to that project/);
});

test('"no Daybreak access" on blue: the account itself lacks access', () => {
  const hint = daybreakHint(NO_ACCESS, { daybreak: 'blue' });
  assert.match(hint, /no Daybreak Blue access/);
  assert.match(hint, /status-and-access/);
  assert.match(hint, /"standard"/);
});

test('documented codes, in JSON or plain text', () => {
  const body = (code) => JSON.stringify({ error: { code, message: 'x' }, status: 403 });
  assert.match(daybreakHint(body('access_program_not_enabled'), { daybreak: 'red' }), /not enabled for the Daybreak program requested \("red"\)/);
  assert.match(daybreakHint('403 access_program_not_enabled'), /not enabled for the Daybreak program requested\./);
  assert.match(daybreakHint(body('unsupported_access_program'), { daybreak: 'blue' }), /does not support the Daybreak program requested \("blue"\)/);
});

test('anything else gets no hint', () => {
  for (const message of ['', undefined, 'rate limit reached', '{"error":{"code":"insufficient_quota"}}', 'Model metadata for `gpt-5.6-cyber` not found.']) {
    assert.equal(daybreakHint(message, { daybreak: 'red' }), null, String(message));
  }
});

// ---- access check: result mapping (no container) ----------------------------
import { checkDaybreak, CHECK_PROGRAMS } from '../server/daybreak.js';

const fakeRun = (lines, refreshed = null) => async ({ job }) => {
  fakeRun.job = job;
  return { lines: lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))), refreshedCodexAuth: refreshed };
};

test('check: one result per program, failures carry OpenAI\'s error and plain advice', async () => {
  const r = await checkDaybreak({ settings: {}, model: '', run: fakeRun([
    'not json', { type: 'engine.attempt' },
    { type: 'engine.daybreak.check', program: 'standard', ok: true, exitCode: 0, error: '' },
    { type: 'engine.daybreak.check', program: 'blue', ok: true, exitCode: 0, error: '' },
    { type: 'engine.daybreak.check', program: 'red', ok: false, exitCode: 1, error: NO_ACCESS },
  ], { tokens: { refresh_token: 'new' } }) });
  assert.deepEqual(fakeRun.job, { programs: CHECK_PROGRAMS, model: '' });
  assert.equal(r.model, 'default');
  assert.deepEqual(r.results.map((x) => `${x.program}:${x.ok}`), ['standard:true', 'blue:true', 'red:false']);
  assert.match(r.results[2].hint, /use daybreak "blue" instead \(the default model is not a cyber model\)/);
  assert.equal(r.results[0].hint, null);
  assert.deepEqual(r.refreshedCodexAuth, { tokens: { refresh_token: 'new' } });
  assert.ok(!JSON.stringify(r).includes('refresh_token'), 'the refreshed login is never serialized with the result');
});

test('check: a program the container never reported counts as failed; bad model names are refused', async () => {
  const r = await checkDaybreak({ settings: {}, model: 'gpt-5.6-cyber', run: fakeRun([{ type: 'engine.daybreak.check', program: 'standard', ok: true }]) });
  assert.equal(r.model, 'gpt-5.6-cyber');
  assert.deepEqual(r.results.map((x) => `${x.program}:${x.ok}`), ['standard:true', 'blue:false', 'red:false']);
  assert.match(r.results[1].error, /did not finish/);
  await assert.rejects(checkDaybreak({ settings: {}, model: 'bad model; rm -rf /', run: fakeRun([]) }), (e) => e.status === 400);
});
