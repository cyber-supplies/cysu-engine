// Stand-in for the Cyber Supplies API: serves profile bundles to the real
// cysu CLI inside test containers. Listens on the Docker bridge address.
import { createServer } from 'node:http';

export const PROFILES = {
  global: {
    skills: [{ name: 'house-rules', description: 'Global rules for every stage', content: '---\nname: house-rules\ndescription: Global rules for every stage\n---\nAlways write notes.\n' }],
    agents: [], mcp: [],
    prompts: [{ name: 'global-prompt', content: 'GLOBAL-PROMPT-MARKER: you are a Cyber Supplies agent.' }],
  },
  // A global profile that ships its OWN cysu skill (the engine must keep it).
  'global-cysu': {
    skills: [{ name: 'cysu', description: 'Profile-provided cysu skill', content: '---\nname: cysu\ndescription: Profile-provided cysu skill\n---\nPROFILE-OWN-CYSU-SKILL\n' }],
    agents: [], mcp: [],
    prompts: [{ name: 'global-prompt', content: 'GLOBAL-PROMPT-MARKER: with own cysu skill.' }],
  },
  attack: {
    skills: [{ name: 'attack-playbook', description: 'Attack stage playbook', content: '---\nname: attack-playbook\ndescription: Attack stage playbook\n---\nTry things.\n' }],
    agents: [],
    mcp: [{ name: 'stagemcp', type: 'stdio', command: 'echo', args: ['hello'] }],
    prompts: [{ name: 'stage-prompt', content: 'STAGE-PROMPT-MARKER: you are the attack stage.' }],
  },
};

// The profile list (GET /api/profiles), deliberately not in stage order.
// `attack-b` shares tag 2 with `attack` (ties sort by ID).
export const DEFAULT_LIST = [
  { id: 'triage', tag: ['4'] },
  { id: 'global', tag: [] },
  { id: 'attack-b', tag: ['2'] },
  { id: 'recon', tag: ['1'] },
  { id: 'attack', tag: ['2'] },
  { id: 'escalate', tag: ['3'] },
];

// bundle returns the full profile for GET /api/profiles/<id>. Profiles other
// than global/attack get a generic bundle; `broken` makes the stand-in Codex
// fail, `slow` makes it hang until cancelled.
function bundle(id) {
  if (PROFILES[id]) return { id, ...PROFILES[id] };
  return {
    id, agents: [], mcp: [],
    skills: [{ name: `${id}-skill`, description: `${id} skill`, content: `---\nname: ${id}-skill\ndescription: ${id} skill\n---\nDo ${id}.\n` }],
    prompts: [{ name: 'stage-prompt', content: `STAGE-PROMPT-MARKER: you are the ${id} stage.${id === 'broken' ? ' FAIL-THIS-STAGE' : ''}${id === 'slow' ? ' HANG-THIS-STAGE' : ''}` }],
  };
}

// token: the user token it accepts (or a list of them). `tokens` can be
// changed by tests (e.g. revoke one: tokens.delete(t)).
export function startFakeApi(host, token) {
  const tokens = new Set([].concat(token));
  const requests = [];
  // `saved` holds profiles written with PUT (they override the built-in bundles).
  const state = { list: structuredClone(DEFAULT_LIST), listStatus: 200, saved: new Map(), puts: [] };
  const full = (id) => state.saved.get(id) || { ...bundle(id), tag: state.list.find((p) => p.id === id)?.tag ?? [] };
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (![...tokens].some((t) => req.headers.authorization === `Bearer ${t}`)) return json(401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/api/profiles') {
      return state.listStatus === 200 ? json(200, state.list) : json(state.listStatus, { error: 'upstream trouble' });
    }
    const m = req.url.match(/^\/api\/profiles\/([^/?]+)$/);
    const id = m && decodeURIComponent(m[1]);
    if (req.method === 'GET' && m && state.list.some((p) => p.id === id)) return json(200, full(id));
    if (req.method === 'PUT' && m) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const doc = JSON.parse(raw);
        if (doc.id !== id || !['skills', 'agents', 'mcp', 'prompts'].every((k) => Array.isArray(doc[k]))) return json(400, { error: 'invalid profile' });
        state.puts.push(doc);
        state.saved.set(id, doc);
        const row = state.list.find((p) => p.id === id);
        if (row) row.tag = doc.tag ?? row.tag; else state.list.push({ id, tag: doc.tag ?? [] });
        json(200, { id, changes: { created: 0, updated: 0, deleted: 0, unchanged: 0 } });
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, host, () => resolve({
    server, requests, tokens, url: `http://${host}:${server.address().port}`,
    setProfiles: (list) => { state.list = structuredClone(list); },
    setListStatus: (status) => { state.listStatus = status; },
    setSaved: (id, doc) => { state.saved.set(id, structuredClone(doc)); if (!state.list.some((p) => p.id === id)) state.list.push({ id, tag: doc.tag ?? [] }); },
    saved: (id) => state.saved.get(id),
    puts: state.puts,
    reset: () => { state.list = structuredClone(DEFAULT_LIST); state.listStatus = 200; state.saved.clear(); state.puts.length = 0; },
  })));
}
