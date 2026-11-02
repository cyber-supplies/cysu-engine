// Stand-in for the OpenAI Responses API, for testing the REAL Codex as the
// main agent without an LLM. Scripted by the user's message:
//   CALL <tool> <json args>     one line per tool call, made in order
//   JS <code>                   (Code Mode) run this JavaScript through `exec`
//   SLOW                        hold the answer for 60s (to test Stop)
// After the scripted calls it answers "Done. <last tool output>", or
// "echo: <message>" when there were none. Every request is recorded.
//
// Two ways Codex offers tools, both handled:
//  - direct: tools listed in `tools` (unknown model, e.g. "fake-model");
//  - Code Mode: what Codex does for real models (e.g. its default model): no
//    `tools`, an `additional_tools` item with one `exec` tool that runs
//    JavaScript, and engine tools reachable as tools.mcp__cysu_engine__<name>.

import { createServer } from 'node:http';

const textOf = (item) => (item?.content || []).map((c) => c.text || '').join('');

export function startFakeLlm(host) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      if (!req.url.endsWith('/responses')) { res.writeHead(404); return res.end('{}'); }
      const input = body.input || [];
      // The latest user message (not the developer/instructions items).
      let last = -1;
      for (let i = input.length - 1; i >= 0; i--) if (input[i].role === 'user' && !/^<environment_context>|^# AGENTS\.md/.test(textOf(input[i]).trim())) { last = i; break; }
      const message = textOf(input[last]);
      const outputs = input.slice(last + 1).filter((i) => i.type === 'function_call_output' || i.type === 'custom_tool_call_output');
      const calls = message.split('\n').map((l) => l.match(/^(CALL|JS) (\S+)\s*(.*)$/)).filter(Boolean)
        .map(([, kind, a, b]) => (kind === 'JS' ? { js: `${a} ${b}`.trim() } : { name: a, args: b || '{}' }));
      const codeMode = !(body.tools || []).length && input.some((i) => i.type === 'additional_tools');
      if (/\bSLOW\b/.test(message)) await new Promise((r) => setTimeout(r, 60_000));

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const n = requests.length;
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('response.created', { response: { id: `resp_${n}` } });
      let item;
      if (outputs.length < calls.length) {
        const call = calls[outputs.length];
        if (codeMode) {
          const code = call.js ?? `const r = await tools.mcp__cysu_engine__${call.name}(${call.args});\ntext(JSON.stringify(r.structuredContent ?? r));`;
          item = { type: 'custom_tool_call', id: `ct_${n}`, call_id: `call_${n}`, name: 'exec', namespace: 'functions', input: code };
        } else {
          const builtIn = ['exec_command', 'shell', 'write_stdin', 'web_search', 'apply_patch'].includes(call.name);
          item = { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: call.name, arguments: call.args, ...(builtIn ? {} : { namespace: 'mcp__cysu_engine' }) };
        }
      } else {
        const lastOut = outputs.at(-1);
        const out = lastOut ? (typeof lastOut.output === 'string' ? lastOut.output : (lastOut.output || []).map((o) => o.text).join(' ')) : '';
        item = { type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: calls.length ? `Done. ${out.slice(0, 600)}` : `echo: ${message}` }] };
      }
      ev('response.output_item.done', { item });
      ev('response.completed', { response: { id: `resp_${n}`, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, host, () => resolve({
    server, requests, url: `http://${host}:${server.address().port}/v1`,
    // Codex config that points the assistant at this server. codeMode: use
    // Codex's default (real) model name, so Codex behaves as with a real model.
    codexConfig({ codeMode = false } = {}) {
      return `${codeMode ? '' : 'model = "fake-model"\n'}model_provider = "fake"\n[model_providers.fake]\nname = "fake"\nbase_url = "http://${host}:${server.address().port}/v1"\nwire_api = "responses"`;
    },
  })));
}
