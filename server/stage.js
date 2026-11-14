// stage.js runs ONE stage: a fresh hardened worker container that installs
// the global profile and one stage profile, then runs the selected agent on the prompt.
// It turns the agent's JSONL event stream into a live run record.
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
import { MODEL_NAME, isOpenRouterModel, llmProvider, validateProvider } from './llm-policy.js';
import { CLAUDE_CONFIG_DIR } from './claude-login.js';

export const REASONING_EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// OpenAI Daybreak (Trusted Access for Cyber): which access program Codex asks
// for. default = leave it to OpenAI (Daybreak where the account has it);
// standard = off; blue / red = that tier (the account must be approved).
export const DAYBREAK = ['default', 'standard', 'blue', 'red'];
export const DAYBREAK_ERROR = 'daybreak must be one of default, standard, blue, red';
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_EVENTS = 20_000;
const MAX_REPROMPTS = 20;
const MAX_LOG = 1_000_000;

export class StageError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// validateStage checks a stage definition before anything starts.
export function validateStage(input = {}) {
  validateProvider(input.provider);
  const stage = {
    ...(input.provider !== undefined && { provider: input.provider }),
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
  if (stage.model && !MODEL_NAME.test(stage.model)) throw new StageError('Invalid model name');
  if (!REASONING_EFFORTS.includes(stage.reasoningEffort)) throw new StageError('Unknown reasoning effort');
  if (stage.fallbackModel && !MODEL_NAME.test(stage.fallbackModel)) throw new StageError('Invalid fallback model name');
  if (!DAYBREAK.includes(stage.daybreak)) throw new StageError(DAYBREAK_ERROR);
  if (!Array.isArray(stage.reprompts) || !stage.reprompts.every((p) => typeof p === 'string' && p.trim())) {
    throw new StageError('Follow-up prompts must be a list of non-empty texts');
  }
  if (stage.reprompts.length > MAX_REPROMPTS) throw new StageError(`At most ${MAX_REPROMPTS} follow-up prompts per stage`);
  if (stage.reprompts.some((p) => p.length > 100_000)) throw new StageError('Follow-up prompt is too long (100,000 characters max)');
  stage.reprompts = [...stage.reprompts];
  return stage;
}

export function validateProviderStage(stage, llm, codexAuth, claudeAuth = false) {
  const provider = llmProvider(llm, codexAuth, claudeAuth, stage.provider);
  if (stage.provider && !provider) throw new StageError(`Provider ${stage.provider} is not configured or LLM execution is disabled; add its credentials first`);
  if (provider === 'claude' && !['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(stage.reasoningEffort)) {
    throw new StageError('Claude reasoningEffort must be low, medium, high, xhigh, max, or omitted');
  }
  if (provider === 'claude' && ['blue', 'red'].includes(stage.daybreak)) {
    throw new StageError('Daybreak blue/red requires a Codex subscription login; Claude cannot provide that access program');
  }
  if (provider === 'openrouter' && ['blue', 'red'].includes(stage.daybreak)) {
    throw new StageError('Daybreak blue/red requires a Codex subscription login; OpenRouter cannot provide that access program');
  }
  if (provider === 'openrouter' && stage.model && !isOpenRouterModel(stage.model)) {
    throw new StageError('With OpenRouter, model must include its provider (provider/model), or be omitted to use the configured default');
  }
  if (provider === 'openrouter' && stage.fallbackModel && !isOpenRouterModel(stage.fallbackModel)) {
    throw new StageError('With OpenRouter, fallbackModel must include its provider (provider/model), or be omitted');
  }
  return provider === 'openrouter' ? { ...stage, model: stage.model || llm.openrouter.model } : stage;
}

// applyEvent folds one event into the run summary. Each agent invocation inside the
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
      run.attempts.push({ kind: String(event.kind || ''), model: String(event.model || ''), provider: String(event.provider || 'openai'), daybreak: String(event.daybreak || 'default'), startedAt: event.time, finishedAt: null, exitCode: null, turns: 0, status: 'running' });
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
    case 'system':
      if (event.subtype === 'init' && typeof event.session_id === 'string') run.threadId = event.session_id;
      break;
    case 'assistant':
      if (!event.parent_tool_use_id && Array.isArray(event.message?.content)) {
        const text = event.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        if (text) run.result = text;
      }
      break;
    case 'result':
      if (typeof event.session_id === 'string') run.threadId = event.session_id;
      if (event.is_error || event.subtype !== 'success') {
        run.agentError = true;
        run.errors.push(...(Array.isArray(event.errors) && event.errors.length ? event.errors.map(String) : [String(event.result || 'Claude attempt failed')]));
      } else {
        run.turns += 1;
        if (current) current.turns += 1;
        if (event.usage) run.usage = event.usage;
        if (typeof event.result === 'string') run.result = event.result;
      }
      break;
  }
}

// startStage launches the container and returns the live run record at once.
// `run.done` resolves when the container has exited, been cleaned up, and the
// run is final. With a Codex (ChatGPT) login, the container's possibly
// refreshed ~/.codex/auth.json is copied out first and exposed as the
// non-enumerable `run.refreshedCodexAuth` (never serialized with the run).
// `link` ({ network, ip, port, key }, engine linked): the worker joins that
// network and gets CYSU_ENGINE_URL; its firewall lets through that one
// address:port; the read-only key goes in with the other secrets (stdin).
// Shortest secret value that is masked: masking a very short value would
// garble ordinary text wherever those few characters happen to appear.
export const MIN_MASKED_SECRET = 6;

// secretMasker returns a function that replaces every user secret value in a
// line with [secret:NAME], before the engine saves or shows it (events, log,
// result, downloads, engine linked reads). The JSON-escaped form is masked
// too, since events arrive as JSON. The replacement has no quotes or
// backslashes, so a JSON line stays valid JSON.
export function secretMasker(userSecrets = {}) {
  const forms = [];
  for (const [name, value] of Object.entries(userSecrets || {})) {
    if (typeof value !== 'string' || value.length < MIN_MASKED_SECRET) continue;
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) forms.push([form, `[secret:${name}]`]);
  }
  forms.sort((a, b) => b[0].length - a[0].length); // a longer value first, if one contains another
  if (forms.length === 0) return (text) => text;
  return (text) => {
    for (const [form, mask] of forms) if (text.includes(form)) text = text.split(form).join(mask);
    return text;
  };
}

export function startStage({ stage: input, settings, codexAuth = null, claudeVolume = null, userSecrets = {}, cli = null, link = null, image = IMAGE, extraEnv = {}, onUpdate = () => {}, onLog = () => {} }) {
  const stage = validateProviderStage(validateStage(input), settings.llm, codexAuth, Boolean(claudeVolume));
  const provider = llmProvider(settings.llm, codexAuth, Boolean(claudeVolume), stage.provider);
  if (provider === 'claude' && !/^cysu-claude-[0-9a-f-]{36}$/.test(claudeVolume)) throw new StageError('Invalid Claude authentication volume');
  const id = randomUUID();
  const container = `cysu-stage-${id.slice(0, 8)}`;
  const run = {
    id, container, stage: { ...stage }, status: 'running',
    startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
    threadId: null, turns: 0, usage: null, result: '', agentError: false, errors: [], hints: [], attempts: [],
    events: [], log: '', cancelled: false,
  };

  // cli (cli-cache.js): the run's CLI from the engine's cache (read-only mount + CYSU_CLI_DIR).
  const env = { CYSU_SECRETS: 'stdin', CYSU_STAGE_JSON: JSON.stringify(stage), ...(cli?.env || {}), ...extraEnv };
  if (link) {
    env.CYSU_ENGINE_URL = `http://${link.ip}:${link.port}`;
    env.CYSU_ENGINE_ALLOW = `${link.ip}:${link.port}`;
  }
  // Tests only: lets workers reach a stand-in API on this machine.
  if (process.env.CYSU_ENGINE_TEST_NO_FIREWALL === '1') env.CYSU_EGRESS_GUARD = '0';
  if (process.env.CYSU_API_URL && !env.CYSU_API_URL) env.CYSU_API_URL = process.env.CYSU_API_URL;
  // No --rm: the engine copies the refreshed login out after exit, then removes it.
  const args = ['run', '-i', '--name', container, '--label', `${LABEL}=stage`, ...hardeningArgs()];
  if (provider === 'claude') {
    args.push('--mount', `type=volume,source=${claudeVolume},target=${CLAUDE_CONFIG_DIR}`);
    Object.assign(env, { CLAUDE_CONFIG_DIR, CYSU_LLM_PROVIDER: 'claude', DISABLE_AUTOUPDATER: '1' });
  }
  if (link) args.push('--network', link.network);
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  if (cli?.mounts?.length) args.push(...cli.mounts);
  args.push(image);

  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdin.end(secretsLine(settings, codexAuth, link?.key || '', userSecrets, provider));

  const mask = secretMasker(userSecrets);
  const appendLog = (raw) => {
    const line = mask(raw);
    onLog(line);
    run.log += `${line}\n`;
    if (run.log.length > MAX_LOG) run.log = run.log.slice(-MAX_LOG);
  };

  const stdout = (async () => {
    for await (const raw of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (!raw.trim()) continue;
      const line = mask(raw);
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
      if (provider === 'codex') {
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
