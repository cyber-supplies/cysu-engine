// agent-socket.js: the ONLY way the main agent reaches the engine.
//
// A small HTTP server on a Unix socket (default <data>/agent.sock) that offers
// just the agent tools: GET /tools and POST /tools/call. No settings, no
// secrets, no approvals. The socket file is bind-mounted into the main agent's
// container (whose firewall blocks the host network); the cysu-engine-mcp
// bridge in the image turns it into an MCP server for Codex.

import { createServer } from 'node:http';
import { rm, chmod } from 'node:fs/promises';
import { callTool, toolList } from './agent-tools.js';

const MAX_BODY = 1_000_000;

export async function startAgentSocket(path, ctx) {
  if (Buffer.byteLength(path) > 100) throw new Error(`Agent socket path is too long for a Unix socket (${path}); set CYSU_ENGINE_AGENT_SOCKET to a shorter path`);
  await rm(path, { force: true });
  const server = createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'GET' && req.url === '/tools') return reply(200, { tools: toolList() });
      if (req.method === 'POST' && req.url === '/tools/call') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > MAX_BODY) return reply(413, { error: 'Request too large' });
        }
        let input;
        try { input = JSON.parse(raw || '{}'); } catch { return reply(400, { error: 'Invalid JSON' }); }
        return reply(200, await callTool(String(input.name ?? ''), input.arguments, ctx));
      }
      return reply(404, { error: 'Not found' });
    } catch (error) {
      reply(500, { error: 'Internal error' });
      console.error('agent socket:', error);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  // The agent runs as uid 10001 in its container; the socket's parent (the
  // data dir, 0700) keeps other users on this machine out.
  await chmod(path, 0o666);
  return server;
}
