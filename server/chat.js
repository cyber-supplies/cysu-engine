// chat.js: the main agent (assistant) chat.
//
// Each user message is one "turn": a fresh hardened container (CYSU_ROLE=
// main-agent) with only the user's LLM login and the engine's agent socket
// mounted. Codex there can use ONLY the engine tools (see image/main-agent.sh).
// The conversation (Codex's session files) is copied out after every turn and
// handed back to the next one, so containers stay throwaway.
//
//   <dir>/<chat id>/chat.json      title, thread, messages
//   <dir>/<chat id>/sessions.tar   Codex conversation (restored each turn)
//   <dir>/<chat id>/log.txt        container logs (debugging)

import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, rename, writeFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hardeningArgs, IMAGE, LABEL, removeContainer, copyFileFromContainer } from './docker.js';
import { keepRefreshedCodexAuth } from './llm.js';
import { cleanText } from './runs.js';

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MESSAGE = 20_000;
const MAX_MESSAGES = 2_000;

export class ChatError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function writeJson(file, value) {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

function dockerTar(name, path) {
  return new Promise((resolve) => {
    execFile('docker', ['cp', `${name}:${path}`, '-'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// toolSummary: a short, human line for a tool call's arguments / result.
function toolText(item) {
  const args = item.arguments && Object.keys(item.arguments).length ? clip(JSON.stringify(item.arguments), 300) : '';
  return args;
}
function toolResult(item) {
  if (item.error) return { ok: false, text: clip(String(item.error.message || item.error), 500) };
  const text = (item.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  let data = item.result?.structured_content ?? item.result?.structuredContent ?? null;
  if (!data) { try { data = JSON.parse(text); } catch { data = null; } } // our bridge sends the result as JSON text
  return { ok: true, text: clip(text, 1500), data };
}

export class Chats {
  // getSecrets: async () => ({ settings, codexAuth }); socketPath: the agent socket.
  // agentVolume: when the engine itself runs in a container, the socket lives
  // in this named Docker volume (mounted at /run/cysu-engine in both the
  // engine and the assistant's container); a host path would mean nothing to
  // the host's Docker, and sockets do not cross Docker Desktop file shares.
  constructor({ dir, getSecrets, socketPath, agentVolume = '', image = IMAGE, extraEnv = {} }) {
    this.agentVolume = agentVolume;
    this.dir = dir;
    this.getSecrets = getSecrets;
    this.socketPath = socketPath;
    this.image = image;
    this.extraEnv = extraEnv;
    this.active = new Map(); // chat id → { container, stopped }
    this.saving = new Map();
  }

  folder(id) {
    if (!CHAT_ID.test(id)) throw new ChatError(404, 'Chat not found');
    return join(this.dir, id);
  }

  async read(id) {
    try { return JSON.parse(await readFile(join(this.folder(id), 'chat.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new ChatError(404, 'Chat not found'); throw error; }
  }
  async save(chat) {
    chat.updatedAt = new Date().toISOString();
    // Serialize saves per chat (events arrive quickly).
    const prev = this.saving.get(chat.id) || Promise.resolve();
    const next = prev.then(() => writeJson(join(this.folder(chat.id), 'chat.json'), chat)).catch(() => {});
    this.saving.set(chat.id, next);
    return next;
  }

  async recover() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !CHAT_ID.test(entry.name)) continue;
      const chat = await this.read(entry.name).catch(() => null);
      if (chat?.status !== 'thinking') continue;
      chat.status = 'idle';
      chat.messages.push({ id: randomUUID(), role: 'notice', text: 'The engine stopped while the assistant was answering.', time: new Date().toISOString() });
      await this.save(chat);
    }
  }

  async list() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const chats = [];
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !CHAT_ID.test(entry.name)) continue;
      const chat = await this.read(entry.name).catch(() => null);
      if (chat) chats.push({ id: chat.id, title: chat.title, status: chat.status, createdAt: chat.createdAt, updatedAt: chat.updatedAt, messageCount: chat.messages.length });
    }
    return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create({ title } = {}) {
    const now = new Date().toISOString();
    const chat = { id: randomUUID(), title: String(title || '').trim().slice(0, 120) || 'New chat', createdAt: now, updatedAt: now, threadId: null, status: 'idle', turns: 0, messages: [] };
    await mkdir(this.folder(chat.id), { recursive: true, mode: 0o700 });
    await this.save(chat);
    return chat;
  }

  async get(id) { return this.read(id); }

  async delete(id) {
    await this.read(id);
    if (this.active.has(id)) throw new ChatError(409, 'Stop the assistant before deleting this chat');
    await rm(this.folder(id), { recursive: true, force: true });
  }

  async stop(id) {
    const active = this.active.get(id);
    if (!active) throw new ChatError(409, 'The assistant is not answering');
    active.stopped = true;
    await new Promise((resolve) => execFile('docker', ['stop', '-t', '5', active.container], () => resolve()));
  }

  // send adds the user's message and starts a turn in the background.
  async send(id, text) {
    text = String(text ?? '');
    if (!text.trim()) throw new ChatError(400, 'Write a message first');
    if (text.length > MAX_MESSAGE) throw new ChatError(400, `Messages are limited to ${MAX_MESSAGE.toLocaleString()} characters`);
    const chat = await this.read(id);
    if (this.active.has(id) || chat.status === 'thinking') throw new ChatError(409, 'The assistant is still answering');
    if (chat.messages.length >= MAX_MESSAGES) throw new ChatError(409, 'This chat is full; start a new one');
    const { settings, codexAuth } = await this.getSecrets();
    const llm = settings.llm || {};
    if (!((llm.mode === 'openai-api-key' && llm.apiKey) || (llm.mode === 'codex' && codexAuth))) {
      throw new ChatError(400, 'Log in to your LLM first: sign in with ChatGPT (Codex) or add an OpenAI API key in Setup');
    }

    chat.messages.push({ id: randomUUID(), role: 'user', text, time: new Date().toISOString() });
    if (chat.title === 'New chat') chat.title = clip(text.replace(/\s+/g, ' ').trim(), 60);
    chat.status = 'thinking';
    chat.turns += 1;
    await this.save(chat);

    const container = `cysu-chat-${id.slice(0, 8)}-${chat.turns}`;
    const active = { container, stopped: false };
    this.active.set(id, active);
    active.done = this.turn(chat, text, { settings, codexAuth }, active)
      .catch((error) => console.error(`chat ${id}:`, error))
      .finally(() => this.active.delete(id));
    return structuredClone(chat);
  }

  async turn(chat, text, { settings, codexAuth }, active) {
    const folder = this.folder(chat.id);
    const logLine = (line) => appendFile(join(folder, 'log.txt'), `${line}\n`, { mode: 0o600 }).catch(() => {});
    const push = (msg) => { chat.messages.push({ id: randomUUID(), time: new Date().toISOString(), ...msg }); this.save(chat); };

    let sessions = null;
    try { sessions = await readFile(join(folder, 'sessions.tar')); } catch { /* first turn */ }
    const secrets = { message: text };
    if (settings.llm?.mode === 'codex' && codexAuth) secrets.codexAuth = codexAuth;
    else secrets.openaiApiKey = settings.llm.apiKey;
    if (sessions) secrets.codexSessions = sessions.toString('base64');

    const socketInContainer = this.agentVolume ? `/run/cysu-engine/${this.socketPath.split('/').pop()}` : '/run/cysu-engine.sock';
    const env = { CYSU_ROLE: 'main-agent', CYSU_SECRETS: 'stdin', CYSU_ENGINE_SOCKET: socketInContainer, ...this.extraEnv };
    if (chat.threadId) env.CYSU_CHAT_THREAD = chat.threadId;
    if (settings.agentModel) env.CYSU_CHAT_MODEL = settings.agentModel;
    if (process.env.CYSU_ENGINE_TEST_NO_FIREWALL === '1') env.CYSU_EGRESS_GUARD = '0';
    const args = ['run', '-i', '--name', active.container, '--label', `${LABEL}=chat`, ...hardeningArgs(),
      '-v', this.agentVolume ? `${this.agentVolume}:/run/cysu-engine` : `${this.socketPath}:/run/cysu-engine.sock`];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(this.image);

    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify(secrets)}\n`);

    const tools = new Map(); // Codex item id → chat message
    let answered = false;
    const stdout = (async () => {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        let e;
        try { e = JSON.parse(line); } catch { logLine(line); continue; }
        const it = e.item || {};
        if (e.type === 'thread.started' && typeof e.thread_id === 'string') { chat.threadId = e.thread_id; this.save(chat); }
        else if (e.type === 'item.completed' && it.type === 'agent_message') { answered = true; push({ role: 'agent', text: String(it.text || '') }); }
        else if ((e.type === 'item.started' || e.type === 'item.completed') && it.type === 'mcp_tool_call') {
          let msg = tools.get(it.id);
          if (!msg) {
            msg = { id: randomUUID(), time: new Date().toISOString(), role: 'tool', tool: String(it.tool || ''), text: toolText(it), status: 'running' };
            tools.set(it.id, msg);
            chat.messages.push(msg);
          }
          if (e.type === 'item.completed') {
            const r = toolResult(it);
            msg.status = r.ok && it.status !== 'failed' ? 'done' : 'failed';
            msg.result = r.text;
            if (r.data?.proposalId) msg.proposalId = r.data.proposalId;
          }
          this.save(chat);
        } else if (e.type === 'turn.failed') push({ role: 'error', text: String(e.error?.message || 'The assistant failed') });
        else if (e.type === 'error') push({ role: 'error', text: String(e.message || 'Error') });
        else if (e.type === 'item.completed' && it.type === 'error' && !/^Model metadata for/.test(it.message || '')) push({ role: 'error', text: String(it.message || 'Error') });
      }
    })();
    const stderr = (async () => { for await (const line of createInterface({ input: child.stderr, crlfDelay: Infinity })) logLine(line); })();
    const code = await new Promise((resolve) => { child.on('error', () => resolve(-1)); child.on('close', resolve); });
    await Promise.allSettled([stdout, stderr]);

    // Keep the conversation (and a refreshed ChatGPT login) for the next turn.
    const tar = await dockerTar(active.container, '/home/runner/.codex/sessions');
    if (tar?.length) await writeFile(join(folder, 'sessions.tar'), tar, { mode: 0o600 });
    if (settings.llm?.mode === 'codex' && codexAuth) {
      const raw = await copyFileFromContainer(active.container, '/home/runner/.codex/auth.json');
      let refreshed = null;
      try { refreshed = raw && JSON.parse(raw.toString('utf8')); } catch { /* ignore */ }
      await keepRefreshedCodexAuth(codexAuth, refreshed);
    }
    await removeContainer(active.container);

    for (const msg of tools.values()) if (msg.status === 'running') msg.status = 'failed';
    if (active.stopped) push({ role: 'notice', text: 'Stopped.' });
    else if (code !== 0 && !answered) push({ role: 'error', text: `The assistant stopped unexpectedly (exit ${code}). The log has details.` });
    chat.status = 'idle';
    await this.save(chat);
  }

  // messages: what the CLI prints. Messages from index `after` on, waiting up
  // to `wait` ms for something new while the assistant is answering. A tool
  // step is sent once it has finished (so it is printed once, complete); the
  // returned `next` stops before it until then. Text is cleaned for terminals.
  async messages(id, { after = 0, wait = 0 } = {}) {
    const deadline = Date.now() + Math.min(25_000, Math.max(0, Number(wait) || 0));
    const from = Math.max(0, Number(after) || 0);
    for (;;) {
      const chat = await this.read(id);
      let end = chat.messages.length;
      const running = chat.messages.findIndex((m, i) => i >= from && m.role === 'tool' && m.status === 'running');
      if (running >= 0) end = running;
      const messages = chat.messages.slice(from, end).map((m, i) => ({
        index: from + i, ...m,
        ...(m.text !== undefined ? { text: cleanText(m.text) } : {}),
        ...(m.result !== undefined ? { result: cleanText(m.result) } : {}),
      }));
      if (messages.length || chat.status !== 'thinking' || Date.now() >= deadline) {
        return { messages, next: end, status: chat.status, title: chat.title };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async log(id) {
    await this.read(id);
    try { return await readFile(join(this.folder(id), 'log.txt'), 'utf8'); } catch { return ''; }
  }

  async close() {
    for (const [id] of this.active) await this.stop(id).catch(() => {});
    for (const a of [...this.active.values()]) await a.done;
  }
}
