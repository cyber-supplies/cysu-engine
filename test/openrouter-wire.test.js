// Real Codex, real worker and profile installation; only the remote APIs are
// local stand-ins. Proves command-backed auth, Responses streaming, tools and
// thread resumption without using a paid key or making live model requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { startFakeApi } from './fixtures/fake-api.js';
import { startStage, cancelStage } from '../server/stage.js';

test('real Codex uses OpenRouter auth and Responses for tool calls and follow-ups', async (t) => {
  const host = execFileSync('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim();
  const token = 'usr_openrouter-wire-test';
  const key = 'sk-or-openrouter-wire-test';
  const model = 'openai/test-model';
  const api = await startFakeApi(host, token);
  t.after(() => api.server.close());
  const requests = [];
  let toolUsed = false;
  const upstream = createServer(async (req, res) => {
    if (req.url.startsWith('/api/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.url !== '/api/v1/responses' || req.method !== 'POST') {
      res.writeHead(404); res.end(); return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ auth: req.headers.authorization, body });
    const shell = (body.tools || []).find((tool) => ['exec_command', 'shell_command', 'shell'].includes(tool.name));
    let item;
    if (!toolUsed && shell) {
      toolUsed = true;
      const args = shell.name === 'exec_command' ? { cmd: 'printf OPENROUTER_WIRE_TOOL_OK', max_output_tokens: 1000 }
        : shell.name === 'shell_command' ? { command: 'printf OPENROUTER_WIRE_TOOL_OK' }
          : { command: ['sh', '-c', 'printf OPENROUTER_WIRE_TOOL_OK'] };
      item = { id: 'fc_wire', type: 'function_call', status: 'completed', call_id: 'call_wire', name: shell.name, arguments: JSON.stringify(args) };
    } else {
      item = { id: `msg_wire_${requests.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OpenRouter wire test completed.', annotations: [] }] };
    }
    const response = { id: `resp_wire_${requests.length}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'in_progress', output: [] };
    const events = [
      { type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } },
    ];
    if (item.type === 'function_call') {
      events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
      events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
    } else {
      events.push({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      events.push({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
      events.push({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text });
      events.push({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
    }
    events.push({ type: 'response.output_item.done', output_index: 0, item });
    events.push({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } } } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    events.forEach((event, sequence_number) => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`));
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, host, resolve));
  t.after(() => upstream.close());
  const live = startStage({
    stage: { profile: 'recon', prompt: 'Run a harmless printf command, then finish.', reprompts: ['Acknowledge completion.'] },
    settings: { token, passkey: 'wire-test', llm: { mode: 'codex', openrouter: { apiKey: key, model } } },
    extraEnv: { CYSU_API_URL: api.url, CYSU_EGRESS_GUARD: '0', CYSU_WORKER_TEST_BOOTSTRAP: '0', CYSU_ENGINE_TEST_OPENROUTER_URL: `http://${host}:${upstream.address().port}/api/v1` },
  });
  const timer = setTimeout(() => cancelStage(live), 45000);
  const result = await live.done.finally(() => clearTimeout(timer));
  assert.equal(result.status, 'succeeded', result.log);
  assert.ok(toolUsed, `Codex sent no shell tool: ${requests[0]?.body.tools?.map((x) => `${x.type}:${x.name}`)}`);
  assert.ok(result.events.some((event) => event.type === 'item.completed' && event.item?.type === 'command_execution' && event.item.aggregated_output?.includes('OPENROUTER_WIRE_TOOL_OK')));
  assert.ok(requests.length >= 3, 'tool result and resumed turn both reached the provider');
  assert.ok(requests.every((request) => request.auth === `Bearer ${key}` && request.body.model === model));
  assert.deepEqual(result.attempts.map((a) => a.provider), ['openrouter', 'openrouter']);
  assert.equal(result.turns, 2);
  assert.ok(!JSON.stringify(result).includes(key), 'API key leaked into logs/events');
});
