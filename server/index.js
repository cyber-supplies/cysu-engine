// cysu-engine server: the engine's JSON API, used by the cysu CLI
// (documented in openapi.yaml). No web UI. Zero dependencies.
// Same machine only: it listens on 127.0.0.1 and rejects requests that come
// from web pages on other sites or through other host names (DNS rebinding).

import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, load, save } from './store.js';
import { dockerAvailable, IMAGE } from './docker.js';
import { startCodexLogin, cancelCodexLogin, codexLoginState, codexAuthInfo, loadCodexAuth, forgetCodexAuth } from './llm.js';
import { Runs } from './runs.js';
import { API_URL, fetchProfiles } from './profiles.js';
import { Proposals } from './agent-tools.js';
import { startAgentSocket } from './agent-socket.js';
import { readProfile, planChange, applyApproved, redact } from './profile-edits.js';
import { Chats } from './chat.js';
import { Workspaces } from './workspaces.js';

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

const proposals = new Proposals();
const workspaces = new Workspaces();

// workspaceView: a workspace plus the stages it would run now (or why not).
async function workspaceView(ws) {
  const current = await workspaces.current();
  let plan = null; let planError = null;
  try {
    const p = await runs.plan(ws.request);
    plan = { stages: p.stages.map((st) => ({ order: st.index + 1, tag: st.tag, profile: st.profile, model: st.model || 'default' })), globalProfile: p.globalProfile || '' };
  } catch (error) { planError = error.message; }
  return { ...ws, current: ws.id === current?.id, plan, planError };
}

async function engineStatus() {
  const settings = await load('settings', defaultSettings);
  const llmMode = settings.llm?.mode || 'none';
  const llmReady = Boolean((llmMode === 'openai-api-key' && settings.llm?.apiKey) || (llmMode === 'codex' && (await codexAuthInfo()).saved));
  const cysuReady = Boolean(settings.token && settings.passkey);
  return {
    version: ENGINE_VERSION, docker: await dockerAvailable(), image: IMAGE, apiUrl: API_URL,
    cysu: cysuReady, llm: { mode: llmMode, ready: llmReady, model: settings.agentModel || '' },
    configured: cysuReady && llmReady, // everything a run needs is set up
    workspace: (await workspaces.current())?.name ?? null, // the current workspace (CLI prompt)
  };
}

// What the main agent's tools can use (see agent-tools.js for the rules).
const agentContext = {
  runs, proposals,
  getStatus: engineStatus,
  fetchProfiles: async () => fetchProfiles((await load('settings', defaultSettings)).token),
  llm: { start: () => startCodexLogin(), state: () => codexLoginState() },
  workspaces,
  listSetups: () => workspaces.list(),
  profiles: {
    read: async (id) => redact(await readProfile((await load('settings', defaultSettings)).token, id)),
    plan: async (change) => planChange((await load('settings', defaultSettings)).token, change),
  },
};

const mask = (v) => (v ? '••••' + String(v).slice(-4) : '');

const LLM_MODES = ['none', 'openai-api-key', 'codex'];

async function publicSettings(s) {
  return {
    token: mask(s.token),
    passkey: s.passkey ? 'set' : '',
    llm: { mode: s.llm?.mode || 'none', apiKey: mask(s.llm?.apiKey), codex: await codexAuthInfo() },
    globalProfile: s.globalProfile || '',
    agentModel: s.agentModel || '',
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
// The API has no login (same machine only; its only client is the cysu CLI), so:
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
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
  if (hasBody && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return 'Request bodies must be application/json';
  }
  return null;
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('Body too large'), { status: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

async function api(req, res, path) {
  const settings = await load('settings', defaultSettings);

  if (path === '/api/status' && req.method === 'GET') {
    return send(res, 200, await engineStatus());
  }

  if (path === '/api/settings') {
    if (req.method === 'GET') return send(res, 200, await publicSettings(settings));
    if (req.method === 'PUT') {
      const input = await body(req);
      // Empty fields mean "keep what is stored", so masked values never overwrite secrets.
      const next = { ...settings, llm: { ...settings.llm } };
      if (input.token) {
        // The engine works with a USER token (usr_…); LLM tokens cannot manage
        // profiles and workspaces.
        const token = String(input.token).trim();
        if (!token.startsWith('usr_')) return send(res, 400, { error: 'The engine needs your Cyber Supplies user token (it starts with usr_), not an LLM token' });
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
      // The model the assistant uses ("" = Codex's default).
      if (input.agentModel !== undefined) {
        const model = String(input.agentModel).trim();
        if (model && !/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) return send(res, 400, { error: 'Invalid model name' });
        next.agentModel = model;
      }
      await save('settings', next);
      return send(res, 200, await publicSettings(next));
    }
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
  // {ref} is a workspace name (URL-encoded), its id, or "current".
  if (path === '/api/workspaces') {
    if (req.method === 'GET') {
      const current = await workspaces.current();
      return send(res, 200, (await workspaces.list()).map((w) => ({ ...w, current: w.id === current?.id })));
    }
    if (req.method === 'POST') {
      const input = await body(req);
      const ws = await workspaces.create({ name: input.name, request: input.request ?? { prompt: '', stages: [] } });
      await workspaces.select(ws.id); // a new workspace becomes the current one
      return send(res, 201, { ...ws, current: true });
    }
  }
  let m = path.match(/^\/api\/workspaces\/([^/]+)$/);
  if (m) {
    const ref = decodeURIComponent(m[1]);
    if (req.method === 'GET') return send(res, 200, await workspaceView(await workspaces.get(ref)));
    if (req.method === 'PATCH') {
      const input = await body(req);
      return send(res, 200, await workspaceView(await workspaces.update(ref, { name: input.name, request: input.request })));
    }
    if (req.method === 'DELETE') { await workspaces.delete(ref); res.writeHead(204); return res.end(); }
  }
  m = path.match(/^\/api\/workspaces\/([^/]+)\/select$/);
  if (m && req.method === 'POST') return send(res, 200, await workspaceView(await workspaces.select(decodeURIComponent(m[1]))));
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
    const mine = new Set((await fetchProfiles(settings.token)).map((r) => r?.id));
    const unknown = [...add, ...(input.global ? [input.global] : [])].filter((id) => !mine.has(id));
    if (unknown.length) return send(res, 400, { error: `Not one of your profiles: ${unknown.join(', ')}` });
    const out = await workspaces.changeStages(decodeURIComponent(m[1]), { add, remove, global: input.global?.trim() });
    return send(res, 200, { ...(await workspaceView(out.workspace)), added: out.added, skipped: out.skipped, removed: out.removed });
  }
  m = path.match(/^\/api\/workspaces\/([^/]+)\/run$/);
  if (m && req.method === 'POST') {
    // /run: the USER starts a workspace (the assistant cannot).
    if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
    const ws = await workspaces.get(decodeURIComponent(m[1]));
    return send(res, 201, await runs.create({ name: ws.name, ...ws.request, workspace: { id: ws.id, name: ws.name } }));
  }

  // ---- assistant chat (the main agent) ------------------------------------
  if (path === '/api/chats') {
    if (req.method === 'GET') return send(res, 200, await chats.list());
    if (req.method === 'POST') return send(res, 201, await chats.create(await body(req)));
  }
  m = path.match(/^\/api\/chats\/([\w-]+)$/);
  if (m && req.method === 'GET') return send(res, 200, await chats.get(m[1]));
  if (m && req.method === 'DELETE') { await chats.delete(m[1]); res.writeHead(204); return res.end(); }
  m = path.match(/^\/api\/chats\/([\w-]+)\/messages$/);
  if (m && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    return send(res, 200, await chats.messages(m[1], { after: q.get('after'), wait: q.get('wait') }));
  }
  if (m && req.method === 'POST') {
    if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
    return send(res, 202, await chats.send(m[1], (await body(req)).text));
  }
  m = path.match(/^\/api\/chats\/([\w-]+)\/stop$/);
  if (m && req.method === 'POST') { await chats.stop(m[1]); return send(res, 202, await chats.get(m[1])); }
  m = path.match(/^\/api\/chats\/([\w-]+)\/log$/);
  if (m && req.method === 'GET') {
    const text = await chats.log(m[1]); // load first: a missing chat must still get a clean 404
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(text);
  }

  // ---- run proposals from the main agent (only the user decides) ---------
  if (path === '/api/proposals' && req.method === 'GET') return send(res, 200, proposals.list());
  m = path.match(/^\/api\/proposals\/([\w-]+)\/(approve|reject)$/);
  if (m && req.method === 'POST') {
    const proposal = proposals.get(m[1]);
    if (!proposal) return send(res, 404, { error: 'Proposal not found' });
    if (proposal.status !== 'pending') return send(res, 409, { error: `This proposal is ${proposal.status}` });
    if (m[2] === 'reject') {
      Object.assign(proposal, { status: 'rejected', decidedAt: new Date().toISOString() });
      return send(res, 200, proposal);
    }
    if (proposal.kind === 'profile') {
      try {
        const result = await applyApproved((await load('settings', defaultSettings)).token, proposal.change, proposal.baseHash);
        Object.assign(proposal, { status: 'approved', result, decidedAt: new Date().toISOString() });
        return send(res, 200, proposal);
      } catch (error) {
        // A profile that changed since the plan: the proposal cannot be applied any more.
        if (error.status === 409) Object.assign(proposal, { status: 'stale', error: error.message, decidedAt: new Date().toISOString() });
        throw error;
      }
    }
    if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
    // Run exactly what the user was shown: if the stages would differ now
    // (e.g. profiles were added or retagged since), the proposal is out of date.
    const now = await runs.plan(proposal.request);
    const shape = (plan) => JSON.stringify(plan.stages.map((st) => [st.profile, st.tag, st.model, st.fallbackModel, st.reprompts, st.globalProfile]));
    if (shape(now) !== shape(proposal.plan)) {
      const was = proposal.plan.stages.map((st) => st.profile).join(' → ');
      const is = now.stages.map((st) => st.profile).join(' → ');
      Object.assign(proposal, { status: 'stale', error: `Your profiles changed since this was proposed (was: ${was}; now: ${is}). Ask the assistant to propose again.`, decidedAt: new Date().toISOString() });
      return send(res, 409, { error: proposal.error });
    }
    const run = await runs.create({ ...proposal.request, ...(proposal.rerunOf ? { rerunOf: proposal.rerunOf } : {}) });
    Object.assign(proposal, { status: 'approved', runId: run.id, decidedAt: new Date().toISOString() });
    return send(res, 200, proposal);
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
    if (path.startsWith('/api/')) await api(req, res, path);
    else if (path === '/' && req.method === 'GET') send(res, 200, { name: 'cysu-engine', api: '/api', docs: 'openapi.yaml', ui: 'none: use the cysu CLI' });
    else send(res, 404, { error: 'Not found' });
  } catch (error) {
    if (!error.status) console.error(error);
    // A failure after the answer had started cannot change its status: end it
    // rather than throw (a throw here would stop the whole engine).
    if (res.headersSent) return res.end();
    send(res, error.status || 500, { error: error.status ? error.message : 'Internal error' });
  }
});
// The main agent's way in: only the agent tools, on a Unix socket.
const AGENT_SOCKET = process.env.CYSU_ENGINE_AGENT_SOCKET || join(DATA_DIR, 'agent.sock');
const chats = new Chats({
  dir: join(DATA_DIR, 'chats'),
  socketPath: AGENT_SOCKET,
  agentVolume: process.env.CYSU_ENGINE_AGENT_VOLUME || '', // set when the engine runs in a container
  image: process.env.CYSU_ENGINE_AGENT_IMAGE || IMAGE,
  getSecrets: async () => {
    const settings = await load('settings', defaultSettings);
    return { settings, codexAuth: settings.llm?.mode === 'codex' ? await loadCodexAuth() : null };
  },
  // Tests only: point the assistant's Codex at a stand-in LLM.
  extraEnv: process.env.CYSU_ENGINE_TEST_LLM_CONFIG ? { CYSU_CODEX_CONFIG_APPEND: process.env.CYSU_ENGINE_TEST_LLM_CONFIG } : {},
});
await chats.recover();
await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
const agentSocket = await startAgentSocket(AGENT_SOCKET, agentContext);
console.log(`agent tools on ${AGENT_SOCKET}`);

server.listen(PORT, HOST, () => {
  console.log(`cysu-engine listening on http://${HOST}:${PORT}`);
});

// Ctrl-C / stop: cancel the active run so its container does not keep going.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    server.close();
    agentSocket.close();
    await chats.close();
    await runs.close();
    process.exit(0);
  });
}
