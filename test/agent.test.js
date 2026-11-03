// Main-agent tools: MCP bridge ↔ agent socket ↔ engine. Real engine server,
// stand-in Cyber Supplies API and stand-in Codex (no LLM).
// Runs with ALL tools on (CYSU_ENGINE_AGENT_TOOLS=all), so the tools that are
// switched off for now (proposals, profile editing) stay tested. The tools the
// assistant actually gets are tested in agent-workspaces.test.js.
// Needs Docker + both images (npm run image:build && npm run image:build:test).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startFakeApi } from './fixtures/fake-api.js';
import { hardeningArgs } from '../server/docker.js';

const TOKEN = 'usr_agent-test-token-6d1f';
const PASSKEY = 'agent-test-passkey-27aa';
const API_KEY = 'sk-agent-test-9e8d7c';
const TEST_IMAGE = 'cysu-engine-workspace:test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let api, dir, server, base, socket;

before(async () => {
  const gw = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  api = await startFakeApi(gw, TOKEN);
  dir = await mkdtemp(join(tmpdir(), 'cysu-agent-'));
  socket = join(dir, 'agent.sock');
  const port = 21000 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CYSU_ENGINE_DATA: dir, CYSU_ENGINE_IMAGE: TEST_IMAGE, CYSU_API_URL: api.url, CYSU_ENGINE_TEST_NO_FIREWALL: '1', CYSU_ENGINE_AGENT_TOOLS: 'all' },
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
  await sleep(1500);
  api?.server.close();
  await rm(dir, { recursive: true, force: true });
});

const http = (path, method = 'GET', body) => fetch(`${base}${path}`, {
  method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// An MCP client talking to the bridge over stdio, like Codex does.
function mcpClient(command = [process.execPath, 'image/engine-mcp.mjs'], env = { CYSU_ENGINE_SOCKET: socket }) {
  const child = spawn(command[0], command.slice(1), { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.on('data', (d) => {
    buffer += d;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const tool = async (name, args = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    return { isError: res.result.isError, data: res.result.structuredContent, text: res.result.content[0].text };
  };
  return { rpc, notify, tool, close: () => child.stdin.end(), child };
}

let mcp;
const outputs = []; // every tool result, checked for secrets at the end
const tool = async (name, args) => { const r = await mcp.tool(name, args); outputs.push(r.text); return r; };

test('MCP handshake: initialize, ping, tools/list, unknown method', async () => {
  mcp = mcpClient();
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'cysu-engine');
  assert.ok(init.result.capabilities.tools);
  mcp.notify('notifications/initialized');
  assert.deepEqual((await mcp.rpc('ping')).result, {});
  const { tools } = (await mcp.rpc('tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'cancel_run', 'create_workspace', 'get_chatgpt_login_status', 'get_profile', 'get_proposal', 'get_run', 'get_setup_status',
    'get_stage_activity', 'get_stage_log', 'get_workspace', 'list_profiles', 'list_runs', 'list_saved_setups', 'list_workspaces',
    'plan_profile_change', 'plan_run', 'propose_profile_change', 'propose_rerun', 'propose_run', 'start_chatgpt_login', 'update_workspace',
  ]);
  assert.ok(tools.every((t) => t.description && t.inputSchema?.type === 'object'));
  const unknown = await mcp.rpc('resources/list');
  assert.equal(unknown.error.code, -32601);
});

test('setup status tells the agent what the USER must do, then turns ready', async () => {
  let r = await tool('get_setup_status');
  assert.equal(r.data.ready, false);
  assert.equal(r.data.cyberSupplies, 'missing');
  assert.equal(r.data.llm, 'not logged in');
  assert.ok(r.data.whatTheUserMustDo.some((t) => /\/setup/.test(t) && /token and passkey/.test(t) && /never ask for them in chat/.test(t)));
  assert.ok(r.data.whatTheUserMustDo.some((t) => /\/setup/.test(t) && /Codex \(ChatGPT\) sign-in or an OpenAI API key/.test(t)));
  await http('/api/settings', 'PUT', { token: TOKEN, passkey: PASSKEY, globalProfile: 'global', llm: { mode: 'openai-api-key', apiKey: API_KEY } });
  r = await tool('get_setup_status');
  assert.equal(r.data.ready, true);
  assert.equal(r.data.llm, 'OpenAI API key');
  assert.deepEqual(r.data.whatTheUserMustDo, []);
});

test('the agent socket offers only the tools: no settings, no approvals', async () => {
  const raw = (method, path, body) => new Promise((resolve) => {
    const req = request({ socketPath: socket, method, path, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.end(body ? JSON.stringify(body) : undefined);
  });
  for (const path of ['/api/settings', '/api/status', '/api/proposals', '/api/runs']) {
    assert.equal((await raw('GET', path)).status, 404, path);
  }
  const approve = JSON.parse((await raw('POST', '/tools/call', { name: 'approve_proposal', arguments: {} })).body);
  assert.equal(approve.isError, true);
  assert.match(approve.result.error, /Unknown tool/);
});

test('profiles and plan: the agent sees tags and the stage order; nothing starts', async () => {
  const profiles = await tool('list_profiles');
  assert.deepEqual(profiles.data.find((p) => p.id === 'recon'), { id: 'recon', tags: ['1'] });
  const plan = await tool('plan_run', { request: { prompt: 'p', fromTags: { skip: ['3', '4'] } } });
  assert.equal(plan.isError, false, plan.text);
  assert.deepEqual(plan.data.stages.map((s) => `${s.order}:${s.tag}:${s.profile}`), ['1:1:recon', '2:2:attack', '3:2:attack-b']);
  assert.equal(plan.data.globalProfile, 'global');
  const bad = await tool('plan_run', { request: { prompt: 'p', globalProfile: 'nope', fromTags: {} } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Global profile nope is not one of your profiles/);
  assert.deepEqual((await http('/api/runs')).body, []);
});

let proposalId, runId;
test('propose_run waits for the user: nothing runs until Approve', async () => {
  const r = await tool('propose_run', { request: { name: 'agent run', prompt: 'Objective from chat', fromTags: { skip: ['3', '4'] } }, summary: 'Recon and attack on the test target.' });
  assert.equal(r.isError, false, r.text);
  proposalId = r.data.proposalId;
  assert.match(r.data.status, /waiting for the user to approve/);
  await sleep(1000);
  assert.deepEqual((await http('/api/runs')).body, [], 'a proposal must not start a run');
  assert.equal((await tool('get_proposal', { proposal_id: proposalId })).data.status, 'pending');

  // The user sees it in the engine and approves (regular API, not reachable by the agent).
  const listed = (await http('/api/proposals')).body;
  assert.equal(listed[0].id, proposalId);
  assert.equal(listed[0].summary, 'Recon and attack on the test target.');
  const approved = await http(`/api/proposals/${proposalId}/approve`, 'POST');
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  runId = approved.body.runId;
  assert.equal((await http(`/api/proposals/${proposalId}/approve`, 'POST')).status, 409, 'approve twice');
  const seen = await tool('get_proposal', { proposal_id: proposalId });
  assert.deepEqual([seen.data.status, seen.data.runId], ['approved', runId]);
});

test('the agent follows the run: get_run, activity, log — agent output marked untrusted', async () => {
  let run;
  for (let i = 0; i < 200; i++) {
    run = (await tool('get_run', { run_id: runId })).data;
    if (!['queued', 'running'].includes(run.status)) break;
    await sleep(300);
  }
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.stages.map((s) => `${s.profile}=${s.status}`), ['recon=succeeded', 'attack=succeeded', 'attack-b=succeeded']);
  assert.ok(run.stages[0].result.untrusted_agent_output, 'stage answers must be wrapped as untrusted');
  assert.match(run.stages[0].result.untrusted_agent_output, /Objective from chat/);

  const activity = (await tool('get_stage_activity', { run_id: runId, stage: 1 })).data;
  assert.deepEqual(Object.keys(activity.items[0]), ['seq', 'attempt', 'model']);
  assert.ok(activity.items.some((i) => i.command === 'echo hi' && i.exitCode === 0));
  assert.ok(activity.items.some((i) => i.message?.untrusted_agent_output));
  assert.equal(activity.done, true);
  const more = (await tool('get_stage_activity', { run_id: runId, stage: 1, after: activity.next })).data;
  assert.deepEqual(more.items, []);

  const log = (await tool('get_stage_log', { run_id: runId, stage: 0, lines: 5 })).data;
  assert.equal(log.lastLines.untrusted_agent_output.split('\n').length, 5);

  const runs = (await tool('list_runs', { limit: 5 })).data;
  assert.equal(runs[0].id, runId);
  assert.deepEqual(runs[0].stages, ['1:recon=succeeded', '2:attack=succeeded', '2:attack-b=succeeded']);
});

test('reject, rerun proposals, saved setups, cancel_run', async () => {
  const p = await tool('propose_rerun', { run_id: runId, summary: 'Same again.' });
  assert.equal(p.isError, false, p.text);
  const rejected = await http(`/api/proposals/${p.data.proposalId}/reject`, 'POST');
  assert.equal(rejected.body.status, 'rejected');
  assert.equal((await tool('get_proposal', { proposal_id: p.data.proposalId })).data.status, 'rejected');
  assert.equal((await http(`/api/proposals/${p.data.proposalId}/approve`, 'POST')).status, 409);

  await http('/api/workspaces', 'POST', { name: 'Weekly', request: { prompt: 'w', fromTags: {} } });
  assert.deepEqual((await tool('list_saved_setups')).data.map((s) => s.name), ['Weekly']);

  api.setProfiles([{ id: 'global', tag: [] }, { id: 'slow', tag: ['1'] }]);
  try {
    const long = await tool('propose_run', { request: { prompt: 'p', fromTags: {} }, summary: 'long' });
    const started = await http(`/api/proposals/${long.data.proposalId}/approve`, 'POST');
    const id = started.body.runId;
    for (let i = 0; i < 100; i++) {
      if ((await http(`/api/runs/${id}`)).body.stages[0].threadId) break;
      await sleep(200);
    }
    const c = await tool('cancel_run', { run_id: id });
    assert.equal(c.data.status, 'cancelling', c.text);
    let run;
    for (let i = 0; i < 100; i++) { run = (await http(`/api/runs/${id}`)).body; if (run.status === 'cancelled') break; await sleep(300); }
    assert.equal(run.status, 'cancelled');
    assert.equal((await tool('cancel_run', { run_id: id })).isError, true, 'cancelling a finished run is an error');
  } finally { api.reset(); }
});

// ---- profile create/edit: always plan + proposal + user approval ----------------------

const HEADER_SECRET = 'Bearer header-secret-123';

test('get_profile: full profile for editing; MCP header values hidden', async () => {
  api.setSaved('intel', { id: 'intel', tag: ['3'], skills: [], agents: [], prompts: [{ name: 'p', content: 'intel prompt' }],
    mcp: [{ name: 'feed', type: 'http', url: 'https://intel.example/mcp', headers: { Authorization: HEADER_SECRET } }] });
  const r = await tool('get_profile', { profile_id: 'intel' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.data.tag, ['3']);
  assert.equal(r.data.mcp[0].headers.Authorization, '<redacted by engine>');
  const attack = await tool('get_profile', { profile_id: 'attack' });
  assert.equal(attack.data.skills[0].name, 'attack-playbook');
  const missing = await tool('get_profile', { profile_id: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /does not exist \(propose_profile_change can create it\)/);
});

test('plan_profile_change shows the diff and writes nothing', async () => {
  const r = await tool('plan_profile_change', { change: { profile: 'recon', tags: ['2'], upsert: { skills: [{ name: 'dns-notes', description: 'DNS', content: 'Write DNS notes.' }] } } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([r.data.exists, r.data.tagsBefore, r.data.tagsAfter], [true, ['1'], ['2']]);
  assert.deepEqual(r.data.created.map((c) => `${c.kind}:${c.name}`), ['skills:dns-notes']);
  assert.equal(api.puts.length, 0, 'planning must not write');
});

test('create a new profile: proposal → nothing saved → user approves → saved', async () => {
  const change = { profile: 'osint', tags: ['1'], upsert: {
    skills: [{ name: 'osint-sources', description: 'Where to look', content: 'Search public sources.' }],
    prompts: [{ name: 'osint-prompt', content: 'You are the OSINT stage.' }] } };
  const p = await tool('propose_profile_change', { change, summary: 'New stage-1 OSINT profile.' });
  assert.equal(p.isError, false, p.text);
  assert.equal(p.data.plan.exists, false);
  assert.deepEqual(p.data.plan.created.map((c) => c.name).sort(), ['osint-prompt', 'osint-sources']);
  assert.equal(api.puts.length, 0, 'a proposal must not write');
  assert.equal((await tool('get_proposal', { proposal_id: p.data.proposalId })).data.status, 'pending');

  const listed = (await http('/api/proposals')).body.find((x) => x.id === p.data.proposalId);
  assert.equal(listed.kind, 'profile');
  assert.equal(listed.summary, 'New stage-1 OSINT profile.');
  assert.equal(listed.baseHash, undefined, 'internal version hash is not exposed');

  const ok = await http(`/api/proposals/${p.data.proposalId}/approve`, 'POST');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(api.puts.length, 1);
  assert.deepEqual(api.saved('osint').tag, ['1']);
  assert.equal(api.saved('osint').skills[0].content, 'Search public sources.');
  assert.deepEqual(['skills', 'agents', 'mcp', 'prompts'].map((k) => Array.isArray(api.saved('osint')[k])), [true, true, true, true]);
  assert.ok((await tool('list_profiles')).data.some((x) => x.id === 'osint' && x.tags[0] === '1'));
  assert.equal((await tool('get_proposal', { proposal_id: p.data.proposalId })).data.status, 'approved');
});

test('edit keeps hidden MCP header values exactly as stored', async () => {
  const current = (await tool('get_profile', { profile_id: 'intel' })).data;
  const feed = { ...current.mcp[0], url: 'https://intel.example/mcp/v2' }; // header still "<redacted by engine>"
  const p = await tool('propose_profile_change', { change: { profile: 'intel', upsert: { mcp: [feed] } }, summary: 'Move the feed to v2.' });
  assert.equal(p.isError, false, p.text);
  assert.deepEqual(p.data.plan.updated.map((u) => u.name), ['feed']);
  assert.doesNotMatch(JSON.stringify(p.data.plan), /header-secret/);
  const before = api.puts.length;
  assert.equal((await http(`/api/proposals/${p.data.proposalId}/approve`, 'POST')).status, 200);
  assert.equal(api.puts.length, before + 1);
  assert.equal(api.saved('intel').mcp[0].url, 'https://intel.example/mcp/v2');
  assert.equal(api.saved('intel').mcp[0].headers.Authorization, HEADER_SECRET, 'the real header value must survive the edit');
});

test('a profile changed after the proposal is NOT overwritten (stale), reject writes nothing', async () => {
  const p = await tool('propose_profile_change', { change: { profile: 'recon', tags: ['2'] }, summary: 'Move recon to stage 2.' });
  api.setSaved('recon', { id: 'recon', tag: ['1'], skills: [], agents: [], mcp: [], prompts: [{ name: 'p', content: 'edited by the user meanwhile' }] });
  const before = api.puts.length;
  const stale = await http(`/api/proposals/${p.data.proposalId}/approve`, 'POST');
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed since this was proposed; ask the agent to propose again/);
  assert.equal(api.puts.length, before, 'nothing written');
  assert.equal((await tool('get_proposal', { proposal_id: p.data.proposalId })).data.status, 'stale');

  const q = await tool('propose_profile_change', { change: { profile: 'recon', tags: ['2'] }, summary: 'Again.' });
  assert.equal((await http(`/api/proposals/${q.data.proposalId}/reject`, 'POST')).body.status, 'rejected');
  assert.equal(api.puts.length, before);
});

test('bad profile changes are caught at plan time with clear messages', async () => {
  for (const [change, message] of [
    [{ profile: 'recon', upsert: { skills: [{ name: 'Bad Name', description: 'd', content: 'c' }] } }, /lowercase hyphenated slug/],
    [{ profile: 'recon', upsert: { skills: [{ name: 'ok', content: 'c' }] } }, /'description' must be a non-empty string/],
    [{ profile: 'recon', remove: { skills: ['not-there'] } }, /has none/],
    [{ profile: 'recon', upsert: { tools: [] } }, /unknown kind 'tools'/],
    [{ profile: 'recon', delete: true }, /Unsupported change field 'delete'/],
    [{ profile: 'a/b' }, /portable directory name/],
    [{ profile: 'recon', tags: ['1'] }, /would not change anything/],
    [{ profile: 'intel', upsert: { mcp: [{ name: 'new-feed', type: 'http', url: 'https://x.example', headers: { Authorization: '<redacted by engine>' } }] } }, /redacted but has no stored value/],
  ]) {
    const r = await tool('plan_profile_change', { change });
    assert.equal(r.isError, true, `${JSON.stringify(change)} should fail`);
    assert.match(r.text, message);
  }
  api.reset();
});

test('a run proposal is NOT started if the stages changed since (e.g. a new tagged profile)', async () => {
  const p = await tool('propose_run', { request: { prompt: 'p', fromTags: { skip: ['3', '4'] } }, summary: 'Stages 1-2.' });
  assert.deepEqual(p.data.plan.stages.map((s) => s.profile), ['recon', 'attack', 'attack-b']);
  api.setSaved('newcomer', { id: 'newcomer', tag: ['1'], skills: [], agents: [], mcp: [], prompts: [] });
  try {
    const before = (await http('/api/runs')).body.length;
    const r = await http(`/api/proposals/${p.data.proposalId}/approve`, 'POST');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /changed since this was proposed \(was: recon → attack → attack-b; now: newcomer → recon → attack → attack-b\)/);
    assert.equal((await http('/api/runs')).body.length, before, 'no run started');
    assert.equal((await tool('get_proposal', { proposal_id: p.data.proposalId })).data.status, 'stale');
  } finally { api.reset(); }
});

test('no tool output ever contains a secret', () => {
  assert.ok(outputs.length > 15);
  for (const text of outputs) {
    for (const secret of [TOKEN, PASSKEY, API_KEY, 'header-secret-123']) assert.ok(!text.includes(secret), `secret in tool output: ${text.slice(0, 200)}`);
  }
});

test('from inside a hardened worker (firewall ON): the bridge reaches the tools through the mounted socket', async () => {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_setup_status', arguments: {} } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const out = await new Promise((resolve) => {
    const child = execFile('docker', ['run', '--rm', '-i', ...hardeningArgs(), '-v', `${socket}:/run/cysu-engine.sock`, TEST_IMAGE,
      'sh', '-c', 'id -u; timeout 20 cysu-engine-mcp'],
      { timeout: 60_000 }, (e, stdout, stderr) => resolve({ stdout, stderr }));
    child.stdin.end(input);
  });
  const lines = out.stdout.trim().split('\n');
  assert.equal(lines[0], '10001', 'should run as the unprivileged runner');
  const replies = lines.slice(1).map((l) => JSON.parse(l));
  assert.equal(replies.find((r) => r.id === 1).result.serverInfo.name, 'cysu-engine', out.stderr);
  assert.equal(replies.find((r) => r.id === 2).result.structuredContent.ready, true);
});

test('Codex in the worker picks up the engine tools as an MCP server', async () => {
  const out = await new Promise((resolve) => execFile('docker', ['run', '--rm', ...hardeningArgs(), TEST_IMAGE,
    'sh', '-c', 'mkdir -p ~/.codex && printf "[mcp_servers.cysu-engine]\\ncommand = \\"cysu-engine-mcp\\"\\n" > ~/.codex/config.toml && codex mcp list'],
  { timeout: 60_000 }, (e, stdout, stderr) => resolve(stdout + stderr)));
  assert.match(out, /cysu-engine\s+cysu-engine-mcp.*enabled/, out);
});

test('the bridge reports a missing engine clearly (no socket)', async () => {
  const lonely = mcpClient(undefined, { CYSU_ENGINE_SOCKET: join(dir, 'nope.sock') });
  await lonely.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const res = await lonely.rpc('tools/list');
  assert.match(res.error.message, /cannot reach the engine/);
  lonely.close();
  mcp?.close();
});
