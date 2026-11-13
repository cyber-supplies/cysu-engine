// run-view.test.js: the API's run JSON shows each fact once and leaves out
// empty and default values; the stored run keeps everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runListItem, runDetail } from '../server/run-view.js';

const OBJECTIVE = 'Map example.com (authorized).';

// A stored run as run.json holds it (shape of engine 0.3.2).
const stored = (over = {}) => ({
  id: 'a1804ec5-eb5a-4c6a-96c5-17c7465dbf8b', status: 'succeeded',
  createdAt: '2026-11-08T14:26:08.839Z', startedAt: '2026-11-08T14:26:08.840Z', finishedAt: '2026-11-08T14:26:14.910Z',
  cancelRequested: false, name: 'Recon', prompt: OBJECTIVE, globalProfile: '', model: '', reasoningEffort: '', fallbackModel: '',
  daybreak: 'blue', objective: OBJECTIVE, source: 'explicit', skip: [], modelOverrides: [], daybreakOverrides: [], reprompts: [],
  continueOnFailure: true, engineLinked: false,
  stages: [{
    index: 0, tag: '', profile: 'recon', globalProfile: '', prompt: OBJECTIVE, model: '', reasoningEffort: '', fallbackModel: '',
    reprompts: [], daybreak: 'blue', status: 'succeeded', startedAt: '2026-11-08T14:26:08.842Z', finishedAt: '2026-11-08T14:26:14.910Z',
    exitCode: 0, threadId: 'thread-1', turns: 1,
    usage: { input_tokens: 13382, cached_input_tokens: 10880, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 },
    result: 'done', errors: [], hints: [], agentToken: 'llm', engineLinked: false,
    attempts: [{ kind: 'initial', model: '', daybreak: 'blue', startedAt: '2026-11-08T14:26:10.017Z', finishedAt: '2026-11-08T14:26:14.719Z', exitCode: 0, turns: 1, status: 'succeeded' }],
    eventCount: 6, container: 'cysu-stage-37bfc842',
  }],
  request: { name: 'Recon', objective: OBJECTIVE, stages: [{ profile: 'recon' }], daybreak: 'blue' },
  rerunOf: null, workspace: { id: 'ws-1', name: 'Recon' }, trigger: 'user', schedule: null,
  ...over,
});

test('detail: each fact once, nothing empty, nothing internal', () => {
  assert.deepEqual(runDetail(stored()), {
    id: 'a1804ec5-eb5a-4c6a-96c5-17c7465dbf8b', name: 'Recon', status: 'succeeded',
    trigger: { type: 'user' }, workspace: { id: 'ws-1', name: 'Recon' },
    startedAt: '2026-11-08T14:26:08.840Z', finishedAt: '2026-11-08T14:26:14.910Z',
    objective: OBJECTIVE,
    stages: [{
      index: 0, profile: 'recon', status: 'succeeded', daybreak: 'blue',
      startedAt: '2026-11-08T14:26:08.842Z', finishedAt: '2026-11-08T14:26:14.910Z', durationSec: 6, exitCode: 0,
      result: 'done', threadId: 'thread-1', usage: { input_tokens: 13382, cached_input_tokens: 10880, output_tokens: 10 },
      eventCount: 6,
    }],
  });
  assert.equal(JSON.stringify(runDetail(stored())).split(OBJECTIVE).length - 1, 1, 'the objective appears once');
});

test('list: summary and one short line per stage', () => {
  assert.deepEqual(runListItem(stored()), {
    id: 'a1804ec5-eb5a-4c6a-96c5-17c7465dbf8b', name: 'Recon', status: 'succeeded',
    trigger: { type: 'user' }, workspace: { id: 'ws-1', name: 'Recon' },
    startedAt: '2026-11-08T14:26:08.840Z', finishedAt: '2026-11-08T14:26:14.910Z',
    stages: [{ index: 0, profile: 'recon', status: 'succeeded' }],
  });
});

test('a failed stage says why, in one line, in the list too', () => {
  const run = stored({ status: 'failed' });
  Object.assign(run.stages[0], { status: 'failed', exitCode: 1, turns: 0, usage: null, result: '',
    errors: ['unexpected status 504 Gateway Timeout', 'unexpected status 504 Gateway Timeout'] });
  assert.deepEqual(runListItem(run).stages[0], { index: 0, profile: 'recon', status: 'failed', error: 'unexpected status 504 Gateway Timeout' });
  const stage = runDetail(run).stages[0];
  assert.equal(stage.error, 'unexpected status 504 Gateway Timeout');
  assert.equal(stage.threadId, undefined, 'no finished turn: no thread or usage');
  assert.equal(stage.usage, undefined);
  const noMessage = stored({ status: 'failed' });
  Object.assign(noMessage.stages[0], { status: 'failed', exitCode: 5 });
  assert.equal(runDetail(noMessage).stages[0].error, 'Exited with code 5');
  const interrupted = stored({ status: 'interrupted' });
  Object.assign(interrupted.stages[0], { status: 'interrupted', exitCode: null });
  assert.match(runDetail(interrupted).stages[0].error, /engine stopped/);
});

test('a stage shows its model / settings only where they differ from the run', () => {
  const run = stored({ model: 'gpt-a', reasoningEffort: 'high', continueOnFailure: false, engineLinked: true, globalProfile: 'global' });
  run.stages.push({ ...structuredClone(run.stages[0]), index: 1, profile: 'attack', model: 'gpt-b', daybreak: 'default',
    reprompts: ['now write it up'], agentToken: 'user', engineLinked: true,
    attempts: [{ kind: 'initial', model: 'gpt-b', status: 'failed', startedAt: '2026-11-08T14:26:10Z', finishedAt: '2026-11-08T14:26:12Z' },
      { kind: 'fallback', model: '', status: 'succeeded', startedAt: '2026-11-08T14:26:12Z', finishedAt: '2026-11-08T14:26:15Z' }] });
  run.stages[0].model = 'gpt-a';
  run.stages[0].reasoningEffort = 'high';
  const d = runDetail(run);
  assert.equal(d.model, 'gpt-a');
  assert.equal(d.reasoningEffort, 'high');
  assert.equal(d.continueOnFailure, false);
  assert.equal(d.engineLinked, true);
  assert.equal(d.globalProfile, 'global');
  assert.equal(d.stages[0].model, undefined, 'same as the run');
  assert.equal(d.stages[0].reasoningEffort, undefined);
  assert.equal(d.stages[1].model, 'gpt-b');
  assert.equal(d.stages[1].daybreak, undefined, '"default" is not shown');
  assert.deepEqual(d.stages[1].followUps, ['now write it up']);
  assert.equal(d.stages[1].agentToken, 'user');
  assert.equal(d.stages[1].engineLinked, true);
  assert.deepEqual(d.stages[1].attempts, [{ kind: 'initial', model: 'gpt-b', status: 'failed', durationSec: 2 }, { kind: 'fallback', status: 'succeeded', durationSec: 3 }]);
  assert.equal(d.stages[0].attempts, undefined, 'one attempt: not listed');
});

test('trigger: one object; createdAt only while queued; cancel / rerun only when set', () => {
  assert.deepEqual(runDetail(stored({ trigger: 'schedule', schedule: { id: 's1', name: 'nightly' } })).trigger, { type: 'schedule', id: 's1', name: 'nightly' });
  const older = stored(); delete older.trigger; delete older.schedule;
  assert.deepEqual(runDetail(older).trigger, { type: 'user' }, 'older runs: user');

  const queued = runDetail(stored({ status: 'queued', startedAt: null, finishedAt: null }));
  assert.equal(queued.createdAt, '2026-11-08T14:26:08.839Z');
  assert.ok(!('startedAt' in queued) && !('finishedAt' in queued));
  assert.equal(runDetail(stored()).createdAt, undefined);

  assert.equal(runDetail(stored({ status: 'running', cancelRequested: true })).cancelRequested, true);
  assert.equal(runDetail(stored({ status: 'cancelled', cancelRequested: true })).cancelRequested, undefined, 'status already says it');
  assert.equal(runDetail(stored({ rerunOf: 'old-id' })).rerunOf, 'old-id');
});

test('older runs (only `prompt`, no request) still show', () => {
  const old = stored(); delete old.objective; delete old.request;
  assert.equal(runDetail(old).objective, OBJECTIVE);
});

test('the stored run is not changed', () => {
  const run = stored();
  const copy = structuredClone(run);
  runDetail(run); runListItem(run);
  assert.deepEqual(run, copy);
});
