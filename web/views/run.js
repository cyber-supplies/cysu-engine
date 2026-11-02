// One run: status, inputs, stages with a timeline and attempts, and per
// stage a live activity feed, the final result and the raw log.
// Agent output is untrusted: it is only ever inserted as text (dom.js).

import { h, clear, api, text, badge, confirmButton } from '../dom.js';
import { app } from '../app.js';
import { statusInfo, fmtTime, fmtDuration, elapsed, runTitle, tokens, timeline, activity, ACTIVE } from '../lib.js';

const OUTPUT_PREVIEW = 4000;

// modelUsed: "model X", or "model X → fallback Y" when the fallback took over.
function modelUsed(stage) {
  const fallback = (stage.attempts || []).find((a) => a.kind === 'fallback');
  const first = stage.model || 'default';
  return fallback ? `model ${first} → fallback ${fallback.model}` : stage.model ? `model ${stage.model}` : '';
}

export async function runView(view, { id }) {
  let run = await api(`/api/runs/${id}`);
  let selected = Math.max(0, run.stages.findIndex((s) => s.status === 'running'));
  if (run.stages[selected]?.status === 'pending') selected = 0;
  let tab = 'activity';
  let events = [];
  let cursor = 0;
  let eventsFor = null;
  let timer = null;
  let stopped = false;

  const head = h('div');
  const stagesCard = h('section', { class: 'card' });
  const panel = h('section', { class: 'card stage-panel' });
  const feed = h('div', { class: 'feed', 'aria-live': 'polite' });
  const message = h('p', { class: 'msg', role: 'status' });

  // ---- header + actions ------------------------------------------------------------
  function renderHead() {
    const active = ACTIVE.includes(run.status);
    const actions = h('div', { class: 'actions' },
      active && h('button', { class: 'danger', onclick: async () => { try { run = await api(`/api/runs/${id}/cancel`, { method: 'POST' }); renderAll(); } catch (e) { message.textContent = e.message; } } }, 'Cancel run'),
      !active && run.request && h('button', { onclick: async () => {
        try { const next = await api(`/api/runs/${id}/rerun`, { method: 'POST' }); app.go(`#/runs/${next.id}`); } catch (e) { message.textContent = e.message; }
      } }, 'Run again'),
      run.request && h('a', { class: 'button secondary', href: `#/new?from=${id}` }, 'Edit & run again'),
      !active && h('a', { class: 'button secondary', href: `/api/runs/${id}/download`, download: '' }, 'Download'),
      !active && confirmButton('Delete', 'Click again to delete', async () => {
        try { await api(`/api/runs/${id}`, { method: 'DELETE' }); app.go('#/runs'); } catch (e) { message.textContent = e.message; }
      }, 'secondary danger'));
    const meta = (label, value) => value && h('div', { class: 'meta' }, h('span', {}, label), h('b', {}, value));
    clear(head,
      h('div', { class: 'page-head' }, h('a', { href: '#/runs', class: 'back' }, '← Runs'), actions),
      h('div', { class: 'run-head' },
        badge(statusInfo(run.status), 'big'),
        h('div', {}, h('h1', {}, runTitle(run)), h('p', { class: 'hint mono' }, run.id))),
      h('div', { class: 'metas' },
        meta('Started', fmtTime(run.startedAt || run.createdAt)),
        meta('Duration', fmtDuration(elapsed(run))),
        meta('Stages', `${run.stages.filter((s) => s.status === 'succeeded').length}/${run.stages.length} succeeded`),
        meta('Stages from', run.source === 'tags' ? `profile tags${run.skip?.length ? ` (skipping ${run.skip.join(', ')})` : ''}` : 'chosen profiles'),
        meta('Global profile', run.globalProfile || 'none'),
        meta('Model', run.model || 'default'),
        meta('Fallback', run.fallbackModel),
        meta('Reasoning', run.reasoningEffort),
        meta('On failure', run.continueOnFailure === false ? 'stop' : 'continue'),
        run.rerunOf && h('div', { class: 'meta' }, h('span', {}, 'Again of'), h('a', { href: `#/runs/${run.rerunOf}` }, run.rerunOf.slice(0, 8)))),
      message,
      run.error && h('p', { class: 'bad' }, run.error),
      h('details', { class: 'card inputs' }, h('summary', {}, 'Objective and inputs'),
        h('pre', { class: 'prompt' }, run.prompt),
        run.modelOverrides?.length > 0 && h('p', {}, 'Stage models: ', run.modelOverrides.map((o) => `stage ${o.stage} → ${o.model}`).join(', ')),
        run.reprompts?.length > 0 && [h('p', {}, 'Follow-up prompts:'), h('ol', {}, run.reprompts.map((r) => h('li', {}, `stage ${r.stage}: `, h('span', { class: 'pre' }, r.prompt))))]));
  }

  // ---- stages + timeline --------------------------------------------------------------
  function renderStages() {
    const bars = timeline(run);
    clear(stagesCard, h('h2', {}, 'Stages'),
      h('div', { class: 'stage-table', role: 'list' }, run.stages.map((s, i) => {
        const info = statusInfo(s.status);
        return h('button', { class: `stage-row ${i === selected ? 'selected' : ''}`, role: 'listitem', 'aria-pressed': String(i === selected), onclick: () => select(i) },
          h('span', { class: 'stage-tag' }, s.tag ? `#${s.tag}` : `${i + 1}`),
          h('span', { class: 'stage-name' }, s.profile),
          badge(info),
          h('span', { class: 'stage-attempts' }, (s.attempts || []).map((a) =>
            h('span', { class: `attempt tone-${statusInfo(a.status).tone}`, title: `${a.kind}${a.model ? ` · ${a.model}` : ''} · ${a.status}` },
              a.kind === 'initial' ? '1st' : a.kind === 'fallback' ? 'fallback' : 'follow-up'))),
          h('span', { class: 'stage-num' }, fmtDuration(elapsed(s))),
          h('span', { class: 'stage-num' }, tokens(s.usage)),
          h('span', { class: 'bar-track' }, bars[i] && h('span', { class: `bar tone-${info.tone}`, style: { left: `${bars[i].left}%`, width: `${bars[i].width}%` } })));
      })));
  }

  // ---- selected stage ---------------------------------------------------------------
  function select(i) {
    selected = i;
    renderStages();
    renderPanel();
  }

  async function loadEvents() {
    const stage = run.stages[selected];
    if (eventsFor !== selected) { events = []; cursor = 0; eventsFor = selected; }
    if (!stage || stage.status === 'pending' || stage.status === 'skipped') return;
    for (;;) {
      const page = await api(`/api/runs/${id}/stages/${selected}/events?after=${cursor}&limit=2000`);
      events.push(...page.events);
      cursor = page.next;
      if (page.events.length < 2000) break;
    }
  }

  function renderFeed() {
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    const items = activity(events);
    clear(feed, items.length ? items.map((item) => {
      switch (item.kind) {
        case 'attempt': return h('div', { class: 'feed-attempt' }, item.text);
        case 'message': return h('div', { class: 'feed-item message' }, h('div', { class: 'who' }, 'Agent'), h('div', { class: 'pre' }, item.text));
        case 'reasoning': return h('div', { class: 'feed-item reasoning' }, h('div', { class: 'who' }, 'Thinking'), h('div', { class: 'pre' }, item.text));
        case 'command': {
          const out = item.output || '';
          return h('div', { class: 'feed-item command' },
            h('div', { class: 'cmd' }, h('span', { class: 'mono' }, `$ ${item.text}`),
              item.running ? h('span', { class: 'badge tone-run' }, 'running') : item.exitCode !== null && h('span', { class: `badge tone-${item.exitCode === 0 ? 'ok' : 'bad'}` }, `exit ${item.exitCode}`)),
            out && h('details', {}, h('summary', {}, `output (${out.length.toLocaleString()} chars)`),
              h('pre', {}, out.length > OUTPUT_PREVIEW ? `${out.slice(0, OUTPUT_PREVIEW)}\n… (full output in the download)` : out)));
        }
        case 'error': return h('div', { class: 'feed-item error' }, h('div', { class: 'who' }, 'Error'), h('div', { class: 'pre' }, item.text));
        case 'turn': return h('div', { class: 'feed-turn' }, item.text);
        default: return h('div', { class: `feed-item ${item.kind}` }, h('div', { class: 'who' }, item.kind), h('div', { class: 'pre' }, item.text));
      }
    }) : h('p', { class: 'hint' }, statusMessage(run.stages[selected])));
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  }

  const statusMessage = (s) => ({
    pending: 'This stage has not started yet.',
    skipped: 'This stage was skipped (an earlier stage failed and the run stops on failure).',
    cancelled: 'This stage was cancelled before it produced anything.',
  }[s?.status] || (s?.status === 'running' ? 'Starting the container and installing profiles… (see Log)' : 'No activity recorded.'));

  async function renderPanel() {
    const stage = run.stages[selected];
    if (!stage) return clear(panel);
    const tabButton = (key, label) => h('button', { class: `tab ${tab === key ? 'active' : ''}`, role: 'tab', 'aria-selected': String(tab === key), onclick: () => { tab = key; renderPanel(); } }, label);
    const body = h('div', { class: 'tab-body' });
    clear(panel,
      h('div', { class: 'panel-head' },
        h('h2', {}, `Stage ${stage.tag ? `#${stage.tag} ` : ''}· ${stage.profile}`), badge(statusInfo(stage.status)),
        h('span', { class: 'hint' }, [modelUsed(stage), stage.turns && `${stage.turns} turn(s)`, stage.exitCode !== null && `exit ${stage.exitCode}`].filter(Boolean).join(' · '))),
      stage.errors?.length > 0 && (stage.status === 'succeeded'
        // The stage succeeded anyway (the fallback model took over): not an alarm.
        ? h('div', { class: 'errors recovered' }, h('p', { class: 'hint' }, 'Recovered from:'), stage.errors.map((e) => h('p', { class: 'pre' }, e)))
        : h('div', { class: 'errors' }, stage.errors.map((e) => h('p', { class: 'bad pre' }, e)))),
      h('div', { class: 'tabs', role: 'tablist' }, tabButton('activity', 'Activity'), tabButton('result', 'Result'), tabButton('log', 'Log')),
      body);
    if (tab === 'activity') {
      clear(body, feed);
      await loadEvents().catch(() => {});
      renderFeed();
    } else if (tab === 'result') {
      clear(body, stage.result ? h('div', { class: 'pre result' }, stage.result) : h('p', { class: 'hint' }, 'No final answer yet.'));
    } else {
      const log = await text(`/api/runs/${id}/stages/${selected}/log`).catch((e) => `(could not load the log: ${e.message})`);
      clear(body, h('pre', { class: 'log' }, log || '(empty)'));
    }
  }

  function renderAll() {
    renderHead();
    renderStages();
    renderPanel();
  }

  // ---- live updates ---------------------------------------------------------------------
  async function tick() {
    if (stopped) return;
    const wasActive = ACTIVE.includes(run.status);
    try {
      const before = run.stages[selected]?.status;
      run = await api(`/api/runs/${id}`);
      // Follow the run: when the selected stage finishes, move to the running one.
      const running = run.stages.findIndex((s) => s.status === 'running');
      if (running >= 0 && before !== 'running' && running !== selected && tab === 'activity') selected = running;
      renderHead();
      renderStages();
      if (tab === 'activity') { await loadEvents(); renderFeed(); }
      else if (tab === 'log' && run.stages[selected]?.status === 'running') await renderPanel();
      if (!ACTIVE.includes(run.status) && wasActive) await renderPanel();
    } catch { /* keep trying */ }
    if (ACTIVE.includes(run.status) && !stopped) timer = setTimeout(tick, 2000);
  }

  clear(view, head, stagesCard, panel);
  renderAll();
  if (ACTIVE.includes(run.status)) timer = setTimeout(tick, 2000);
  return () => { stopped = true; clearTimeout(timer); };
}
