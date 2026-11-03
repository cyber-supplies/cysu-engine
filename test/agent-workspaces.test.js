// The assistant's tools as shipped (DEFAULT_TOOLS): build workspaces from the
// user's own profiles, show run results. It cannot start runs, propose, or
// change profiles. Through the real MCP bridge + agent socket + engine;
// stand-in Cyber Supplies API and stand-in Codex for the runs.
// Needs Docker + both images (npm run image:build && npm run image:build:test).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeApi } from './fixtures/fake-api.js';

const TOKEN = 'usr_ws-test-token-5e1c';
const PASSKEY = 'ws-test-passkey-0d9f';
const API_KEY = 'sk-ws-test-77aa';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHIPPED = ['create_workspace', 'get_profile', 'get_run', 'get_setup_status', 'get_stage_activity', 'get_stage_log', 'get_workspace',
  'list_profiles', 'list_runs', 'list_workspaces', 'plan_run', 'update_workspace'];

let api, dir, server, base, mcp;
before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  dir = await mkdtemp(join(tmpdir(), 'cysu-ws-'));
  const port = 24000 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: 'cysu-engine-workspace:test', CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  await http('/api/settings', 'PUT', { token: TOKEN, passkey: PASSKEY, globalProfile: 'global', llm: { mode: 'openai-api-key', apiKey: API_KEY } });
  mcp = mcpClient(join(dir, 'agent.sock'));
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
});
after(async () => {
  mcp?.close();
  server?.kill('SIGINT');
  await sleep(1500);
  api?.server.close();
  await rm(dir, { recursive: true, force: true });
});

function http(path, method = 'GET', body) {
  return fetch(`${base}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
}
function mcpClient(socket) {
  const child = spawn(process.execPath, ['image/engine-mcp.mjs'], { env: { ...process.env, CYSU_ENGINE_SOCKET: socket }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let buffer = '';
  let id = 0;
  child.stdout.on('data', (d) => {
    buffer += d;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (line.trim()) { const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  return { rpc, close: () => child.stdin.end() };
}
const outputs = [];
async function tool(name, args = {}) {
  const res = (await mcp.rpc('tools/call', { name, arguments: args })).result;
  outputs.push(res.content[0].text);
  return { isError: res.isError, data: res.structuredContent, text: res.content[0].text };
}

test('the assistant gets exactly the workspace + results tools', async () => {
  const { tools } = (await mcp.rpc('tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name).sort(), SHIPPED);
});

test('it can NOT start, propose, approve, cancel, or change profiles', async () => {
  for (const name of ['propose_run', 'propose_rerun', 'get_proposal', 'plan_profile_change', 'propose_profile_change', 'cancel_run',
    'start_chatgpt_login', 'start_run', 'approve_proposal']) {
    const r = await tool(name, {});
    assert.equal(r.isError, true, name);
    assert.match(r.text, /Unknown tool/, name);
  }
});

test('setup status points the user to /setup', async () => {
  const r = await tool('get_setup_status');
  assert.equal(r.data.ready, true);
  assert.deepEqual(r.data.whatTheUserMustDo, []);
});

test('create a workspace from the user\'s profiles: checked, saved, nothing started', async () => {
  const r = await tool('create_workspace', { name: 'Recon and attack', request: { prompt: 'Map example.com (authorized).', fromTags: { skip: ['3', '4'] } } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.data.plan.stages.map((s) => `${s.tag}:${s.profile}`), ['1:recon', '2:attack', '2:attack-b']);
  assert.equal(r.data.tellTheUser, 'Saved as your current workspace. Start it with: /run Recon and attack');
  const saved = (await http('/api/workspaces')).body;
  assert.deepEqual(saved.map((w) => w.name), ['Recon and attack']);
  await sleep(500);
  assert.deepEqual((await http('/api/runs')).body, [], 'creating a workspace must not start a run');
});

test('workspaces with picked stages, in the user\'s order', async () => {
  const r = await tool('create_workspace', { name: 'Escalate first', request: { prompt: 'p', globalProfile: 'global', stages: [{ profile: 'escalate' }, { profile: 'recon' }] } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.data.plan.stages.map((s) => s.profile), ['escalate', 'recon']);
});

test('bad workspaces are refused with clear messages, and nothing is saved', async () => {
  const before = (await http('/api/workspaces')).body.length;
  for (const [args, message] of [
    [{ name: 'Missing profile', request: { prompt: 'p', stages: [{ profile: 'not-mine' }] } }, /Not one of your profiles: not-mine/],
    [{ name: 'No objective', request: { fromTags: {} } }, /prompt/i],
    [{ name: 'recon AND attack', request: { prompt: 'p', fromTags: {} } }, /already exists/],
    [{ name: '', request: { prompt: 'p', fromTags: {} } }, /needs a name/],
    [{ name: 'Bad global', request: { prompt: 'p', globalProfile: 'gloabl', fromTags: {} } }, /Global profile gloabl is not one of your profiles/],
  ]) {
    const r = await tool('create_workspace', args);
    assert.equal(r.isError, true, `${args.name} should be refused: ${r.text}`);
    assert.match(r.text, message, args.name);
  }
  assert.equal((await http('/api/workspaces')).body.length, before);
});

test('list, get (by name), update (rename + new request)', async () => {
  const list = (await tool('list_workspaces')).data;
  assert.deepEqual(list.map((w) => w.name).sort(), ['Escalate first', 'Recon and attack']);
  assert.equal(list.find((w) => w.name === 'Escalate first').stages, 'escalate → recon');
  assert.equal(list.find((w) => w.name === 'Recon and attack').stages, 'profiles tagged 1-4, skipping 3, 4');

  const got = (await tool('get_workspace', { workspace: 'recon and attack' })).data;
  assert.equal(got.startWith, '/run Recon and attack');
  assert.deepEqual(got.plan.stages.map((s) => s.profile), ['recon', 'attack', 'attack-b']);

  const changed = await tool('update_workspace', { workspace: 'Recon and attack', name: 'Full campaign', request: { ...got.request, fromTags: {} } });
  assert.equal(changed.isError, false, changed.text);
  assert.equal(changed.data.tellTheUser, 'Updated. Start it with: /run Full campaign');
  assert.equal(changed.data.plan.stages.length, 5);
  const bad = await tool('update_workspace', { workspace: 'Full campaign', request: { prompt: 'p', stages: [{ profile: 'not-mine' }] } });
  assert.equal(bad.isError, true);
  assert.equal((await tool('get_workspace', { workspace: 'Full campaign' })).data.request.fromTags.skip, undefined, 'a refused update changes nothing');
  const gone = await tool('get_workspace', { workspace: 'gone' });
  assert.equal(gone.isError, true);
  assert.equal(JSON.parse(gone.text).error, 'No workspace called "gone"');
});

test('results: after the USER starts a run, the assistant can list it and read its results and request', async () => {
  const ws = (await http('/api/workspaces')).body.find((w) => w.name === 'Escalate first');
  const started = await http('/api/runs', 'POST', ws.request); // R3 adds /run <workspace>; this is what it will call
  assert.equal(started.status, 201, JSON.stringify(started.body));
  let run;
  for (let i = 0; i < 200; i++) {
    run = (await tool('get_run', { run_id: started.body.id })).data;
    if (!['queued', 'running'].includes(run.status)) break;
    await sleep(300);
  }
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.request.stages, [{ profile: 'escalate' }, { profile: 'recon' }], 'the original request comes back');
  assert.ok(run.stages[0].result.untrusted_agent_output);
  assert.equal((await tool('list_runs')).data[0].id, started.body.id);
  assert.ok((await tool('get_stage_activity', { run_id: started.body.id, stage: 0 })).data.items.length > 0);
  assert.match((await tool('get_stage_log', { run_id: started.body.id, stage: 1, lines: 40 })).data.lastLines.untrusted_agent_output, /installing stage profile: recon/);
});

test('no tool output ever contains a secret', () => {
  assert.ok(outputs.length > 15);
  for (const text of outputs) for (const secret of [TOKEN, PASSKEY, API_KEY]) assert.ok(!text.includes(secret), secret);
});
