// The pinned, unmodified Claude CLI against a local Messages API stand-in.
// This checks its actual stdin/JSONL/tool/resume contract without a paid account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

test('real Claude CLI streams results, executes tools and resumes its session', { timeout: 90_000 }, async (t) => {
  const host = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  const requests = [];
  let toolUsed = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.includes('count_tokens')) { res.setHeader('Content-Type', 'application/json'); res.end('{"input_tokens":100}'); return; }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
    requests.push(body);
    const callTool = !toolUsed && body.tools?.some((tool) => tool.name === 'Bash');
    if (callTool) toolUsed = true;
    const block = callTool
      ? { type: 'tool_use', id: 'tool_wire_1', name: 'Bash', input: { command: 'printf CLAUDE_WIRE_TOOL_OK', description: 'Print test marker' } }
      : { type: 'text', text: 'Claude wire test completed.' };
    const message = { id: `msg_wire_${requests.length}`, type: 'message', role: 'assistant', model: body.model,
      content: [block], stop_reason: callTool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
    if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return; }
    const events = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: callTool ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: callTool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  t.after(() => server.close());
  const container = `cysu-claude-wire-${randomUUID()}`;
  t.after(() => execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }));
  execFileSync('docker', ['run', '-d', '--name', container, '--init', '--user', '10001:10001', '--entrypoint', 'sleep',
    '-e', 'HOME=/home/runner', '-e', 'ANTHROPIC_API_KEY=sk-ant-wire-fixture',
    '-e', `ANTHROPIC_BASE_URL=http://${host}:${server.address().port}`, '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    '-e', 'DISABLE_AUTOUPDATER=1', 'cysu-engine-workspace:dev', '120'], { stdio: 'pipe' });
  const invoke = (prompt, thread) => new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'claude', '-p', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions', '--permission-prompts', 'none', '--model', 'claude-sonnet-4-6', '--effort', 'low',
      ...(thread ? ['--resume', thread] : [])]);
    let out = '', err = '';
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`${code}: ${err}\n${out}`));
      try { resolve(out.trim().split('\n').map((line) => JSON.parse(line))); } catch (e) { reject(e); }
    });
  });
  const first = await invoke('Run printf CLAUDE_WIRE_TOOL_OK using Bash, then finish.');
  const result = first.findLast((e) => e.type === 'result');
  assert.equal(result?.subtype, 'success', JSON.stringify(first));
  assert.equal(result.is_error, false);
  assert.ok(toolUsed);
  assert.ok(first.some((e) => e.type === 'user' && JSON.stringify(e).includes('CLAUDE_WIRE_TOOL_OK')));
  assert.ok(result.usage.input_tokens > 0);
  const second = await invoke('Acknowledge completion.', result.session_id);
  assert.equal(second.findLast((e) => e.type === 'result')?.session_id, result.session_id);
  assert.equal(second.findLast((e) => e.type === 'result')?.subtype, 'success');
  assert.ok(requests.some((r) => JSON.stringify(r.messages).includes('CLAUDE_WIRE_TOOL_OK')));
});
