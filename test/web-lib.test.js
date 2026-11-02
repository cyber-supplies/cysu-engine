// Web UI display logic (web/lib.js) and a guard against HTML injection in the
// UI code. No Docker, no browser. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fmtDuration, elapsed, groupByDay, statusInfo, runTitle, tokens, timeline, activity, buildRequest, formFromRequest, stageTag, RUN_FILTERS } from '../web/lib.js';

test('durations read like Windmill (2h 21m 42s, 8m 5s, 42s, 0.3s)', () => {
  assert.equal(fmtDuration(8_502_000), '2h 21m 42s');
  assert.equal(fmtDuration(485_000), '8m 5s');
  assert.equal(fmtDuration(42_000), '42s');
  assert.equal(fmtDuration(300), '0.3s');
  assert.equal(fmtDuration(null), '—');
  assert.equal(elapsed({ startedAt: '2026-11-02T10:00:00Z', finishedAt: '2026-11-02T10:01:30Z' }), 90_000);
  assert.equal(elapsed({ startedAt: '2026-11-02T10:00:00Z' }, Date.parse('2026-11-02T10:00:10Z')), 10_000, 'running: until now');
  assert.equal(elapsed({}), null);
});

test('runs are grouped by day, newest first; filters; titles', () => {
  const runs = [
    { id: 'c', status: 'running', createdAt: '2026-11-02T15:00:00', stages: [{ profile: 'recon', tag: '1' }, { profile: 'attack', tag: '2' }] },
    { id: 'b', status: 'failed', createdAt: '2026-11-02T09:00:00', stages: [] },
    { id: 'a', status: 'cancelled', createdAt: '2026-11-01T22:00:00', name: 'Named run', stages: [] },
  ];
  const groups = groupByDay(runs);
  assert.deepEqual(groups.map((g) => [g.day, g.runs.map((r) => r.id)]), [['2 November 2026', ['c', 'b']], ['1 November 2026', ['a']]]);
  assert.deepEqual(runs.filter(RUN_FILTERS.active).map((r) => r.id), ['c']);
  assert.deepEqual(runs.filter(RUN_FILTERS.stopped).map((r) => r.id), ['a']);
  assert.equal(runTitle(runs[0]), '1:recon → 2:attack');
  assert.equal(runTitle(runs[2]), 'Named run');
  assert.equal(statusInfo('succeeded').tone, 'ok');
  assert.equal(statusInfo('weird').label, 'weird');
  assert.equal(tokens({ input_tokens: 123_456, output_tokens: 1_500 }), '123k in · 1.5k out');
});

test('timeline bars are placed relative to the whole run', () => {
  const run = {
    startedAt: '2026-11-02T10:00:00Z', finishedAt: '2026-11-02T10:10:00Z',
    stages: [
      { startedAt: '2026-11-02T10:00:00Z', finishedAt: '2026-11-02T10:05:00Z' },
      { startedAt: '2026-11-02T10:05:00Z', finishedAt: '2026-11-02T10:10:00Z' },
      { status: 'skipped' },
    ],
  };
  assert.deepEqual(timeline(run), [{ left: 0, width: 50 }, { left: 50, width: 50 }, null]);
});

test('activity: attempts, merged items per attempt, follow-up numbering, errors', () => {
  const ev = (type, extra = {}) => ({ type, time: 't', ...extra });
  const items = activity([
    ev('engine.attempt', { kind: 'initial', model: 'bad-model' }),
    ev('thread.started', { thread_id: 'x' }),
    ev('item.started', { item: { id: 'item_0', type: 'command_execution', command: 'nmap -h', status: 'in_progress' } }),
    ev('item.completed', { item: { id: 'item_0', type: 'command_execution', command: 'nmap -h', exit_code: 0, aggregated_output: 'usage' } }),
    ev('turn.failed', { error: { message: 'model bad-model is not available' } }),
    ev('engine.attempt.finished', { kind: 'initial', exitCode: 1 }),
    ev('engine.attempt', { kind: 'fallback', model: 'good' }),
    ev('item.completed', { item: { id: 'item_0', type: 'agent_message', text: 'done' } }), // same id, new attempt
    ev('turn.completed', { usage: { input_tokens: 10, output_tokens: 2 } }),
    ev('engine.attempt.finished', { kind: 'fallback', exitCode: 0 }),
    ev('engine.attempt', { kind: 'reprompt', model: 'good' }),
    ev('item.completed', { item: { id: 'item_1', type: 'file_change', changes: [{ path: 'notes.md', kind: 'add' }] } }),
    ev('engine.attempt', { kind: 'reprompt', model: 'good' }),
  ]);
  assert.deepEqual(items.map((i) => `${i.kind}: ${i.text}`), [
    'attempt: First attempt · model bad-model',
    'command: nmap -h',
    'error: model bad-model is not available',
    'error: Attempt ended with exit code 1',
    'attempt: Fallback attempt · model good',
    'message: done',
    'turn: Turn finished · 10 in · 2 out',
    'attempt: Follow-up prompt 1 · model good',
    'file: add notes.md',
    'attempt: Follow-up prompt 2 · model good',
  ]);
  const command = items[1];
  assert.deepEqual([command.exitCode, command.output, command.running], [0, 'usage', false], 'started + completed merged');
});

test('activity keeps agent text exactly as text (it is never parsed as HTML)', () => {
  const evil = '<img src=x onerror="fetch(\'/api/runs\',{method:\'POST\'})"><script>alert(1)</script>';
  const [item] = activity([{ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: evil } }]);
  assert.equal(item.text, evil);
});

test('run requests: form → request → form round-trips', () => {
  const tagsForm = {
    name: ' recon ', prompt: 'Objective', globalProfile: 'global', mode: 'tags', skip: ['4', '1'], picked: [],
    model: 'm', fallbackModel: ' fb ', reasoningEffort: 'high', overrides: { 2: 'm2', 3: '' },
    reprompts: [{ stage: '2', prompt: 'second wave' }, { stage: '3', prompt: '  ' }], continueOnFailure: false,
  };
  const req = buildRequest(tagsForm);
  assert.deepEqual(req, {
    name: 'recon', prompt: 'Objective', globalProfile: 'global', fromTags: { skip: ['1', '4'] },
    model: 'm', fallbackModel: 'fb', reasoningEffort: 'high', modelOverrides: [{ stage: 2, model: 'm2' }],
    reprompts: [{ stage: '2', prompt: 'second wave' }], continueOnFailure: false,
  });
  const back = formFromRequest(req);
  assert.equal(back.mode, 'tags');
  assert.deepEqual(back.skip, ['1', '4']);
  assert.deepEqual(back.overrides, { 2: 'm2' });
  assert.equal(back.continueOnFailure, false);
  assert.deepEqual(buildRequest(back), req);

  const pick = buildRequest({ prompt: 'p', mode: 'pick', picked: [{ profile: 'attack', tag: '2' }, { profile: 'misc', tag: '' }], continueOnFailure: true });
  assert.deepEqual(pick, { prompt: 'p', globalProfile: '', stages: [{ profile: 'attack', tag: '2' }, { profile: 'misc' }] });
  assert.equal(formFromRequest(pick).mode, 'pick');
  assert.equal(stageTag({ tag: ['3'] }), '3');
  assert.equal(stageTag({ tag: ['3', '4'] }), '');
});

test('UI code never builds HTML from strings (agent output must stay text)', async () => {
  const files = ['app.js', 'dom.js', 'lib.js', ...(await readdir(new URL('../web/views/', import.meta.url))).map((f) => `views/${f}`)];
  for (const file of files) {
    const code = await readFile(new URL(`../web/${file}`, import.meta.url), 'utf8');
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      assert.ok(!code.includes(sink), `${file} uses ${sink}`);
    }
    // `list.length && h(...)` renders a stray "0" for empty lists; compare with > 0.
    assert.doesNotMatch(code, /\.(length|size) &&/, `${file}: use "length > 0 &&" so an empty list does not print 0`);
  }
});
