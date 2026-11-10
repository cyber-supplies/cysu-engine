// daybreak.js: plain-language advice for OpenAI Daybreak access errors.
//
// OpenAI's own messages are misleading: a Red-approved account that asks for
// daybreak_red with a mainline model is told "You do not have Daybreak
// access", and a cyber model on a ChatGPT login only says it is "not
// supported". daybreakHint maps those errors to what to change. Seen live
// (engine runs of 2026-11-08) unless marked otherwise.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hardeningArgs, secretsLine, IMAGE, LABEL, removeContainer, copyFileFromContainer } from './docker.js';

const APPROVAL_PAGE = 'https://platform.openai.com/settings/organization/status-and-access';
const CYBER_MODEL = /cyber/i;

// errorDetails reads {code, message} from a Codex error message, which is
// either plain text or OpenAI's JSON error body as a string.
function errorDetails(message) {
  const text = String(message ?? '');
  try {
    const body = JSON.parse(text);
    const error = body?.error && typeof body.error === 'object' ? body.error : body;
    return { code: String(error?.code ?? ''), text: String(error?.message ?? text) };
  } catch {
    const code = text.match(/\b(invalid_access_program|access_program_not_enabled|unsupported_access_program)\b/);
    return { code: code ? code[1] : '', text };
  }
}

// daybreakHint returns advice for one error message, or null when it is not a
// Daybreak access problem. `daybreak` and `model` (of the failing attempt)
// make the advice specific; without them it covers every case.
export function daybreakHint(message, { daybreak = '', model = '' } = {}) {
  const { code, text } = errorDetails(message);

  if (/not supported when using codex with a chatgpt account/i.test(text)) {
    const which = model ? `"${model}"` : 'This model';
    return CYBER_MODEL.test(model || text)
      ? `${which} cannot be used with a ChatGPT login: OpenAI's cyber models need an OpenAI API key from a Daybreak Red–approved project. Set that key in the engine settings, or use a regular model with daybreak "blue".`
      : `${which} cannot be used with a ChatGPT login. Use an OpenAI API key in the engine settings, or choose another model.`;
  }

  if (code === 'invalid_access_program' || /do not have daybreak access/i.test(text)) {
    if (daybreak === 'blue') {
      return `OpenAI says this account has no Daybreak Blue access. Check its approval at ${APPROVAL_PAGE}, or run with daybreak "standard".`;
    }
    const red = 'OpenAI refused Daybreak Red. This message also appears for approved accounts: Red only works with the cyber models (such as gpt-5.6-cyber), and those need an OpenAI API key from a Red-approved project.';
    const instead = 'With a regular model or a ChatGPT login, use daybreak "blue" instead';
    if (daybreak === 'red') {
      return CYBER_MODEL.test(model)
        ? `${red} Check that the API key belongs to that project (${APPROVAL_PAGE}).`
        : `${red} ${instead}${model ? ` ("${model}" is not a cyber model)` : ' (the default model is not a cyber model)'}.`;
    }
    return `${red} ${instead}; for Blue, check the account's approval at ${APPROVAL_PAGE}.`;
  }

  // Documented by OpenAI; not yet seen in an engine run.
  if (code === 'access_program_not_enabled') {
    return `This OpenAI organization or project is not enabled for the Daybreak program requested${daybreak && daybreak !== 'default' ? ` ("${daybreak}")` : ''}. Check its approval at ${APPROVAL_PAGE}, use an API key from an approved project, or run with daybreak "standard".`;
  }
  if (code === 'unsupported_access_program') {
    return `This model does not support the Daybreak program requested${daybreak && daybreak !== 'default' ? ` ("${daybreak}")` : ''}. Choose another model, or run with daybreak "blue" or "standard".`;
  }
  return null;
}

// ---- access check (POST /api/daybreak/check) ---------------------------------

export const CHECK_PROGRAMS = ['standard', 'blue', 'red'];
const CHECK_TIMEOUT_MS = 8 * 60_000; // 3 programs × up to 120 s each, plus container start-up
const MODEL = /^[A-Za-z0-9._:/-]{1,120}$/;

export class CheckError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// checkDaybreak starts one worker container that asks Codex for a one-word
// reply under each access program (a few tokens per program) and resolves to
// { checkedAt, model, results: [{ program, ok, error, hint }] }. With a
// ChatGPT login, the container's possibly refreshed auth.json is exposed as
// the non-enumerable `refreshedCodexAuth`, as stages do.
export async function checkDaybreak({ settings, codexAuth = null, model = '', image, run = runCheckContainer }) {
  model = String(model ?? '').trim();
  if (model && !MODEL.test(model)) throw new CheckError(400, 'Invalid model name');
  const { lines, refreshedCodexAuth } = await run({ settings, codexAuth, image, job: { programs: CHECK_PROGRAMS, model } });
  const reported = new Map();
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'engine.daybreak.check' && CHECK_PROGRAMS.includes(e.program)) reported.set(e.program, e);
  }
  const results = CHECK_PROGRAMS.map((program) => {
    const e = reported.get(program);
    if (!e) return { program, ok: false, error: 'The check did not finish for this program', hint: null };
    const error = e.ok ? '' : String(e.error || `Codex exited with code ${e.exitCode}`);
    return { program, ok: Boolean(e.ok), error, hint: e.ok ? null : daybreakHint(error, { daybreak: program, model }) };
  });
  const result = { checkedAt: new Date().toISOString(), model: model || 'default', results };
  Object.defineProperty(result, 'refreshedCodexAuth', { value: refreshedCodexAuth ?? null, enumerable: false });
  return result;
}

// runCheckContainer runs the hardened worker in check mode and returns its
// stdout lines (plus the refreshed ChatGPT login, if any).
async function runCheckContainer({ settings, codexAuth, image, job }) {
  const container = `cysu-check-${randomUUID().slice(0, 8)}`;
  const env = { CYSU_SECRETS: 'stdin', CYSU_DAYBREAK_CHECK_JSON: JSON.stringify(job) };
  if (process.env.CYSU_ENGINE_TEST_NO_FIREWALL === '1') env.CYSU_EGRESS_GUARD = '0';
  if (process.env.CYSU_API_URL) env.CYSU_API_URL = process.env.CYSU_API_URL;
  const args = ['run', '-i', '--name', container, '--label', `${LABEL}=check`, ...hardeningArgs()];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push(image || IMAGE);

  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  child.stdin.end(secretsLine(settings, codexAuth));
  let out = '';
  child.stdout.on('data', (chunk) => { if (out.length < 1_000_000) out += chunk; });
  const timer = setTimeout(() => removeContainer(container), CHECK_TIMEOUT_MS);
  const code = await new Promise((resolve) => { child.on('error', () => resolve(-1)); child.on('close', resolve); });
  clearTimeout(timer);
  let refreshedCodexAuth = null;
  if (settings.llm?.mode === 'codex' && codexAuth) {
    const raw = await copyFileFromContainer(container, '/home/runner/.codex/auth.json');
    try { refreshedCodexAuth = raw && JSON.parse(raw.toString('utf8')); } catch { refreshedCodexAuth = null; }
  }
  await removeContainer(container);
  if (code === -1) throw new CheckError(503, 'Could not start docker');
  return { lines: out.split('\n').filter(Boolean), refreshedCodexAuth };
}
