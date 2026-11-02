// Assistant: chat with the main agent. It plans and PROPOSES runs and
// profile changes; the user approves or rejects each one here.
// Everything the agent writes is shown as text only.

import { h, clear, api, badge, confirmButton } from '../dom.js';
import { app } from '../app.js';
import { statusInfo } from '../lib.js';

const TOOL_LABELS = {
  get_setup_status: 'checked the setup', start_chatgpt_login: 'started a ChatGPT sign-in', get_chatgpt_login_status: 'checked the sign-in',
  list_profiles: 'listed your profiles', get_profile: 'read a profile', plan_profile_change: 'planned a profile change',
  propose_profile_change: 'proposed a profile change', plan_run: 'planned a run', propose_run: 'proposed a run',
  propose_rerun: 'proposed running again', get_proposal: 'checked a proposal', list_runs: 'listed runs', get_run: 'read a run',
  get_stage_activity: 'read stage activity', get_stage_log: 'read a stage log', cancel_run: 'cancelled a run', list_saved_setups: 'listed saved setups',
};

export async function chatView(view, { id }) {
  let chats = await api('/api/chats');
  let chat = id ? await api(`/api/chats/${id}`).catch(() => null) : null;
  let proposals = await api('/api/proposals').catch(() => []);
  let timer = null;
  let stopped = false;
  let shown = ''; // what is on screen; re-render only when it changes (keeps open details, focus, clicks)

  const list = h('nav', { class: 'chat-list', 'aria-label': 'Chats' });
  const thread = h('div', { class: 'chat-thread', 'aria-live': 'polite' });
  const input = h('textarea', { rows: 3, placeholder: 'Ask the assistant… e.g. "Set me up a recon run on example.com (we are authorized)". Ctrl+Enter sends.' });
  const sendButton = h('button', { onclick: () => send() }, 'Send');
  const stopButton = h('button', { class: 'secondary danger', hidden: true, onclick: async () => { try { await api(`/api/chats/${chat.id}/stop`, { method: 'POST' }); } catch (e) { note.textContent = e.message; } } }, 'Stop');
  const note = h('p', { class: 'msg', role: 'status' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });

  // ---- chat list -----------------------------------------------------------------
  function renderList() {
    clear(list,
      h('button', { class: 'new-chat', onclick: async () => { const c = await api('/api/chats', { method: 'POST', body: {} }); app.go(`#/chat/${c.id}`); } }, '+ New chat'),
      chats.map((c) => h('a', { class: `chat-item ${chat?.id === c.id ? 'active' : ''}`, href: `#/chat/${c.id}` },
        h('span', { class: 'chat-title' }, c.title), c.status === 'thinking' && h('span', { class: 'hint' }, ' · answering…'))),
      chats.length === 0 && h('p', { class: 'hint' }, 'No chats yet.'));
  }

  // ---- proposal cards --------------------------------------------------------------
  function proposalCard(p) {
    if (!p) return h('div', { class: 'proposal muted' }, 'Proposal not found (the engine was restarted, or it expired).');
    const decided = p.status !== 'pending';
    const head = h('div', { class: 'proposal-head' },
      h('b', {}, p.kind === 'profile' ? `Profile change: ${p.plan.profile}` : p.kind === 'rerun' ? 'Run again' : 'Run'),
      badge(proposalStatus(p.status)));
    let body;
    if (p.kind === 'profile') {
      const d = p.plan;
      const items = (label, list, cls) => list.length > 0 && h('div', {}, h('span', { class: `hint ${cls}` }, `${label}: `),
        list.map((x) => h('details', { class: 'diff-item' }, h('summary', {}, `${x.kind} · ${x.name}`), x.preview && h('pre', {}, x.preview))));
      body = h('div', {},
        h('p', {}, d.exists ? 'Edit an existing profile.' : 'Create a NEW profile.'),
        JSON.stringify(d.tagsBefore) !== JSON.stringify(d.tagsAfter) && h('p', {}, 'Tags: ', h('code', {}, JSON.stringify(d.tagsBefore ?? [])), ' → ', h('code', {}, JSON.stringify(d.tagsAfter))),
        items('Add', d.created, 'ok'), items('Change', d.updated, 'warn'), (d.removed || []).length > 0 && h('p', { class: 'bad' }, `Remove: ${d.removed.map((r) => `${r.kind} ${r.name}`).join(', ')}`));
    } else {
      body = h('div', {},
        h('ol', { class: 'plan-list' }, p.plan.stages.map((s) => h('li', {},
          h('b', {}, `${s.tag ? `#${s.tag} ` : ''}${s.profile}`), ` · model ${s.model || 'default'}`,
          s.fallbackModel && ` · fallback ${s.fallbackModel}`, s.reprompts?.length > 0 && ` · ${s.reprompts.length} follow-up(s)`))),
        h('details', {}, h('summary', {}, 'Objective'), h('pre', { class: 'prompt' }, p.request.prompt)),
        h('p', { class: 'hint' }, `Global profile: ${p.plan.globalProfile || 'none'} · on failure: ${p.plan.continueOnFailure === false ? 'stop' : 'continue'}`));
    }
    const decide = async (what) => {
      let error = '';
      try { await api(`/api/proposals/${p.id}/${what}`, { method: 'POST' }); } catch (e) { error = e.message; }
      // Draw what the engine now says (a background refresh may have been in flight).
      clearTimeout(timer);
      await refresh().catch(() => {});
      shown = JSON.stringify([chats, chat, proposals]);
      render();
      if (error) note.textContent = error;
      timer = setTimeout(poll, 4000);
    };
    return h('div', { class: `proposal ${decided ? 'decided' : ''}` },
      head,
      p.summary && h('p', { class: 'pre' }, p.summary),
      body,
      !decided && h('div', { class: 'row' },
        h('button', { onclick: () => decide('approve') }, p.kind === 'profile' ? 'Approve change' : 'Approve and start'),
        confirmButton('Reject', 'Click again to reject', () => decide('reject'), 'secondary danger')),
      p.status === 'approved' && p.runId && h('a', { class: 'button secondary', href: `#/runs/${p.runId}` }, 'Open the run →'),
      p.status === 'stale' && h('p', { class: 'warn' }, p.error || 'Things changed since this was proposed; ask the assistant again.'));
  }
  const proposalStatus = (s) => ({ pending: { label: 'Waiting for you', tone: 'run', icon: '?' }, approved: { label: 'Approved', tone: 'ok', icon: '✓' }, rejected: { label: 'Rejected', tone: 'muted', icon: '✕' },
    expired: { label: 'Expired', tone: 'muted', icon: '⌛' }, stale: { label: 'Out of date', tone: 'warn', icon: '!' } }[s] || statusInfo(s));

  // ---- messages ----------------------------------------------------------------------
  function message(m) {
    switch (m.role) {
      case 'user': return h('div', { class: 'msg-user' }, h('div', { class: 'pre' }, m.text));
      case 'agent': return h('div', { class: 'msg-agent' }, h('div', { class: 'who' }, 'Assistant'), h('div', { class: 'pre' }, m.text));
      case 'tool': return h('div', { class: `msg-tool ${m.status}` },
        h('details', {}, h('summary', {}, m.status === 'running' ? '⋯ ' : m.status === 'failed' ? '✕ ' : '✓ ', TOOL_LABELS[m.tool] || m.tool),
          m.text && h('pre', {}, m.text), m.result && h('pre', {}, m.result)),
        m.proposalId && proposalCard(proposals.find((p) => p.id === m.proposalId)));
      case 'error': return h('div', { class: 'msg-error pre' }, m.text);
      default: return h('div', { class: 'msg-notice' }, m.text);
    }
  }

  function render() {
    renderList();
    if (!chat) {
      return clear(thread, h('div', { class: 'chat-empty' },
        h('h2', {}, 'Your Cyber Supplies assistant'),
        h('p', {}, 'Tell it what you want to do. It checks your setup, plans runs from your profiles, and can create or edit profiles. Every run and every profile change is a proposal you approve here first.'),
        h('button', { onclick: async () => { const c = await api('/api/chats', { method: 'POST', body: {} }); app.go(`#/chat/${c.id}`); } }, 'Start a chat')));
    }
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    clear(thread, chat.messages.length ? chat.messages.map(message) : h('p', { class: 'hint' }, 'Say hello, or describe what you want to set up.'),
      chat.status === 'thinking' && h('div', { class: 'msg-thinking' }, 'Thinking…'));
    if (nearBottom) thread.scrollTop = thread.scrollHeight;
    const thinking = chat.status === 'thinking';
    sendButton.disabled = thinking;
    stopButton.hidden = !thinking;
  }

  // Only the newest refresh is applied: an older one finishing late must not
  // draw outdated state (e.g. a proposal the user just approved as pending).
  let generation = 0;
  async function refresh() {
    const mine = ++generation;
    const [c, p, current] = await Promise.all([api('/api/chats'), api('/api/proposals').catch(() => proposals),
      chat ? api(`/api/chats/${chat.id}`).catch(() => chat) : null]);
    if (mine !== generation) return;
    chats = c; proposals = p;
    if (current) chat = current;
  }

  async function poll() {
    clearTimeout(timer);
    if (stopped) return;
    try {
      await refresh();
      const now = JSON.stringify([chats, chat, proposals]);
      if (now !== shown) { shown = now; render(); }
    } catch { /* keep trying */ }
    const pending = proposals.some((p) => p.status === 'pending');
    timer = setTimeout(poll, chat?.status === 'thinking' ? 1200 : pending ? 4000 : 10_000);
  }

  async function send() {
    if (!chat) chat = await api('/api/chats', { method: 'POST', body: {} });
    const text = input.value;
    if (!text.trim()) return;
    note.textContent = '';
    try {
      chat = await api(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { text } });
      input.value = '';
      if (location.hash !== `#/chat/${chat.id}`) history.replaceState(null, '', `#/chat/${chat.id}`);
      render();
      poll();
    } catch (e) { note.textContent = e.message; }
  }

  const ready = app.status?.llm?.ready;
  clear(view,
    h('div', { class: 'page-head' }, h('h1', {}, 'Assistant'),
      chat && confirmButton('Delete chat', 'Click again to delete', async () => { try { await api(`/api/chats/${chat.id}`, { method: 'DELETE' }); app.go('#/chat'); } catch (e) { note.textContent = e.message; } }, 'secondary danger')),
    !ready && h('section', { class: 'card bad-card' }, 'The assistant uses your LLM login. ', h('a', { href: '#/setup' }, 'Log in in Setup'), ' first.'),
    h('div', { class: 'chat-layout' }, list,
      h('section', { class: 'card chat-main' }, thread,
        h('div', { class: 'chat-input' }, input, h('div', { class: 'row' }, sendButton, stopButton, h('span', { class: 'hint' }, 'The assistant only uses engine tools. It never needs your token, passkey or keys.')), note))));
  render();
  shown = JSON.stringify([chats, chat, proposals]);
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; }); // after layout: open at the latest message
  timer = setTimeout(poll, 1000);
  return () => { stopped = true; clearTimeout(timer); };
}
