// Setup: the two things a user enters (Cyber Supplies token + passkey) and
// their own LLM login (ChatGPT sign-in through Codex, or an OpenAI API key).

import { h, clear, api, confirmButton } from '../dom.js';
import { app } from '../app.js';

export async function setupView(view) {
  let poll = null;
  let settings = await api('/api/settings');
  let status = app.status;

  const card = (n, title, done, ...body) =>
    h('section', { class: `card step ${done ? 'done' : ''}` },
      h('h2', {}, h('span', { class: 'step-n' }, done ? '✓' : String(n)), title), ...body);
  const msg = () => h('p', { class: 'msg', role: 'status' });

  async function refresh() {
    [settings, status] = await Promise.all([api('/api/settings'), app.refreshStatus()]);
    render();
  }

  // ---- 1. Cyber Supplies -----------------------------------------------------------
  function cysuCard() {
    const out = msg();
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: settings.token ? `saved (${settings.token}) — leave blank to keep` : 'paste your Cyber Supplies token' });
    const passkey = h('input', { type: 'password', autocomplete: 'new-password', placeholder: settings.passkey ? 'saved — leave blank to keep' : 'your encryption passkey' });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/api/settings', { method: 'PUT', body: { token: token.value, passkey: passkey.value } });
          await refresh();
        } catch (err) { out.textContent = err.message; }
      },
    },
    h('label', {}, 'Cyber Supplies token', token),
    h('label', {}, 'Passkey', passkey,
      h('small', {}, 'Encrypts your stored data. It stays on this machine; the same passkey gives the same key everywhere.')),
    h('button', { type: 'submit' }, 'Save'), out);
    return card(1, 'Cyber Supplies', status?.cysu, h('p', { class: 'hint' }, 'Stored only on this machine.'), form);
  }

  // ---- 2. LLM login ------------------------------------------------------------------
  function llmCard() {
    const out = msg();
    const mode = settings.llm.mode;
    const codex = settings.llm.codex;
    let chosen = mode === 'none' ? 'codex' : mode;

    const loginBox = h('div', { class: 'device-login', hidden: true });
    const startLogin = h('button', { onclick: () => signIn() }, codex.saved ? 'Sign in again' : 'Sign in with ChatGPT');
    const cancelLogin = h('button', { class: 'secondary', hidden: true, onclick: async () => { renderLogin(await api('/api/llm/codex-login', { method: 'DELETE' })); } }, 'Cancel');

    function renderLogin(login) {
      const active = ['starting', 'waiting'].includes(login.status);
      startLogin.hidden = active;
      cancelLogin.hidden = !active;
      loginBox.hidden = login.status === 'idle';
      const safeUrl = /^https:\/\/auth\.openai\.com\//.test(login.url || '') ? login.url : '';
      clear(loginBox,
        login.status === 'starting' && h('p', {}, 'Starting the sign-in…'),
        login.status === 'waiting' && [
          h('p', {}, '1. Open ', h('a', { href: safeUrl, target: '_blank', rel: 'noopener noreferrer' }, safeUrl), ' and sign in to your ChatGPT account.'),
          h('p', {}, '2. Enter this code: ', h('code', { class: 'code' }, login.code)),
          h('p', { class: 'hint' }, 'Waiting for you to finish… (the code expires after 15 minutes)'),
        ],
        login.status === 'succeeded' && h('p', { class: 'ok' }, 'Signed in. Your ChatGPT login is saved.'),
        login.status === 'failed' && h('p', { class: 'bad' }, login.error || 'Sign-in failed.'),
        login.status === 'cancelled' && h('p', {}, 'Sign-in cancelled.'));
    }
    async function pollLogin() {
      clearTimeout(poll);
      const login = await api('/api/llm/codex-login');
      renderLogin(login);
      if (['starting', 'waiting'].includes(login.status)) poll = setTimeout(pollLogin, 2000);
      else if (login.status === 'succeeded') await refresh();
    }
    async function signIn() {
      try { renderLogin(await api('/api/llm/codex-login', { method: 'POST' })); pollLogin(); }
      catch (err) { out.textContent = err.message; }
    }

    const apiKey = h('input', { type: 'password', autocomplete: 'off', placeholder: settings.llm.apiKey ? `saved (${settings.llm.apiKey}) — leave blank to keep` : 'sk-…' });
    const codexPane = h('div', {},
      h('p', { class: 'hint' }, 'Uses your ChatGPT plan through Codex. You sign in on openai.com with a one-time code; the login is kept on this machine.'),
      codex.saved && h('p', { class: 'ok' }, `ChatGPT login saved (${new Date(codex.savedAt).toLocaleString()}).`),
      h('div', { class: 'row' }, startLogin, cancelLogin,
        codex.saved && confirmButton('Forget login', 'Click again to forget', async () => { await api('/api/llm/codex-auth', { method: 'DELETE' }); await refresh(); }, 'secondary danger'),
        codex.saved && mode !== 'codex' && h('button', { class: 'secondary', onclick: async () => { await api('/api/settings', { method: 'PUT', body: { llm: { mode: 'codex' } } }); await refresh(); } }, 'Use this login')),
      loginBox);
    const keyPane = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          if (!apiKey.value && !settings.llm.apiKey) throw new Error('Paste your OpenAI API key');
          await api('/api/settings', { method: 'PUT', body: { llm: { mode: 'openai-api-key', apiKey: apiKey.value } } });
          await refresh();
        } catch (err) { out.textContent = err.message; }
      },
    },
    h('p', { class: 'hint' }, 'Billed to your OpenAI API account.'),
    h('label', {}, 'OpenAI API key', apiKey),
    h('button', { type: 'submit' }, mode === 'openai-api-key' ? 'Update key' : 'Use API key'));

    const panes = { codex: codexPane, 'openai-api-key': keyPane };
    const choice = (value, label) => h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'llm', value, checked: chosen === value, onchange: () => { chosen = value; for (const [k, p] of Object.entries(panes)) p.hidden = k !== value; } }),
      label);
    for (const [k, p] of Object.entries(panes)) p.hidden = k !== chosen;

    if (codex && !status?.llm.ready) api('/api/llm/codex-login').then((l) => { if (['starting', 'waiting'].includes(l.status)) { renderLogin(l); pollLogin(); } });

    return card(2, 'Your LLM', status?.llm.ready,
      h('p', { class: 'hint' }, 'Agents work with your own LLM account. Choose one:'),
      h('div', { class: 'row' }, choice('codex', 'Sign in with ChatGPT (Codex)'), choice('openai-api-key', 'OpenAI API key'),
        h('span', { class: 'hint' }, 'Claude, Kimi and GLM come later.')),
      codexPane, keyPane, out,
      status?.llm.ready && h('p', { class: 'ok' }, `In use: ${status.llm.mode === 'codex' ? 'your ChatGPT login' : `OpenAI API key ${settings.llm.apiKey}`}.`));
  }

  function render() {
    clearTimeout(poll);
    clear(view,
      h('h1', {}, 'Setup'),
      h('p', { class: 'lead' }, 'Two things and you are ready: your Cyber Supplies details, and the LLM your agents will use.'),
      !status?.docker && h('section', { class: 'card bad-card' }, h('h2', {}, 'Docker is not available'),
        h('p', {}, 'The engine runs every stage in a Docker container. Install Docker and make sure your user can run `docker ps`, then reload this page.')),
      cysuCard(),
      llmCard(),
      status?.configured
        ? h('section', { class: 'card ready' }, h('h2', {}, 'All set'), h('a', { class: 'button', href: '#/new' }, 'Start a run →'))
        : h('p', { class: 'hint' }, 'Runs can start once both steps are done.'));
  }

  render();
  return () => clearTimeout(poll);
}
