// The assistant with a REAL model's behaviour: Codex's default model name, so
// Codex uses Code Mode (one `exec` tool running JavaScript; engine tools are
// tools.mcp__cysu_engine__<name>). A user reported "the agent can't see the
// Cyber Supplies tools" + "Code Mode is unavailable"; these tests pin the fix.
// Needs Docker + both images (npm run image:build && npm run image:build:test).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeApi } from './fixtures/fake-api.js';
import { startFakeLlm } from './fixtures/fake-llm.js';

const TOKEN = 'codemode-test-token-71ab';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENGINE_TOOLS = ['cancel_run', 'get_chatgpt_login_status', 'get_profile', 'get_proposal', 'get_run', 'get_setup_status', 'get_stage_activity',
  'get_stage_log', 'list_profiles', 'list_runs', 'list_saved_setups', 'plan_profile_change', 'plan_run', 'propose_profile_change', 'propose_rerun',
  'propose_run', 'start_chatgpt_login'];

let api, llm, dir, server, base, chatId;
before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  llm = await startFakeLlm(gw);
  dir = await mkdtemp(join(tmpdir(), 'cysu-cm-'));
  const port = 23000 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test',
      CYSU_ENGINE_AGENT_IMAGE: 'cysu-engine-workspace:dev', CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1',
      CYSU_ENGINE_TEST_LLM_CONFIG: llm.codexConfig({ codeMode: true }) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  await http('/api/settings', 'PUT', { token: TOKEN, passkey: 'pk', globalProfile: 'global', llm: { mode: 'openai-api-key', apiKey: 'sk-codemode-test' } });
  chatId = (await http('/api/chats', 'POST', {})).body.id;
});
after(async () => {
  server?.kill('SIGINT');
  await sleep(2000);
  api?.server.close();
  llm?.server.close();
  await rm(dir, { recursive: true, force: true });
});

function http(path, method = 'GET', body) {
  return fetch(`${base}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
}
async function say(text) {
  const before = (await http(`/api/chats/${chatId}`)).body.messages.length;
  const sent = await http(`/api/chats/${chatId}/messages`, 'POST', { text });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  for (let i = 0; i < 300; i++) {
    const chat = (await http(`/api/chats/${chatId}`)).body;
    if (chat.status === 'idle') return chat.messages.slice(before);
    await sleep(400);
  }
  throw new Error('assistant did not finish');
}
const lastExecOutput = () => {
  const out = llm.requests.at(-1).body.input.filter((i) => i.type === 'custom_tool_call_output').at(-1);
  return out.output.map((o) => o.text).join(' ');
};

test('Code Mode is really in use, and works (no "code-mode host is disabled")', async () => {
  const msgs = await say('hello');
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'agent'], JSON.stringify(msgs));
  const req = llm.requests.at(-1).body;
  assert.equal((req.tools || []).length, 0, 'expected Code Mode (no direct tools)');
  const extra = req.input.find((i) => i.type === 'additional_tools');
  assert.ok(extra?.tools.some((ns) => ns.tools?.some((t) => t.name === 'exec')), 'exec tool missing');
  assert.doesNotMatch(JSON.stringify(msgs), /Code Mode is unavailable/);
});

test('the instructions tell the model how to call the engine tools in Code Mode', () => {
  const req = llm.requests.at(-1).body;
  assert.match(JSON.stringify(req.input), /tools\.mcp__cysu_engine__plan_run/);
});

test('inside exec: exactly the engine tools + read-only helpers', async () => {
  await say('JS text(JSON.stringify(ALL_TOOLS.map((t) => t.name).sort()))');
  const names = JSON.parse(lastExecOutput().match(/\[.*\]/s)[0]);
  assert.deepEqual(names, [
    'apply_patch', 'clock__curr_time', 'list_mcp_resource_templates', 'list_mcp_resources',
    ...ENGINE_TOOLS.map((t) => `mcp__cysu_engine__${t}`), 'read_mcp_resource',
  ].sort());
});

test('engine tool calls work through exec, show in the chat, and link proposals', async () => {
  let msgs = await say('CALL get_setup_status {}');
  assert.deepEqual(msgs.map((m) => `${m.role}${m.tool ? `:${m.tool}` : ''}`), ['user', 'tool:get_setup_status', 'agent'], JSON.stringify(msgs));
  assert.equal(msgs[1].status, 'done');
  assert.match(msgs[2].text, /"ready":true/);

  msgs = await say('CALL propose_run {"request":{"prompt":"p","fromTags":{"skip":["3","4"]}},"summary":"via code mode"}');
  const tool = msgs.find((m) => m.tool === 'propose_run');
  assert.ok(tool?.proposalId, JSON.stringify(msgs));
  assert.equal((await http('/api/proposals')).body.find((p) => p.id === tool.proposalId).status, 'pending');
  assert.deepEqual((await http('/api/runs')).body, [], 'nothing runs before Approve');
});

test('the JavaScript sandbox has no network, modules or process; file writes are blocked', async () => {
  await say('JS const o={fetch:typeof fetch,require:typeof require,process:typeof process,Deno:typeof Deno};try{await tools.apply_patch("*** Begin Patch\\n*** Add File: /workspace/x.txt\\n+x\\n*** End Patch\\n");o.patch="WROTE"}catch(e){o.patch=String(e).slice(0,120)}text(JSON.stringify(o))');
  const result = JSON.parse(lastExecOutput().match(/\{.*\}/s)[0]);
  assert.deepEqual([result.fetch, result.require, result.process, result.Deno], ['undefined', 'undefined', 'undefined', 'undefined']);
  assert.match(result.patch, /read-only sandbox/);
});
