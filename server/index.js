// cysu-engine server: the engine's JSON API, used by the cysu CLI
// (documented in openapi.yaml). No web UI. Zero dependencies.
// Same machine only: it listens on 127.0.0.1 and rejects requests that come
// from web pages on other sites or through other host names (DNS rebinding).
// Every request needs the engine token (the user's Cyber Supplies user
// token, set at setup): see auth.js and the request handler at the bottom.

import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, load, save } from './store.js';
import { dockerAvailable, IMAGE } from './docker.js';
import { startCodexLogin, cancelCodexLogin, codexLoginState, codexAuthInfo, loadCodexAuth, forgetCodexAuth } from './llm.js';
import { Runs } from './runs.js';
import { API_URL, STAGE_TAGS, fetchProfiles } from './profiles.js';
import { Workspaces } from './workspaces.js';
import { bearerToken, sameToken, UNAUTHORIZED, oneAtATime, AuthLimiter, tooManyMessage } from './auth.js';

const ENGINE_VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const defaultSettings = { token: '', passkey: '', llm: { mode: 'none', apiKey: '' }, globalProfile: '' };

const runs = new Runs({
  dir: join(DATA_DIR, 'runs'),
  getSecrets: async () => {
    const settings = await load('settings', defaultSettings);
    return { settings, codexAuth: settings.llm?.mode === 'codex' ? await loadCodexAuth() : null };
  },
  listProfiles: (settings) => fetchProfiles(settings.token),
});

const workspaces = new Workspaces();

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
    const p = await runs.plan(ws.request);
    plan = { stages: p.stages.map((st) => ({ order: st.index + 1, tag: st.tag, profile: st.profile, model: st.model || 'default' })), globalProfile: p.globalProfile || '' };
  } catch (error) { planError = error.message; }
  return { ...ws, plan, planError };
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

  // Profiles come from the user's Cyber Supplies account via the gateway.
  if (path === '/api/profiles' && req.method === 'GET') return send(res, 200, await fetchProfiles(settings.token));

  // ---- workspaces (/workspace, /load, /run in the CLI) ----------------------
  // {id} is the workspace's exact id (names are labels only).
  if (path === '/api/workspaces') {
    if (req.method === 'GET') return send(res, 200, await workspaces.list());
    if (req.method === 'POST') {
      const input = await body(req);
      return send(res, 201, await workspaces.create({ name: input.name, request: input.request ?? { prompt: '', stages: [] } }));
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
    if (req.method === 'DELETE') { await workspaces.delete(id); res.writeHead(204); return res.end(); }
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
    return send(res, 201, await runs.create({ name: ws.name, ...ws.request, workspace: { id: ws.id, name: ws.name } }));
  }

  // ---- runs ----------------------------------------------------------------
  if (path === '/api/runs') {
    if (req.method === 'GET') return send(res, 200, await runs.list());
    if (req.method === 'POST') {
      if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
      return send(res, 201, await runs.create(await body(req)));
    }
  }
  if (path === '/api/runs/plan' && req.method === 'POST') return send(res, 200, await runs.plan(await body(req)));
  // Run routes accept the full id or a short prefix (the CLI shows 8 characters).
  m = path.match(/^\/api\/runs\/([\w-]+)(\/.*)?$/);
  if (m && m[1] !== 'plan') {
    const id = await runs.resolve(m[1]);
    const rest = m[2] || '';
    if (rest === '' && req.method === 'GET') return send(res, 200, await runs.get(id));
    if (rest === '' && req.method === 'DELETE') { await runs.delete(id); res.writeHead(204); return res.end(); }
    if (rest === '/cancel' && req.method === 'POST') return send(res, 202, await runs.cancel(id));
    if (rest === '/rerun' && req.method === 'POST') {
      if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
      return send(res, 201, await runs.rerun(id));
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

server.listen(PORT, HOST, () => {
  console.log(`cysu-engine listening on http://${HOST}:${PORT}`);
});

// Ctrl-C / stop: cancel the active run so its container does not keep going.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    server.close();
    await runs.close();
    process.exit(0);
  });
}
