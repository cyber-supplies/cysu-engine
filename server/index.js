// cysu-engine server: serves the web UI and the engine's JSON API
// (documented in openapi.yaml; the CLI builds on it). Zero dependencies.
// Same machine only: it listens on 127.0.0.1 and rejects requests that come
// from web pages on other sites or through other host names (DNS rebinding).

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, load, save } from './store.js';
import { dockerAvailable, IMAGE } from './docker.js';
import { startCodexLogin, cancelCodexLogin, codexLoginState, codexAuthInfo, loadCodexAuth, forgetCodexAuth } from './llm.js';
import { Runs } from './runs.js';
import { API_URL, fetchProfiles } from './profiles.js';
import { Proposals } from './agent-tools.js';
import { startAgentSocket } from './agent-socket.js';
import { readProfile, planChange, applyApproved, redact } from './profile-edits.js';
import { Chats } from './chat.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

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

async function engineStatus() {
  const settings = await load('settings', defaultSettings);
  const llmMode = settings.llm?.mode || 'none';
  const llmReady = Boolean((llmMode === 'openai-api-key' && settings.llm?.apiKey) || (llmMode === 'codex' && (await codexAuthInfo()).saved));
  const cysuReady = Boolean(settings.token && settings.passkey);
  return {
    docker: await dockerAvailable(), image: IMAGE, apiUrl: API_URL,
    cysu: cysuReady, llm: { mode: llmMode, ready: llmReady },
    configured: cysuReady && llmReady, // everything a run needs is set up
  };
}

// What the main agent's tools can use (see agent-tools.js for the rules).
const agentContext = {
  runs, proposals,
  getStatus: engineStatus,
  fetchProfiles: async () => fetchProfiles((await load('settings', defaultSettings)).token),
  llm: { start: () => startCodexLogin(), state: () => codexLoginState() },
  listSetups: async () => (await load('workflows', [])).filter((w) => w && w.request),
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
    configured: Boolean(s.token && s.passkey),
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Sent with every response. The page shows agent output, which is untrusted
// text; the UI only ever inserts it as text, and this policy is the backstop:
// no inline or foreign scripts, no framing, no requests to other sites.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// ---- same-machine protection -------------------------------------------------
// The API has no login (same machine only), so:
//  - Host must be a loopback name for this port: blocks DNS rebinding, where a
//    web page makes its own host name point at 127.0.0.1.
//  - A browser Origin, if sent, must be this engine: blocks other web pages
//    from driving the API. The CLI sends no Origin.
//  - Requests with a body must be JSON: plain HTML forms cannot send that.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `${HOST}:${PORT}`]);

function rejectForeign(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return 'Unexpected Host header; use http://127.0.0.1:' + PORT;
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, '').toLowerCase())) {
    return 'Cross-site requests are not allowed';
  }
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
      if (input.token) next.token = String(input.token).trim();
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

  // ---- saved run setups ("workflows", like Windmill's saved inputs) ------
  if (path === '/api/workflows') {
    const workflows = await load('workflows', []);
    if (req.method === 'GET') return send(res, 200, workflows.filter((w) => w && w.request));
    if (req.method === 'POST') {
      const input = await body(req);
      const name = String(input.name ?? '').trim().slice(0, 120);
      if (!name) return send(res, 400, { error: 'A saved setup needs a name' });
      if (!input.request || typeof input.request !== 'object' || Array.isArray(input.request)) {
        return send(res, 400, { error: 'request must be a run request object' });
      }
      const id = typeof input.id === 'string' && /^[\w-]{1,64}$/.test(input.id) ? input.id : randomUUID();
      const workflow = { id, name, request: input.request, updatedAt: new Date().toISOString() };
      await save('workflows', [...workflows.filter((w) => w?.id !== id && w?.request), workflow]);
      return send(res, 200, workflow);
    }
  }
  let m = path.match(/^\/api\/workflows\/([\w-]+)$/);
  if (m && req.method === 'DELETE') {
    const workflows = await load('workflows', []);
    await save('workflows', workflows.filter((w) => w?.id !== m[1] && w?.request));
    res.writeHead(204);
    return res.end();
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
  if (m && req.method === 'POST') {
    if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
    return send(res, 202, await chats.send(m[1], (await body(req)).text));
  }
  m = path.match(/^\/api\/chats\/([\w-]+)\/stop$/);
  if (m && req.method === 'POST') { await chats.stop(m[1]); return send(res, 202, await chats.get(m[1])); }
  m = path.match(/^\/api\/chats\/([\w-]+)\/log$/);
  if (m && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(await chats.log(m[1]));
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
  m = path.match(/^\/api\/runs\/([\w-]+)$/);
  if (m && req.method === 'GET') return send(res, 200, await runs.get(m[1]));
  if (m && req.method === 'DELETE') {
    await runs.delete(m[1]);
    res.writeHead(204);
    return res.end();
  }
  m = path.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
  if (m && req.method === 'POST') return send(res, 202, await runs.cancel(m[1]));
  m = path.match(/^\/api\/runs\/([\w-]+)\/rerun$/);
  if (m && req.method === 'POST') {
    if (!(await dockerAvailable())) return send(res, 503, { error: 'Docker is not available on this machine' });
    return send(res, 201, await runs.rerun(m[1]));
  }
  m = path.match(/^\/api\/runs\/([\w-]+)\/download$/);
  if (m && req.method === 'GET') {
    const { filename, data } = await runs.download(m[1]);
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
    return res.end(data);
  }
  m = path.match(/^\/api\/runs\/([\w-]+)\/stages\/(\d+)\/events$/);
  if (m && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    return send(res, 200, await runs.events(m[1], m[2], { after: q.get('after'), limit: q.get('limit') }));
  }
  m = path.match(/^\/api\/runs\/([\w-]+)\/stages\/(\d+)\/log$/);
  if (m && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(await runs.log(m[1], m[2]));
  }

  return send(res, 404, { error: 'Not found' });
}

async function staticFile(res, path) {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    // no-cache: the browser re-checks, so an updated engine never runs an old UI.
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
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
    else await staticFile(res, path);
  } catch (error) {
    send(res, error.status || 500, { error: error.status ? error.message : 'Internal error' });
    if (!error.status) console.error(error);
  }
});
// The main agent's way in: only the agent tools, on a Unix socket.
const AGENT_SOCKET = process.env.CYSU_ENGINE_AGENT_SOCKET || join(DATA_DIR, 'agent.sock');
const chats = new Chats({
  dir: join(DATA_DIR, 'chats'),
  socketPath: AGENT_SOCKET,
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
