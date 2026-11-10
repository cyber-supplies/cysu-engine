// stage.js runs ONE stage: a fresh hardened worker container that installs
// the global profile and one stage profile, then runs Codex on the prompt.
// It turns Codex's JSONL event stream into a live run record.
//
// Container protocol (see image/entrypoint.sh):
//   stdin   one JSON line of secrets (token, passphrase, LLM login)
//   env     CYSU_STAGE_JSON = {profile, globalProfile, prompt, model, reasoningEffort,
//                              fallbackModel, reprompts, daybreak}
//   stdout  JSONL only: Codex events + engine.attempt / engine.attempt.finished
//           markers around each Codex run (initial, fallback, reprompt)
//   stderr  [engine] lines, cysu output, Codex stderr

import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { daybreakHint } from './daybreak.js';
import { hardeningArgs, secretsLine, IMAGE, LABEL, removeContainer, copyFileFromContainer } from './docker.js';

export const REASONING_EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// OpenAI Daybreak (Trusted Access for Cyber): which access program Codex asks
// for. default = leave it to OpenAI (Daybreak where the account has it);
// standard = off; blue / red = that tier (the account must be approved).
export const DAYBREAK = ['default', 'standard', 'blue', 'red'];
export const DAYBREAK_ERROR = 'daybreak must be one of default, standard, blue, red';
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,120}$/;
const MAX_EVENTS = 20_000;
const MAX_REPROMPTS = 20;
const MAX_LOG = 1_000_000;

export class StageError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// validateStage checks a stage definition before anything starts.
export function validateStage(input = {}) {
  const stage = {
    profile: String(input.profile ?? '').trim(),
    globalProfile: String(input.globalProfile ?? '').trim(),
    prompt: String(input.prompt ?? ''),
    model: String(input.model ?? '').trim(),
    reasoningEffort: String(input.reasoningEffort ?? '').trim(),
    fallbackModel: String(input.fallbackModel ?? '').trim(),
    reprompts: input.reprompts ?? [],
    daybreak: String(input.daybreak || 'default').trim(),
  };
  if (!PROFILE_ID.test(stage.profile)) throw new StageError('A valid stage profile ID is required');
  if (stage.globalProfile && !PROFILE_ID.test(stage.globalProfile)) throw new StageError('Invalid global profile ID');
  if (stage.globalProfile && stage.globalProfile === stage.profile) throw new StageError('The stage profile cannot be the global profile');
  if (!stage.prompt.trim()) throw new StageError('An objective is required');
  if (stage.prompt.length > 100_000) throw new StageError('Objective is too long (100,000 characters max)');
  if (stage.model && !MODEL.test(stage.model)) throw new StageError('Invalid model name');
  if (!REASONING_EFFORTS.includes(stage.reasoningEffort)) throw new StageError('Unknown reasoning effort');
  if (stage.fallbackModel && !MODEL.test(stage.fallbackModel)) throw new StageError('Invalid fallback model name');
  if (!DAYBREAK.includes(stage.daybreak)) throw new StageError(DAYBREAK_ERROR);
  if (!Array.isArray(stage.reprompts) || !stage.reprompts.every((p) => typeof p === 'string' && p.trim())) {
    throw new StageError('Follow-up prompts must be a list of non-empty texts');
  }
  if (stage.reprompts.length > MAX_REPROMPTS) throw new StageError(`At most ${MAX_REPROMPTS} follow-up prompts per stage`);
  if (stage.reprompts.some((p) => p.length > 100_000)) throw new StageError('Follow-up prompt is too long (100,000 characters max)');
  stage.reprompts = [...stage.reprompts];
  return stage;
}

// applyEvent folds one event into the run summary. Each Codex run inside the
// container (initial, fallback, reprompt) is an "attempt"; agentError tracks
// only the current attempt, so a failure rescued by the fallback model does
// not fail the stage (the container's exit code is the final word).
function applyEvent(run, event) {
  const current = run.attempts.at(-1);
  // A Daybreak access error also gets plain advice in run.hints (once each).
  const advise = (message) => {
    const hint = daybreakHint(message, { daybreak: current?.daybreak || run.stage.daybreak, model: current ? current.model : run.stage.model });
    if (hint && !run.hints.includes(hint)) run.hints.push(hint);
  };
  switch (event.type) {
    case 'engine.attempt':
      run.attempts.push({ kind: String(event.kind || ''), model: String(event.model || ''), daybreak: String(event.daybreak || 'default'), startedAt: event.time, finishedAt: null, exitCode: null, turns: 0, status: 'running' });
      run.agentError = false;
      break;
    case 'engine.attempt.finished':
      if (current) {
        current.exitCode = Number(event.exitCode);
        current.finishedAt = event.time;
        current.status = current.exitCode === 0 ? 'succeeded' : 'failed';
      }
      break;
    case 'thread.started':
      if (typeof event.thread_id === 'string') run.threadId = event.thread_id;
      break;
    case 'turn.completed':
      run.turns += 1;
      if (current) current.turns += 1;
      if (event.usage && typeof event.usage === 'object') run.usage = event.usage;
      break;
    case 'turn.failed':
      run.agentError = true;
      if (event.error?.message) { run.errors.push(String(event.error.message)); advise(event.error.message); }
      break;
    case 'error':
      if (event.message) { run.errors.push(String(event.message)); advise(event.message); }
      break;
    case 'item.completed':
      if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') run.result = event.item.text;
      break;
  }
}

// startStage launches the container and returns the live run record at once.
// `run.done` resolves when the container has exited, been cleaned up, and the
// run is final. With a Codex (ChatGPT) login, the container's possibly
// refreshed ~/.codex/auth.json is copied out first and exposed as the
// non-enumerable `run.refreshedCodexAuth` (never serialized with the run).
export function startStage({ stage: input, settings, codexAuth = null, image = IMAGE, extraEnv = {}, onUpdate = () => {}, onLog = () => {} }) {
  const stage = validateStage(input);
  const id = randomUUID();
  const container = `cysu-stage-${id.slice(0, 8)}`;
  const run = {
    id, container, stage: { ...stage }, status: 'running',
    startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
    threadId: null, turns: 0, usage: null, result: '', agentError: false, errors: [], hints: [], attempts: [],
    events: [], log: '', cancelled: false,
  };

  const env = { CYSU_SECRETS: 'stdin', CYSU_STAGE_JSON: JSON.stringify(stage), ...extraEnv };
  // Tests only: lets workers reach a stand-in API on this machine.
  if (process.env.CYSU_ENGINE_TEST_NO_FIREWALL === '1') env.CYSU_EGRESS_GUARD = '0';
  if (process.env.CYSU_API_URL && !env.CYSU_API_URL) env.CYSU_API_URL = process.env.CYSU_API_URL;
  // No --rm: the engine copies the refreshed login out after exit, then removes it.
  const args = ['run', '-i', '--name', container, '--label', `${LABEL}=stage`, ...hardeningArgs()];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push(image);

  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdin.end(secretsLine(settings, codexAuth));

  const appendLog = (line) => {
    onLog(line);
    run.log += `${line}\n`;
    if (run.log.length > MAX_LOG) run.log = run.log.slice(-MAX_LOG);
  };

  const stdout = (async () => {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { event = null; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { appendLog(line); continue; }
      event = { time: new Date().toISOString(), ...event };
      run.events.push(event);
      if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
      applyEvent(run, event);
      onUpdate(run, event);
    }
  })();
  const stderr = (async () => {
    for await (const line of createInterface({ input: child.stderr, crlfDelay: Infinity })) appendLog(line);
  })();

  run.done = new Promise((resolve) => {
    let spawnError = null;
    child.on('error', (error) => { spawnError = error; });
    child.on('close', async (code) => {
      await Promise.allSettled([stdout, stderr]);
      if (spawnError) appendLog(`[engine] could not start docker: ${spawnError.message}`);
      if (settings.llm?.mode === 'codex' && codexAuth) {
        const raw = await copyFileFromContainer(container, '/home/runner/.codex/auth.json');
        let refreshed = null;
        try { refreshed = raw && JSON.parse(raw.toString('utf8')); } catch { refreshed = null; }
        Object.defineProperty(run, 'refreshedCodexAuth', { value: refreshed, enumerable: false });
      }
      await removeContainer(container);
      run.exitCode = code;
      run.finishedAt = new Date().toISOString();
      for (const a of run.attempts) if (a.status === 'running') { a.status = run.cancelled ? 'cancelled' : 'failed'; a.finishedAt = run.finishedAt; }
      run.status = run.cancelled ? 'cancelled'
        : code === 0 && !run.agentError ? 'succeeded' : 'failed';
      onUpdate(run, null);
      resolve(run);
    });
  });
  Object.defineProperty(run, 'done', { enumerable: false });
  return run;
}

// cancelStage stops the stage container (SIGTERM, then SIGKILL after 10s);
// run.done then finishes the cleanup.
export function cancelStage(run) {
  if (run.status !== 'running') return Promise.resolve(run);
  run.cancelled = true;
  return new Promise((resolve) => execFile('docker', ['stop', '-t', '10', run.container], () => resolve(run)));
}
