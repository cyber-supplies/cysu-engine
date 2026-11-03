// The assistant chat (main agent): REAL Codex in a hardened container, a
// stand-in LLM (scripted tool calls), the real engine + agent socket, and the
// stand-in Cyber Supplies API.
// Needs Docker + both images (npm run image:build && npm run image:build:test).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeApi } from './fixtures/fake-api.js';
import { startFakeLlm } from './fixtures/fake-llm.js';
import { hardeningArgs } from '../server/docker.js';

const TOKEN = 'usr_chat-test-token-4b2e';
const PASSKEY = 'chat-test-passkey-8c1d';
const API_KEY = 'sk-chat-test-3f9a0b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let api, llm, dir, server, base;
before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  llm = await startFakeLlm(gw);
  dir = await mkdtemp(join(tmpdir(), 'cysu-chat-'));
  const port = 22000 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test',
      CYSU_ENGINE_AGENT_IMAGE: 'cysu-engine-workspace:dev', CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1',
      CYSU_ENGINE_TEST_LLM_CONFIG: llm.codexConfig() },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) return;
    await sleep(200);
  }
  throw new Error('engine did not start');
});
after(async () => {
  server?.kill('SIGINT');
  await sleep(2000);
  api?.server.close();
  llm?.server.close();
  await rm(dir, { recursive: true, force: true });
});

const http = (path, method = 'GET', body) => fetch(`${base}${path}`, {
  method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));

async function say(chatId, text, { ms = 120_000 } = {}) {
  const sent = await http(`/api/chats/${chatId}/messages`, 'POST', { text });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const end = Date.now() + ms;
  for (;;) {
    const chat = (await http(`/api/chats/${chatId}`)).body;
    if (chat.status === 'idle') return chat;
    if (Date.now() > end) throw new Error('assistant did not finish');
    await sleep(400);
  }
}
const after_ = (chat, n) => chat.messages.slice(n);

let chat;
test('the assistant needs the user\'s LLM login first', async () => {
  chat = (await http('/api/chats', 'POST', {})).body;
  assert.equal(chat.title, 'New chat');
  const r = await http(`/api/chats/${chat.id}/messages`, 'POST', { text: 'hi' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Log in to your LLM first/);
  await http('/api/settings', 'PUT', { token: TOKEN, passkey: PASSKEY, globalProfile: 'global', llm: { mode: 'openai-api-key', apiKey: API_KEY } });
});

test('a first message: real Codex answers through the stand-in LLM', async () => {
  const before = llm.requests.length;
  const done = await say(chat.id, 'hello there');
  const msgs = after_(done, 0);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'agent'], JSON.stringify(msgs));
  assert.equal(msgs[1].text, 'echo: hello there');
  assert.ok(done.threadId, 'conversation id kept');
  assert.equal(done.title, 'hello there');
  assert.ok(llm.requests.length > before);
});

test('the model is offered ONLY the engine tools (no shell, files, web, sub-agents)', () => {
  const req = llm.requests.at(-1).body;
  const top = req.tools.map((t) => t.name || t.type).sort();
  assert.deepEqual(top, ['list_mcp_resource_templates', 'list_mcp_resources', 'mcp__cysu_engine', 'read_mcp_resource', 'request_user_input']);
  const engineTools = req.tools.find((t) => t.name === 'mcp__cysu_engine').tools.map((t) => t.name);
  assert.equal(engineTools.length, 12, 'the shipped assistant tools (workspaces + results)');
  for (const off of ['propose_run', 'propose_profile_change', 'cancel_run']) assert.ok(!engineTools.includes(off), `${off} must be off`);
  for (const forbidden of ['exec_command', 'shell', 'write_stdin', 'apply_patch', 'web_search', 'view_image', 'multi_agent_v1', 'image_generation']) {
    assert.ok(!JSON.stringify(req.tools.map((t) => t.name)).includes(`"${forbidden}"`), `${forbidden} offered`);
  }
  const instructions = JSON.stringify(req.input);
  assert.match(instructions, /Cyber Supplies Engine assistant/, 'the engine instructions (AGENTS.md) reach the model');
  assert.match(instructions, /Never ask for secrets/);
});

test('tool calls go through the engine; results come back to the model', async () => {
  const n = (await http(`/api/chats/${chat.id}`)).body.messages.length;
  const done = await say(chat.id, 'CALL get_setup_status {}');
  const msgs = after_(done, n);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'tool', 'agent'], JSON.stringify(msgs));
  assert.deepEqual([msgs[1].tool, msgs[1].status], ['get_setup_status', 'done']);
  assert.match(msgs[1].result, /"ready": true/);
  assert.match(msgs[2].text, /^Done\. .*"ready"/s);
});

test('the conversation continues: the second turn sees the first (session restored)', () => {
  const req = llm.requests.at(-1).body;
  assert.match(JSON.stringify(req.input), /hello there/, 'earlier message missing: conversation not restored');
});

test('the assistant builds a workspace from the chat; nothing runs until the user /runs it', async () => {
  const n = (await http(`/api/chats/${chat.id}`)).body.messages.length;
  const done = await say(chat.id, 'CALL plan_run {"request":{"prompt":"from chat","fromTags":{"skip":["3","4"]}}}\nCALL create_workspace {"name":"Chat recon","request":{"prompt":"from chat","fromTags":{"skip":["3","4"]}}}');
  const msgs = after_(done, n);
  assert.deepEqual(msgs.map((m) => `${m.role}${m.tool ? `:${m.tool}` : ''}`), ['user', 'tool:plan_run', 'tool:create_workspace', 'agent']);
  assert.equal(msgs[2].status, 'done', msgs[2].result);
  assert.match(msgs[3].text, /Start it with: \/run Chat recon/);
  assert.deepEqual((await http('/api/workspaces')).body.map((w) => w.name), ['Chat recon']);
  assert.deepEqual((await http('/api/runs')).body, [], 'the assistant must not start runs');
});

test('CLI chat feed: "messages after N" waits for news and only sends finished tool steps', async () => {
  const start = (await http(`/api/chats/${chat.id}`)).body.messages.length;
  const sent = await http(`/api/chats/${chat.id}/messages`, 'POST', { text: 'CALL list_workspaces {}' });
  assert.equal(sent.status, 202);
  let after = start;
  const got = [];
  for (let i = 0; i < 60; i++) {
    const t = Date.now();
    const page = (await http(`/api/chats/${chat.id}/messages?after=${after}&wait=10000`)).body;
    for (const m of page.messages) {
      assert.notEqual(m.status, 'running', 'a running tool step must not be sent');
      assert.equal(m.index, after + page.messages.indexOf(m));
      got.push(m);
    }
    after = page.next;
    if (page.status === 'idle' && !page.messages.length) break;
    if (page.status === 'thinking') assert.ok(page.messages.length || Date.now() - t >= 9_000, 'returned early with nothing new');
  }
  assert.deepEqual(got.map((m) => `${m.role}${m.tool ? `:${m.tool}:${m.status}` : ''}`), ['user', 'tool:list_workspaces:done', 'agent']);
  const idle = (await http(`/api/chats/${chat.id}/messages?after=${after}&wait=5000`)).body;
  assert.deepEqual([idle.messages, idle.status], [[], 'idle'], 'idle chats answer at once');
});

test('built-in tools cannot be used even if the model tries (shell → rejected, nothing runs)', async () => {
  const n = (await http(`/api/chats/${chat.id}`)).body.messages.length;
  const done = await say(chat.id, 'CALL exec_command {"cmd":"touch /tmp/pwned && id"}');
  const req = llm.requests.at(-1).body;
  const out = req.input.filter((i) => i.type === 'function_call_output').at(-1);
  assert.match(JSON.stringify(out.output), /unsupported call/, `Codex ran it? ${JSON.stringify(out)}`);
  // Resumed turns are just as locked down as the first one.
  assert.deepEqual(req.tools.map((t) => t.name || t.type).sort(), ['list_mcp_resource_templates', 'list_mcp_resources', 'mcp__cysu_engine', 'read_mcp_resource', 'request_user_input']);
  assert.ok(!after_(done, n).some((m) => m.role === 'tool'), 'no tool ran');
});

test('Stop ends a turn that is taking long', async () => {
  const sent = await http(`/api/chats/${chat.id}/messages`, 'POST', { text: 'SLOW please' });
  assert.equal(sent.status, 202);
  assert.equal((await http(`/api/chats/${chat.id}/messages`, 'POST', { text: 'again' })).status, 409, 'one turn at a time');
  await sleep(4000);
  const stopped = await http(`/api/chats/${chat.id}/stop`, 'POST');
  assert.equal(stopped.status, 202);
  let c;
  for (let i = 0; i < 60; i++) { c = (await http(`/api/chats/${chat.id}`)).body; if (c.status === 'idle') break; await sleep(500); }
  assert.equal(c.status, 'idle');
  assert.equal(c.messages.at(-1).text, 'Stopped.');
  const left = await new Promise((resolve) => execFile('docker', ['ps', '-aq', '--filter', `name=cysu-chat-${chat.id.slice(0, 8)}`], (e, o) => resolve(o.trim())));
  assert.equal(left, '', 'chat container left behind');
});

test('no secret ever lands in the chat, its log or its saved conversation', async () => {
  const folder = join(dir, 'chats', chat.id);
  for (const f of await readdir(folder)) {
    const text = (await readFile(join(folder, f))).toString('latin1');
    for (const secret of [TOKEN, PASSKEY]) assert.ok(!text.includes(secret), `${secret} in ${f}`);
    if (f !== 'sessions.tar') assert.ok(!text.includes(API_KEY), `API key in ${f}`);
  }
  const list = (await http('/api/chats')).body;
  assert.equal(list[0].id, chat.id);
});

test('the main-agent container gets NO Cyber Supplies token or key, even if sent', async () => {
  const secrets = JSON.stringify({ token: TOKEN, passphrase: PASSKEY, openaiApiKey: API_KEY, message: 'x' });
  const out = await new Promise((resolve) => {
    const child = execFile('docker', ['run', '--rm', '-i', ...hardeningArgs(), '-e', 'CYSU_ROLE=main-agent', '-e', 'CYSU_SECRETS=stdin', 'cysu-engine-workspace:dev',
      'sh', '-c', 'env | grep -c CYSU_TOKEN; ls ~/.config/cysu/master.key 2>&1 | head -1; test -f ~/.codex/auth.json && echo llm-login-present'],
    (e, stdout) => resolve(stdout));
    child.stdin.end(`${secrets}\n`);
  });
  const [tokenCount, keyLine, llmLine] = out.trim().split('\n');
  assert.equal(tokenCount, '0', 'CYSU_TOKEN must not be in the main agent env');
  assert.match(keyLine, /No such file/, 'no encryption key for the main agent');
  assert.equal(llmLine, 'llm-login-present');
});

test('delete a chat', async () => {
  assert.equal((await http(`/api/chats/${chat.id}`, 'DELETE')).status, 204);
  assert.equal((await http(`/api/chats/${chat.id}`)).status, 404);
});
