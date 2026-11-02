// Cyber Supplies Engine web UI: plain ES modules, no build step.
// Routes (hash): #/runs, #/runs/<id>, #/new[?from=<runId>|setup=<id>], #/setup,
//               #/chat[/<id>] (the assistant)

import { h, clear, $, api } from './dom.js';
import { setupView } from './views/setup.js';
import { newRunView } from './views/new-run.js';
import { runsView } from './views/runs.js';
import { runView } from './views/run.js';
import { chatView } from './views/chat.js';

export const app = {
  status: null,
  async refreshStatus() {
    try { this.status = await api('/api/status'); } catch { this.status = null; }
    renderStatus(this.status);
    return this.status;
  },
  go(hash) { if (location.hash === hash) route(); else location.hash = hash; },
};

function renderStatus(s) {
  const pill = (ok, label, value) => h('a', { class: `pill ${ok ? 'ok' : 'bad'}`, href: '#/setup' }, h('span', { class: 'dot' }), `${label}: `, h('b', {}, value));
  clear($('#status'),
    s ? [
      pill(Boolean(s.docker), 'Docker', s.docker ? `v${s.docker}` : 'not found'),
      pill(s.cysu, 'Cyber Supplies', s.cysu ? 'set' : 'not set'),
      pill(s.llm.ready, 'LLM', s.llm.ready ? (s.llm.mode === 'codex' ? 'ChatGPT' : 'API key') : 'log in'),
    ] : h('span', { class: 'pill bad' }, 'engine not reachable'));
}

let cleanup = null;
async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query || '');
  const view = $('#view');
  const status = await app.refreshStatus();
  for (const link of document.querySelectorAll('nav a')) link.classList.toggle('active', path.startsWith(link.dataset.route));

  // Until the user's Cyber Supplies setup and LLM login are done, starting a
  // run leads to Setup (past runs stay viewable).
  let m;
  try {
    if (path === '/setup' || (status && !status.configured && (path === '/new' || path === '' || path === '/'))) {
      cleanup = await setupView(view, { params });
    } else if ((m = path.match(/^\/chat(?:\/([0-9a-f-]{36}))?$/))) {
      cleanup = await chatView(view, { id: m[1] });
    } else if (path === '/new') {
      cleanup = await newRunView(view, { params });
    } else if ((m = path.match(/^\/runs\/([0-9a-f-]{36})$/))) {
      cleanup = await runView(view, { id: m[1] });
    } else if (path === '/runs' || path === '' || path === '/') {
      cleanup = await runsView(view, { params });
    } else {
      clear(view, h('section', { class: 'card' }, 'Page not found. ', h('a', { href: '#/runs' }, 'Go to runs')));
    }
  } catch (err) {
    clear(view, h('section', { class: 'card bad-card' }, h('h2', {}, 'Something went wrong'), h('p', {}, err.message)));
  }
}

window.addEventListener('hashchange', route);
setInterval(() => app.refreshStatus(), 15_000);
route();
