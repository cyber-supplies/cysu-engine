// Runs: every run, newest first, grouped by day (like Windmill's Runs page).

import { h, clear, api, badge } from '../dom.js';
import { groupByDay, statusInfo, fmtTime, fmtDuration, elapsed, runTitle, RUN_FILTERS, ACTIVE } from '../lib.js';

const FILTER_LABELS = { all: 'All', active: 'Running', succeeded: 'Succeeded', failed: 'Failed', stopped: 'Cancelled / interrupted' };

export async function runsView(view, { params }) {
  let filter = RUN_FILTERS[params.get('filter')] ? params.get('filter') : 'all';
  let runs = [];
  let timer = null;
  const list = h('div', { class: 'run-groups' });
  const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter runs' });
  const counter = h('span', { class: 'hint' });

  function renderFilters() {
    clear(filters, Object.entries(FILTER_LABELS).map(([key, label]) => {
      const n = runs.filter(RUN_FILTERS[key]).length;
      return h('button', { class: `chip-button ${key === filter ? 'active' : ''}`, 'aria-pressed': String(key === filter), onclick: () => { filter = key; render(); } }, `${label} (${n})`);
    }));
  }

  function row(run) {
    const info = statusInfo(run.status);
    return h('a', { class: `run-row tone-${info.tone}`, href: `#/runs/${run.id}` },
      badge(info),
      h('span', { class: 'run-time' }, fmtTime(run.createdAt)),
      h('span', { class: 'run-name' }, runTitle(run)),
      h('span', { class: 'stage-dots', title: run.stages.map((s) => `${s.tag ? `${s.tag}:` : ''}${s.profile} — ${statusInfo(s.status).label}`).join('\n') },
        run.stages.map((s) => h('span', { class: `stage-dot tone-${statusInfo(s.status).tone}` }))),
      h('span', { class: 'run-duration' }, fmtDuration(elapsed(run))));
  }

  function render() {
    renderFilters();
    const shown = runs.filter(RUN_FILTERS[filter]);
    counter.textContent = `${shown.length} run${shown.length === 1 ? '' : 's'}`;
    if (!runs.length) {
      return clear(list, h('section', { class: 'card empty' }, h('h2', {}, 'No runs yet'),
        h('p', {}, 'Runs appear here with their status, stages and logs.'), h('a', { class: 'button', href: '#/new' }, 'Start a run')));
    }
    if (!shown.length) return clear(list, h('p', { class: 'hint' }, 'No runs match this filter.'));
    clear(list, groupByDay(shown).map(({ day, runs: dayRuns }) =>
      h('section', { class: 'run-group' }, h('h3', {}, day), h('div', { class: 'run-rows' }, dayRuns.map(row)))));
  }

  async function load() {
    clearTimeout(timer);
    try { runs = await api('/api/runs'); render(); } catch (err) { clear(list, h('p', { class: 'bad' }, err.message)); }
    // Poll faster while something is running.
    timer = setTimeout(load, runs.some((r) => ACTIVE.includes(r.status)) ? 2000 : 8000);
  }

  clear(view,
    h('div', { class: 'page-head' }, h('h1', {}, 'Runs'), counter, h('a', { class: 'button', href: '#/new' }, 'New run')),
    filters, list);
  await load();
  return () => clearTimeout(timer);
}
