// cysu-engine server: the engine's JSON API, used by the cysu CLI
// (documented in openapi.yaml). No web UI. Zero dependencies.
// Same machine only: it listens on 127.0.0.1 and rejects requests that come
// from web pages on other sites or through other host names (DNS rebinding).
// Every request needs the engine token (the user's Cyber Supplies user
// token, set at setup): see auth.js and the request handler at the bottom.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, load, save } from './store.js';
import { dockerAvailable, IMAGE, connectEngine, AGENT_PORT } from './docker.js';
import { startCodexLogin, cancelCodexLogin, codexLoginState, codexAuthInfo, loadCodexAuth, forgetCodexAuth, keepRefreshedCodexAuth } from './llm.js';
import { checkDaybreak } from './daybreak.js';
import { Runs } from './runs.js';
import { API_URL, STAGE_TAGS, fetchProfiles, fetchLlmToken } from './profiles.js';
import { Workspaces, WorkspaceError } from './workspaces.js';
import { Schedules } from './schedules.js';
import { Scheduler } from './scheduler.js';
import { bearerToken, sameToken, UNAUTHORIZED, oneAtATime, AuthLimiter, tooManyMessage } from './auth.js';
import { runListItem, runDetail } from './run-view.js';
import { listSecrets, setSecret, deleteSecret, secretValues } from './secrets.js';

const ENGINE_VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const defaultSettings = { token: '', passkey: '', llm: { mode: 'none', apiKey: '' }, globalProfile: '', agentToken: 'llm', engineLinked: false };
// agentToken: which Cyber Supplies token workers give the agent. "llm" (the
// default): the user's restricted llm_ token, fetched fresh for each worker
// and never stored; it can read profiles, accounts and emails but not change
// them. "user": the full usr_ token.
const AGENT_TOKENS = ['llm', 'user'];
async function agentToken(settings) {
  if ((settings.agentToken || 'llm') === 'user') return { kind: 'user', token: settings.token };
  return { kind: 'llm', token: await fetchLlmToken(settings.token) };
}

const runs = new Runs({
  dir: join(DATA_DIR, 'runs'),
  getSecrets: async () => {
    const settings = await load('settings', defaultSettings);
    return { settings, codexAuth: settings.llm?.mode === 'codex' ? await loadCodexAuth() : null, userSecrets: await secretValues() };
  },
  agentToken,
  listProfiles: (settings) => fetchProfiles(settings.token),
  onIdle: () => scheduler.tick(),
  engineLink: async (run) => {
    const { network, ip } = await connectEngine();
    await listenForAgents(ip);
    // One read-only key per stage, only in memory, revoked when the stage ends.
    // It starts with usr_ only because the cysu CLI insists on that prefix for
    // engine commands; it is NOT a Cyber Supplies token.
    const key = `usr_engine_${randomBytes(32).toString('base64url')}`;
    agentKeys.set(key, { runId: run.id, workspace: run.workspace ? { id: run.workspace.id, name: run.workspace.name } : null });
    return { network, ip, port: AGENT_PORT, key, release: () => agentKeys.delete(key) };
  },
});

const workspaces = new Workspaces();

// Scheduled runs: the engine starts them by itself (see scheduler.js).
const schedules = new Schedules({
  workspaceExists: (id) => workspaces.get(id).then(() => true, (e) => { if (e instanceof WorkspaceError && e.status === 404) return false; throw e; }),
});
// startWorkspaceRun: a run of the workspace's setup with the given objective
// (workspaces hold none; see workspaces.js).
const startWorkspaceRun = (ws, objective, schedule) => runs.create({ name: ws.name, ...ws.request, objective, workspace: { id: ws.id, name: ws.name } }, { schedule });
const scheduler = new Scheduler({
  schedules,
  getWorkspace: (id) => workspaces.get(id).catch((e) => { if (e instanceof WorkspaceError && e.status === 404) return null; throw e; }),
  startRun: async (ws, s) => {
    if (!(await dockerAvailable())) throw new Error('Docker is not available on this machine');
    return startWorkspaceRun(ws, s.objective, { id: s.id, name: s.name });
  },
  isBusy: () => runs.busy,
  tickMs: Number(process.env.CYSU_ENGINE_TEST_SCHEDULER_TICK_MS) || undefined,
});

// Wrong engine tokens: 10 in a minute → every request refused for a minute.
// For automated tests only: CYSU_ENGINE_TEST_AUTH_LOCK_MS (shorter lockout)
// and CYSU_ENGINE_TEST_AUTH_MAX (more wrong tokens allowed).
const authLimiter = new AuthLimiter({
  lockMs: Number(process.env.CYSU_ENGINE_TEST_AUTH_LOCK_MS) || 60_000,
  max: Number(process.env.CYSU_ENGINE_TEST_AUTH_MAX) || 10,
});
function authFailed() {
  if (authLimiter.fail()) console.warn(`auth: ${authLimiter.max} wrong engine tokens within a minute; refusing all requests for ${Math.ceil(authLimiter.lockMs / 1000)}s`);
}

// workspaceView: a workspace plus the stages it would run now (or why not).
async function workspaceView(ws) {
  let plan = null; let planError = null;
  try {
    // Workspaces have no objective: plan with a stand-in to check the rest.
    const p = await runs.plan({ ...ws.request, objective: 'objective given at run time' });
    plan = { stages: p.stages.map((st) => ({ order: st.index + 1, tag: st.tag, profile: st.profile, model: st.model || 'default', daybreak: st.daybreak })), globalProfile: p.globalProfile || '' };
  } catch (error) { planError = error.message; }
  return { ...ws, plan, planError };
}

// scheduleView: a schedule as the CLI shows it — its workspace's name, the
// live status of its last run, and whether a run is waiting to start.
async function scheduleView(s) {
  const ws = await workspaces.get(s.workspaceId).catch(() => null);
  let lastRun = null;
  if (s.lastRun) {
    lastRun = { runId: s.lastRun.runId, startedAt: s.lastRun.startedAt, status: s.lastRun.runId ? 'deleted' : 'not started', finishedAt: null, error: s.lastRun.error ?? null };
    if (s.lastRun.runId) {
      const run = await runs.get(s.lastRun.runId).catch(() => null);
      if (run) Object.assign(lastRun, { status: run.status, finishedAt: run.finishedAt });
    }
  }
  return {
    id: s.id, name: s.name, enabled: s.enabled, summary: s.summary, when: s.when, tz: s.tz,
    workspaceId: s.workspaceId, workspace: { id: s.workspaceId, name: ws ? ws.name : null, exists: Boolean(ws) },
    objective: s.objective || '',
    nextAt: s.nextAt,
    waiting: s.queued ? { since: s.queuedAt, due: s.queuedFor } : null,
    lastRun, history: s.history, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

// The last Daybreak access check (POST /api/daybreak/check), for /status.
async function daybreakStatus() {
  const last = await load('daybreak-check', null);
  return { checking: Boolean(runs.hold), lastCheck: last };
}

// runDaybreakCheck asks Codex for a one-word reply under each access program
// (standard, blue, red) with the saved LLM login. It costs a few tokens, so it
// only runs when asked. Runs wait meanwhile (one LLM login, one user of it).
async function runDaybreakCheck(input) {
  const { settings, codexAuth } = await runs.getSecrets();
  const llmMode = settings.llm?.mode || 'none';
  if (!settings.token || !settings.passkey) throw Object.assign(new Error('Set your Cyber Supplies token and passkey first'), { status: 400 });
  if (!((llmMode === 'openai-api-key' && settings.llm?.apiKey) || (llmMode === 'codex' && codexAuth))) {
    throw Object.assign(new Error('Set an LLM login first (OpenAI API key or Sign in with ChatGPT)'), { status: 400 });
  }
  if (runs.active) throw Object.assign(new Error('A run is active; check Daybreak access when it has finished'), { status: 409 });
  if (runs.hold) throw Object.assign(new Error('A Daybreak check is already running'), { status: 409 });
  if (!(await dockerAvailable())) throw Object.assign(new Error('Docker is not available on this machine'), { status: 503 });
  runs.hold = 'A Daybreak access check is running; start the run again in a minute';
  try {
    const agent = await agentToken(settings);
    const result = await checkDaybreak({ settings: { ...settings, token: agent.token }, codexAuth, model: input?.model });
    await keepRefreshedCodexAuth(codexAuth, result.refreshedCodexAuth);
    await save('daybreak-check', result);
    return result;
  } finally {
    runs.hold = '';
    scheduler.tick();
  }
}

async function engineStatus() {
  const settings = await load('settings', defaultSettings);
  const llmMode = settings.llm?.mode || 'none';
  const llmReady = Boolean((llmMode === 'openai-api-key' && settings.llm?.apiKey) || (llmMode === 'codex' && (await codexAuthInfo()).saved));
  const cysuReady = Boolean(settings.token && settings.passkey);
  return {
    version: ENGINE_VERSION, docker: await dockerAvailable(), image: IMAGE, apiUrl: API_URL,
    cysu: cysuReady, llm: { mode: llmMode, ready: llmReady },
    configured: cysuReady && llmReady, // everything a run needs is set up
    daybreak: await daybreakStatus(),
  };
}

const mask = (v) => (v ? '••••' + String(v).slice(-4) : '');

const LLM_MODES = ['none', 'openai-api-key', 'codex'];

async function publicSettings(s) {
  return {
    token: mask(s.token),
    passkey: s.passkey ? 'set' : '',
    llm: { mode: s.llm?.mode || 'none', apiKey: mask(s.llm?.apiKey), codex: await codexAuthInfo() },
    globalProfile: s.globalProfile || '',
    agentToken: s.agentToken || 'llm',
    engineLinked: Boolean(s.engineLinked),
    configured: Boolean(s.token && s.passkey),
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Sent with every response: the engine only serves JSON/text/archives, so
// browsers get nothing to render, run or frame.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// ---- same-machine protection -------------------------------------------------
// Same machine only (its only client is the cysu CLI), checked BEFORE the
// engine token so web pages are turned away without touching the auth limiter:
//  - Host must be a loopback name (any port: in a container the published port
//    can differ): blocks DNS rebinding, where a web page makes its own host
//    name point at 127.0.0.1.
//  - No Origin header at all: only browsers send one, and no web page is meant
//    to talk to the engine. The CLI sends none.
//  - Requests with a body must be JSON: plain HTML forms cannot send that.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function rejectForeign(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!LOOPBACK.has(name)) return 'Unexpected Host header; use http://127.0.0.1:<port>';
  if (req.headers.origin !== undefined) return 'Requests from web pages are not allowed';
  if (hasBody(req) && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return 'Request bodies must be application/json';
  }
  return null;
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('Body too large'), { status: 413, closeConnection: true });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

// hasBody: the request has (or may have) a body.
const hasBody = (req) => Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;

function tooMany(res, ms) {
  const seconds = Math.ceil(ms / 1000);
  res.setHeader('Retry-After', String(seconds));
  if (hasBody(res.req)) res.setHeader('Connection', 'close'); // body not read
  return send(res, 429, { error: tooManyMessage(seconds), retryAfter: seconds });
}

function unauthorized(res, kind) {
  res.setHeader('WWW-Authenticate', 'Bearer realm="cysu-engine"');
  // The body of a refused request is never read: close the connection
  // instead of draining it (it could be huge) or reusing it with data left on it.
  if (hasBody(res.req)) res.setHeader('Connection', 'close');
  return send(res, 401, UNAUTHORIZED[kind]);
}

// verifyToken asks Cyber Supplies whether a user token is real before the
// engine accepts it (a typo would otherwise lock the user out of the engine).
async function verifyToken(token) {
  try {
    await fetchProfiles(token);
  } catch (error) {
    if (error.upstreamStatus === 401 || error.upstreamStatus === 403) {
      throw Object.assign(new Error('Cyber Supplies did not accept this token: check it (or make a new user token) and try again'), { status: 400 });
    }
    throw Object.assign(new Error('Could not check the token with Cyber Supplies right now (is the network up?); try again'), { status: 503 });
  }
}

// putSettings: PUT /api/settings. With `setup` it is the first setup (no
// engine token stored yet, so the request carried none): it must set a token,
// and loses to a setup that finished first. One change at a time.
async function putSettings(req, res, { setup }) {
  const input = await body(req);
  return oneAtATime(async () => {
    const settings = await load('settings', defaultSettings);
    if (setup && settings.token) { authFailed(); return unauthorized(res, 'token'); } // someone else set it up first
    // Empty fields mean "keep what is stored", so masked values never overwrite secrets.
    const next = { ...settings, llm: { ...settings.llm } };
    const token = input.token ? String(input.token).trim() : '';
    if (setup && !token) return unauthorized(res, 'setup');
    if (token) {
      // The engine works with a USER token (usr_…); LLM tokens cannot manage
      // profiles and workspaces.
      if (!token.startsWith('usr_')) return send(res, 400, { error: 'The engine needs your Cyber Supplies user token (it starts with usr_), not an LLM token' });
      if (token !== settings.token) {
        try { await verifyToken(token); } catch (error) { if (error.status === 400) authFailed(); throw error; }
      }
      next.token = token;
    }
    if (input.passkey) next.passkey = String(input.passkey);
    if (input.llm?.mode) {
      if (!LLM_MODES.includes(input.llm.mode)) return send(res, 400, { error: 'Unknown LLM login mode' });
      if (input.llm.mode === 'codex' && !(await codexAuthInfo()).saved) {
        return send(res, 400, { error: 'Sign in with ChatGPT first' });
      }
      next.llm.mode = input.llm.mode;
    }
    if (input.llm?.apiKey) next.llm.apiKey = String(input.llm.apiKey).trim();
    if (input.globalProfile !== undefined) next.globalProfile = String(input.globalProfile);
    if (input.agentToken !== undefined) {
      if (!AGENT_TOKENS.includes(input.agentToken)) return send(res, 400, { error: 'agentToken must be llm or user' });
      next.agentToken = input.agentToken;
    }
    if (input.engineLinked !== undefined) {
      if (typeof input.engineLinked !== 'boolean') return send(res, 400, { error: 'engineLinked must be true or false' });
      next.engineLinked = input.engineLinked;
    }
    await save('settings', next);
    return send(res, 200, { ...(await publicSettings(next)), ...(token && settings.token && token !== settings.token ? { tokenChanged: true } : {}) });
  });
}

async function api(req, res, path) {
  const settings = await load('settings', defaultSettings);

  if (path === '/api/status' && req.method === 'GET') {
    return send(res, 200, await engineStatus());
  }

  if (path === '/api/settings') {
    if (req.method === 'GET') return send(res, 200, await publicSettings(settings));
    if (req.method === 'PUT') return putSettings(req, res, { setup: false });
  }

  // Codex "Sign in with ChatGPT" (device code login in a worker container).
  if (path === '/api/llm/codex-login') {
    if (req.method === 'GET') return send(res, 200, codexLoginState());
    if (req.method === 'POST') {
      if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
      return send(res, 202, startCodexLogin());
    }
    if (req.method === 'DELETE') return send(res, 200, await cancelCodexLogin());
  }
  if (path === '/api/llm/codex-auth' && req.method === 'DELETE') {
    await forgetCodexAuth();
    return send(res, 200, await publicSettings(await load('settings', defaultSettings)));
  }

  // Daybreak access check: which access programs this LLM login can use.
  if (path === '/api/daybreak/check') {
    if (req.method === 'GET') return send(res, 200, await daybreakStatus());
    if (req.method === 'POST') return send(res, 200, await runDaybreakCheck(hasBody(req) ? await body(req) : {}));
  }

  // The user's own secrets for their skills (names only out; see secrets.js).
  if (path === '/api/secrets' && req.method === 'GET') return send(res, 200, await listSecrets());
  const secretPath = path.match(/^\/api\/secrets\/([^/]+)$/);
  if (secretPath) {
    let name;
    try { name = decodeURIComponent(secretPath[1]); } catch { return send(res, 400, { error: "Invalid secret name encoding" }); }
    if (req.method === 'PUT') {
      const input = hasBody(req) ? await body(req) : {};
      return send(res, 200, await setSecret(name, input?.value));
    }
    if (req.method === 'DELETE') {
      if (!(await deleteSecret(name))) return send(res, 404, { error: `No secret named ${name}` });
      return send(res, 200, { deleted: name });
    }
  }

  // Profiles come from the user's Cyber Supplies account via the gateway.
  if (path === '/api/profiles' && req.method === 'GET') return send(res, 200, await fetchProfiles(settings.token));

  // ---- workspaces (/workspace, /load, /run in the CLI) ----------------------
  // {id} is the workspace's exact id (names are labels only).
  if (path === '/api/workspaces') {
    if (req.method === 'GET') return send(res, 200, await workspaces.list());
    if (req.method === 'POST') {
      const input = await body(req);
      return send(res, 201, await workspaces.create({ name: input.name, request: input.request ?? { stages: [] } }));
    }
  }
  let m = path.match(/^\/api\/workspaces\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (req.method === 'GET') return send(res, 200, await workspaceView(await workspaces.get(id)));
    if (req.method === 'PATCH') {
      const input = await body(req);
      return send(res, 200, await workspaceView(await workspaces.update(id, { name: input.name, request: input.request })));
    }
    if (req.method === 'DELETE') {
      const ws = await workspaces.delete(id);
      await schedules.pauseForWorkspace(ws.id, `Its workspace "${ws.name}" was deleted; the schedule is paused`);
      res.writeHead(204); return res.end();
    }
  }
  m = path.match(/^\/api\/workspaces\/([^/]+)\/profiles$/);
  if (m && req.method === 'POST') {
    // /load: add (in order) / remove picked stage profiles, or set the global one.
    const input = await body(req);
    const list = (v) => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()) ? v.map((x) => x.trim()) : null);
    const add = list(input.add);
    const remove = list(input.remove);
    if (!add || !remove) return send(res, 400, { error: 'add and remove must be lists of profile ids' });
    if (input.global !== undefined && typeof input.global !== 'string') return send(res, 400, { error: 'global must be a profile id ("" for none)' });
    if (!add.length && !remove.length && input.global === undefined) return send(res, 400, { error: 'Nothing to change: give add, remove or global' });
    const rows = await fetchProfiles(settings.token);
    const mine = new Set(rows.map((r) => r?.id));
    const unknown = [...add, ...(input.global ? [input.global] : [])].filter((id) => !mine.has(id));
    if (unknown.length) return send(res, 400, { error: `Not one of your profiles: ${unknown.join(', ')}` });
    // A profile with exactly one stage tag 1-4 keeps it as the stage's tag.
    const tagOf = (id) => {
      const tag = rows.find((r) => r?.id === id)?.tag;
      return Array.isArray(tag) && tag.length === 1 && STAGE_TAGS.includes(tag[0]) ? tag[0] : '';
    };
    const out = await workspaces.changeStages(decodeURIComponent(m[1]), { add, remove, global: input.global?.trim(), tagOf });
    return send(res, 200, { ...(await workspaceView(out.workspace)), added: out.added, skipped: out.skipped, removed: out.removed });
  }
  m = path.match(/^\/api\/workspaces\/([^/]+)\/run$/);
  if (m && req.method === 'POST') {
    // /run: start a run of the workspace.
    if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
    const ws = await workspaces.get(decodeURIComponent(m[1]));
    const objective = (await body(req))?.objective;
    if (typeof objective !== 'string' || !objective.trim()) return send(res, 400, { error: 'Give the run an objective: {"objective": "what this run should do"}' });
    return send(res, 201, runDetail(await startWorkspaceRun(ws, objective, null)));
  }

  // ---- schedules (runs the engine starts by itself) -------------------------
  // {id} is the schedule's exact id. Times are wall-clock in the schedule's
  // timezone (tz, an IANA name the CLI takes from the user's machine).
  if (path === '/api/schedules') {
    if (req.method === 'GET') return send(res, 200, await Promise.all((await schedules.list()).map(scheduleView)));
    if (req.method === 'POST') {
      const input = await body(req);
      const s = await schedules.create({ workspaceId: input.workspaceId, objective: input.objective, when: input.when, tz: input.tz, name: input.name, enabled: input.enabled ?? true });
      scheduler.tick();
      return send(res, 201, await scheduleView(s));
    }
  }
  m = path.match(/^\/api\/schedules\/([^/]+)(\/pause|\/resume)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const action = m[2];
    if (!action && req.method === 'GET') return send(res, 200, await scheduleView(await schedules.get(id)));
    if (!action && req.method === 'PATCH') {
      const s = await schedules.update(id, await body(req));
      scheduler.tick();
      return send(res, 200, await scheduleView(s));
    }
    if (!action && req.method === 'DELETE') { await schedules.delete(id); res.writeHead(204); return res.end(); }
    if (action && req.method === 'POST') {
      const s = action === '/pause' ? await schedules.pause(id) : await schedules.resume(id);
      scheduler.tick();
      return send(res, 200, await scheduleView(s));
    }
  }

  // ---- runs ----------------------------------------------------------------
  if (path === '/api/runs') {
    if (req.method === 'GET') {
      // ?trigger=user|schedule and ?schedule=<schedule id> narrow the list.
      const q = new URL(req.url, 'http://localhost').searchParams;
      const trigger = q.get('trigger');
      if (trigger !== null && !['user', 'schedule'].includes(trigger)) return send(res, 400, { error: 'trigger must be user or schedule' });
      const schedule = q.get('schedule');
      let list = (await runs.list()).map(runListItem);
      if (trigger) list = list.filter((r) => r.trigger.type === trigger);
      if (schedule) list = list.filter((r) => r.trigger.id === schedule);
      return send(res, 200, list);
    }
    if (req.method === 'POST') {
      if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
      return send(res, 201, runDetail(await runs.create(await body(req))));
    }
  }
  if (path === '/api/runs/plan' && req.method === 'POST') return send(res, 200, await runs.plan(await body(req)));
  // Run routes accept the full id or a short prefix (the CLI shows 8 characters).
  m = path.match(/^\/api\/runs\/([\w-]+)(\/.*)?$/);
  if (m && m[1] !== 'plan') {
    const id = await runs.resolve(m[1]);
    const rest = m[2] || '';
    if (rest === '' && req.method === 'GET') return send(res, 200, runDetail(await runs.get(id)));
    if (rest === '' && req.method === 'DELETE') { await runs.delete(id); res.writeHead(204); return res.end(); }
    if (rest === '/cancel' && req.method === 'POST') return send(res, 202, runDetail(await runs.cancel(id)));
    if (rest === '/rerun' && req.method === 'POST') {
      if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
      return send(res, 201, runDetail(await runs.rerun(id)));
    }
    if (rest === '/download' && req.method === 'GET') {
      const { filename, data } = await runs.download(id);
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
      return res.end(data);
    }
    if (rest === '/feed' && req.method === 'GET') {
      // /watch: everything new across stages, waiting up to `wait` ms for news.
      const q = new URL(req.url, 'http://localhost').searchParams;
      return send(res, 200, await runs.feed(id, { cursor: q.get('cursor') || '', wait: q.get('wait') }));
    }
    let s2 = rest.match(/^\/stages\/(\d+)\/events$/);
    if (s2 && req.method === 'GET') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      return send(res, 200, await runs.events(id, s2[1], { after: q.get('after'), limit: q.get('limit') }));
    }
    s2 = rest.match(/^\/stages\/(\d+)\/log$/);
    if (s2 && req.method === 'GET') {
      const text = await runs.log(id, s2[1]); // load first: errors must still get a clean answer
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(text);
    }
  }

  return send(res, 404, { error: 'Not found' });
}

if (process.env.CYSU_ENGINE_TEST_AUTH_LOCK_MS || process.env.CYSU_ENGINE_TEST_AUTH_MAX) {
  console.warn('WARNING: CYSU_ENGINE_TEST_AUTH_* is set — the wrong-token limit is changed. For automated tests only.');
}
if (process.env.CYSU_ENGINE_TEST_SCHEDULER_TICK_MS) {
  console.warn('WARNING: CYSU_ENGINE_TEST_SCHEDULER_TICK_MS is set — the scheduler checks at a different pace. For automated tests only.');
}
if (process.env.CYSU_ENGINE_TEST_NO_FIREWALL === '1') {
  console.warn('WARNING: CYSU_ENGINE_TEST_NO_FIREWALL=1 — worker firewall is OFF. For automated tests only.');
}

await runs.recover().then(({ removedContainers }) => {
  if (removedContainers.length) console.log(`removed ${removedContainers.length} leftover container(s): ${removedContainers.join(', ')}`);
});

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const foreign = rejectForeign(req);
  if (foreign) return send(res, 403, { error: foreign });
  try {
    // The ONLY request answered without the engine token: "is it up?" for
    // scripts/engine.sh. It says nothing else.
    if (path === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true });

    // Locked out after too many wrong tokens: refuse everything (see auth.js).
    const locked = authLimiter.lockedFor();
    if (locked) return tooMany(res, locked);

    // The engine token check, for every other request, before anything else
    // (the body is not even read). Before setup there is no token: only the
    // setup call itself (PUT /api/settings with a token) is let through.
    const stored = (await load('settings', defaultSettings)).token;
    if (!stored) {
      if (path === '/api/settings' && req.method === 'PUT') return await putSettings(req, res, { setup: true });
      return unauthorized(res, 'setup');
    }
    if (!sameToken(bearerToken(req.headers.authorization), stored)) {
      if (req.headers.authorization !== undefined) authFailed(); // a wrong token is a guess; no header is not
      return unauthorized(res, 'token');
    }

    if (path.startsWith('/api/')) await api(req, res, path);
    else if (path === '/' && req.method === 'GET') send(res, 200, { name: 'cysu-engine', api: '/api', docs: 'openapi.yaml', ui: 'none: use the cysu CLI' });
    else send(res, 404, { error: 'Not found' });
  } catch (error) {
    if (!error.status) console.error(error);
    // A failure after the answer had started cannot change its status: end it
    // rather than throw (a throw here would stop the whole engine).
    if (res.headersSent) return res.end();
    if (error.closeConnection) res.setHeader('Connection', 'close'); // the rest of the body is still unread
    send(res, error.status || 500, { error: error.status ? error.message : 'Internal error' });
  }
});
await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
// Older engines kept the objective in the workspace: hand it to that
// workspace's schedules (so they keep working), then drop it.
const moved = await workspaces.takeObjectives((found) => schedules.adoptObjectives(found));
if (moved.size) console.log(`workspaces: moved ${moved.size} objective(s) out of workspaces (objectives are now given per run; schedules keep their own)`);
await scheduler.start();

// ---- agent listener (engine linked) -----------------------------------------
// A second, separate listener for the agents inside "engine linked" workers.
// It only listens on the engine's address on the private engine network (see
// docker.js connectEngine), never on the published port, and never accepts the
// engine token. Started the first time a stage is linked.
let agentServer = null;
let agentAddress = '';
// agentKeys: read-only key → its scope { runId, workspace } (see engineLink).
const agentKeys = new Map();

// What an agent may see: runs of the same workspace as the run it is part of
// (runs started without a workspace see the other runs without one).
const inScope = (scope, run) => (run.workspace?.id || null) === (scope.workspace?.id || null);

// scopedRunId resolves a full id or a short prefix among the runs in scope
// only, so other workspaces' runs are never found (or counted).
async function scopedRunId(scope, ref) {
  const key = String(ref ?? '').trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(key)) throw Object.assign(new Error('Run not found'), { status: 404 });
  const hits = (await runs.list()).filter((r) => inScope(scope, r) && (r.id === key || r.id.startsWith(key)));
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw Object.assign(new Error(`Several runs start with ${key}; give more characters`), { status: 409 });
  throw Object.assign(new Error('Run not found'), { status: 404 });
}

// agentApi: the read-only API on the agent port (GET only). The same answers
// as the engine API, narrowed to the key's workspace.
async function agentApi(req, res, path, scope) {
  if (req.method !== 'GET') return send(res, 403, { error: 'Read-only: an agent can look at earlier runs but not change anything' });
  const q = new URL(req.url, 'http://localhost').searchParams;
  if (path === '/api/status') {
    return send(res, 200, { ...(await engineStatus()), agent: { readOnly: true, workspace: scope.workspace, runId: scope.runId } });
  }
  if (path === '/api/workspaces') {
    return send(res, 200, (await workspaces.list()).filter((w) => w.id === scope.workspace?.id));
  }
  let m = path.match(/^\/api\/workspaces\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (id !== scope.workspace?.id) return send(res, 404, { error: 'Workspace not found' });
    return send(res, 200, await workspaceView(await workspaces.get(id)));
  }
  if (path === '/api/runs') {
    const trigger = q.get('trigger');
    if (trigger !== null && !['user', 'schedule'].includes(trigger)) return send(res, 400, { error: 'trigger must be user or schedule' });
    const schedule = q.get('schedule');
    let list = (await runs.list()).filter((r) => inScope(scope, r)).map(runListItem);
    if (trigger) list = list.filter((r) => r.trigger.type === trigger);
    if (schedule) list = list.filter((r) => r.trigger.id === schedule);
    return send(res, 200, list);
  }
  m = path.match(/^\/api\/runs\/([\w-]+)(\/.*)?$/);
  if (m) {
    const id = await scopedRunId(scope, m[1]);
    const rest = m[2] || '';
    if (rest === '') return send(res, 200, runDetail(await runs.get(id)));
    if (rest === '/feed') return send(res, 200, await runs.feed(id, { cursor: q.get('cursor') || '', wait: q.get('wait') }));
    if (rest === '/download') {
      const { filename, data } = await runs.download(id);
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
      return res.end(data);
    }
    let s2 = rest.match(/^\/stages\/(\d+)\/events$/);
    if (s2) return send(res, 200, await runs.events(id, s2[1], { after: q.get('after'), limit: q.get('limit') }));
    s2 = rest.match(/^\/stages\/(\d+)\/log$/);
    if (s2) {
      const text = await runs.log(id, s2[1]);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(text);
    }
  }
  return send(res, 404, { error: 'Not found (an agent can read: /api/status, /api/workspaces, /api/runs and a run\'s stages, events, log, feed, download)' });
}

const agentServerFor = (ip) => createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (req.headers.origin !== undefined) return send(res, 403, { error: 'Requests from web pages are not allowed' });
  const host = String(req.headers.host || '');
  if (host !== ip && host !== `${ip}:${AGENT_PORT}`) return send(res, 403, { error: `Unexpected Host header; use http://${ip}:${AGENT_PORT}` });
  try {
    if (path === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true });
    // Only a live stage key works here; the engine token never does.
    const scope = agentKeys.get(bearerToken(req.headers.authorization) || '');
    if (!scope) {
      if (hasBody(req)) res.setHeader('Connection', 'close');
      res.setHeader('WWW-Authenticate', 'Bearer realm="cysu-engine-agent"');
      return send(res, 401, { error: 'This engine address needs the stage\'s engine key: cysu engine --token "$CYSU_ENGINE_TOKEN" …' });
    }
    if (hasBody(req)) res.setHeader('Connection', 'close'); // never read: every route is GET
    if (path.startsWith('/api/')) return await agentApi(req, res, path, scope);
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    if (!error.status) console.error(error);
    if (res.headersSent) return res.end();
    send(res, error.status || 500, { error: error.status ? error.message : 'Internal error' });
  }
});
async function listenForAgents(ip) {
  if (agentServer && agentAddress === ip) return;
  if (agentServer) { await new Promise((resolve) => agentServer.close(resolve)); agentServer = null; }
  const next = agentServerFor(ip);
  await new Promise((resolve, reject) => { next.once('error', reject); next.listen(AGENT_PORT, ip, resolve); });
  agentServer = next; agentAddress = ip;
  console.log(`engine linked: agents can reach the engine at http://${ip}:${AGENT_PORT}`);
}

server.listen(PORT, HOST, () => {
  console.log(`cysu-engine listening on http://${HOST}:${PORT}`);
});

// Ctrl-C / stop: cancel the active run so its container does not keep going.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    server.close();
    agentServer?.close();
    scheduler.stop();
    await runs.close();
    process.exit(0);
  });
}
