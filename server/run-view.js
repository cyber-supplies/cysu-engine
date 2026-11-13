// run-view.js: what the API shows of a run. The stored run.json keeps
// everything (its `request` is what "run again" repeats); the API shows each
// fact once and leaves out empty and default values.
//
//   list item: id, name, status, trigger, workspace, model, reasoningEffort,
//              createdAt (only while queued), startedAt, finishedAt, error,
//              stages [{ index, profile, status, error }]
//   detail:    the list item plus objective and the run's other settings, and
//              per stage what it used and what came of it (result, usage, …).

const ACTIVE = ['queued', 'running'];

// keep drops undefined, null, '' and [] values (false and 0 stay).
const keep = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) =>
  v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)));

const seconds = (from, to) => (from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) : undefined);

// trigger: who started the run — { type: 'user' } or { type: 'schedule', id, name }.
function trigger(run) {
  if (run.trigger === 'schedule' || run.schedule) return keep({ type: 'schedule', id: run.schedule?.id, name: run.schedule?.name });
  return { type: 'user' };
}

// stageError: why a stage did not succeed, in one line (the agent's last
// turn.failed / error message; else how the container ended).
function stageError(stage) {
  if (!['failed', 'interrupted'].includes(stage.status)) return undefined;
  const last = (stage.errors || []).at(-1);
  if (last) return last;
  if (stage.status === 'interrupted') return 'The engine stopped while this stage was running';
  return stage.exitCode !== null && stage.exitCode !== undefined ? `Exited with code ${stage.exitCode}` : undefined;
}

// usage without zero counters.
const usage = (u) => (u && typeof u === 'object' ? Object.fromEntries(Object.entries(u).filter(([, v]) => v)) : undefined);

function listStage(stage) {
  return keep({ index: stage.index, profile: stage.profile, status: stage.status, error: stageError(stage) });
}

function detailStage(stage, run) {
  const differs = (key) => (stage[key] && stage[key] !== run[key] ? stage[key] : undefined);
  const attempts = stage.attempts || [];
  return keep({
    ...listStage(stage),
    hints: stage.hints,
    // What the stage used, where it is not the run's setting / the default.
    model: differs('model'),
    reasoningEffort: differs('reasoningEffort'),
    fallbackModel: differs('fallbackModel'),
    daybreak: stage.daybreak && stage.daybreak !== 'default' ? stage.daybreak : undefined,
    followUps: stage.reprompts,
    engineLinked: stage.engineLinked === true ? true : undefined,
    agentToken: stage.agentToken === 'user' ? 'user' : undefined, // the default (llm) is not shown
    startedAt: stage.startedAt,
    finishedAt: stage.finishedAt,
    durationSec: seconds(stage.startedAt, stage.finishedAt),
    exitCode: stage.exitCode,
    result: stage.result,
    // Only when Codex finished a turn.
    threadId: stage.turns > 0 ? stage.threadId : undefined,
    usage: stage.turns > 0 ? usage(stage.usage) : undefined,
    // Only when there was more than the first Codex run (fallback model, follow-ups).
    attempts: attempts.length > 1
      ? attempts.map((a) => keep({ kind: a.kind, model: a.model, status: a.status, durationSec: seconds(a.startedAt, a.finishedAt) }))
      : undefined,
    eventCount: stage.eventCount, // the CLI reads it to bound transcript downloads
  });
}

function base(run) {
  return keep({
    id: run.id,
    name: run.name,
    status: run.status,
    trigger: trigger(run),
    workspace: run.workspace,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    createdAt: run.status === 'queued' ? run.createdAt : undefined,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
  });
}

// runListItem: a run as GET /api/runs shows it.
export function runListItem(run) {
  return { ...base(run), stages: (run.stages || []).map(listStage) };
}

// runDetail: a run as GET /api/runs/{id} (and create, rerun, cancel) shows it.
export function runDetail(run) {
  return {
    ...base(run),
    ...keep({
      objective: run.objective ?? run.prompt,
      globalProfile: run.globalProfile,
      fallbackModel: run.fallbackModel,
      continueOnFailure: run.continueOnFailure === false ? false : undefined, // default true
      engineLinked: run.engineLinked === true ? true : undefined,
      cancelRequested: run.cancelRequested && ACTIVE.includes(run.status) ? true : undefined,
      rerunOf: run.rerunOf,
    }),
    stages: (run.stages || []).map((s) => detailStage(s, run)),
  };
}
