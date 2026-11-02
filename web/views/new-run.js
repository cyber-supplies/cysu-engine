// New run: the Windmill flow's inputs. Stages come from profile tags (like
// the old flow) or from profiles picked by hand; preview the plan, start.

import { h, clear, api, confirmButton } from '../dom.js';
import { app } from '../app.js';
import { buildRequest, formFromRequest, stageTag, STAGE_TAGS, EFFORTS } from '../lib.js';

const LAST_KEY = 'cysu-engine:last-run-request';
const readLast = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; } };
const writeLast = (req) => { try { localStorage.setItem(LAST_KEY, JSON.stringify(req)); } catch { /* private mode */ } };

export async function newRunView(view, { params }) {
  const [settings, saved] = await Promise.all([api('/api/settings'), api('/api/workflows').catch(() => [])]);
  let profiles = [];
  let profilesError = '';
  try { profiles = await api('/api/profiles'); } catch (err) { profilesError = err.message; }

  // Prefill: an earlier run ("edit & run again"), a saved setup, or the last request.
  let source = 'New run';
  let form;
  if (params.get('from')) {
    const run = await api(`/api/runs/${params.get('from')}`).catch(() => null);
    if (run?.request) { form = formFromRequest(run.request); source = 'Edit & run again'; }
  } else if (params.get('setup')) {
    const setup = saved.find((s) => s.id === params.get('setup'));
    if (setup) { form = formFromRequest(setup.request); source = `Saved setup: ${setup.name}`; }
  }
  form ||= formFromRequest(readLast() || { globalProfile: settings.globalProfile || '' });

  const planBox = h('div', { class: 'plan' });
  const out = h('p', { class: 'msg', role: 'status' });
  const sections = {
    stages: h('div'), overrides: h('div'), reprompts: h('div'), saved: h('div', { class: 'row saved-row' }),
  };

  const bind = (key, el, read = (e) => e.target.value) => { el.addEventListener('input', (e) => { form[key] = read(e); clear(planBox); }); return el; };
  const input = (key, attrs = {}) => bind(key, h('input', { value: form[key] || '', ...attrs }));

  // ---- stages ------------------------------------------------------------------------
  const byTag = Object.fromEntries(STAGE_TAGS.map((t) => [t, profiles.filter((p) => stageTag(p) === t && p.id !== form.globalProfile).map((p) => p.id)]));
  function renderStages() {
    const mode = (value, label) => h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'mode', value, checked: form.mode === value, onchange: () => { form.mode = value; clear(planBox); renderStages(); } }), label);
    let body;
    if (form.mode === 'tags') {
      body = h('div', { class: 'tag-grid' }, STAGE_TAGS.map((t) => h('label', { class: `tag-cell ${form.skip.includes(t) ? 'skipped' : ''}` },
        h('span', { class: 'tag-head' },
          h('input', { type: 'checkbox', checked: !form.skip.includes(t), onchange: (e) => {
            form.skip = e.target.checked ? form.skip.filter((x) => x !== t) : [...form.skip, t];
            clear(planBox); renderStages();
          } }),
          `Stage ${t}`),
        h('span', { class: 'tag-profiles' }, byTag[t]?.length ? byTag[t].join(', ') : profilesError ? '?' : 'no profile'))));
    } else {
      const add = (p) => { form.picked.push({ profile: p.id, tag: stageTag(p) }); clear(planBox); renderStages(); };
      const move = (i, d) => { const [x] = form.picked.splice(i, 1); form.picked.splice(Math.max(0, Math.min(form.picked.length, i + d)), 0, x); clear(planBox); renderStages(); };
      body = h('div', { class: 'pick' },
        h('div', { class: 'palette' }, h('p', { class: 'hint' }, 'Click (or drag) a profile to add it as a stage:'),
          profiles.filter((p) => p.id !== form.globalProfile).map((p) => h('button', {
            type: 'button', class: 'chip', draggable: 'true', onclick: () => add(p),
            ondragstart: (e) => e.dataTransfer.setData('text/plain', p.id),
          }, p.id, stageTag(p) && h('small', {}, ` #${stageTag(p)}`)))),
        h('ol', {
          class: 'picked', ondragover: (e) => e.preventDefault(),
          ondrop: (e) => { e.preventDefault(); const p = profiles.find((x) => x.id === e.dataTransfer.getData('text/plain')); if (p) add(p); },
        }, form.picked.length ? form.picked.map((s, i) => h('li', {},
          h('span', { class: 'mono' }, s.profile),
          h('select', { 'aria-label': `Stage tag for ${s.profile}`, onchange: (e) => { s.tag = e.target.value; clear(planBox); } },
            h('option', { value: '', selected: !s.tag }, 'no tag'), STAGE_TAGS.map((t) => h('option', { value: t, selected: s.tag === t }, `tag ${t}`))),
          h('button', { type: 'button', class: 'icon', title: 'Move up', 'aria-label': 'Move up', onclick: () => move(i, -1) }, '↑'),
          h('button', { type: 'button', class: 'icon', title: 'Move down', 'aria-label': 'Move down', onclick: () => move(i, 1) }, '↓'),
          h('button', { type: 'button', class: 'icon', title: 'Remove', 'aria-label': 'Remove', onclick: () => { form.picked.splice(i, 1); clear(planBox); renderStages(); } }, '✕')))
          : h('li', { class: 'hint' }, 'No stages yet.')));
    }
    clear(sections.stages,
      h('div', { class: 'row' }, mode('tags', 'By profile tags (stage 1 → 4, like the Windmill flow)'), mode('pick', 'Pick profiles')),
      profilesError && h('p', { class: 'bad' }, `Could not load your profiles: ${profilesError}`),
      body);
  }

  // ---- per-stage models + follow-ups ----------------------------------------------------
  function renderOverrides() {
    clear(sections.overrides, h('div', { class: 'grid4' }, STAGE_TAGS.map((t) => h('label', {}, `Stage ${t} model`,
      h('input', { value: form.overrides[t] || '', placeholder: 'same as Model', oninput: (e) => { form.overrides[t] = e.target.value; clear(planBox); } })))));
  }
  function renderReprompts() {
    clear(sections.reprompts,
      form.reprompts.map((r, i) => h('div', { class: 'reprompt' },
        h('select', { 'aria-label': 'Stage', onchange: (e) => { r.stage = e.target.value; clear(planBox); } },
          STAGE_TAGS.map((t) => h('option', { value: t, selected: r.stage === t }, `after stage ${t}`))),
        h('textarea', { rows: 2, value: r.prompt, placeholder: 'e.g. Start the second wave, with fresh hypotheses.', oninput: (e) => { r.prompt = e.target.value; clear(planBox); } }),
        h('button', { type: 'button', class: 'icon', 'aria-label': 'Remove follow-up', onclick: () => { form.reprompts.splice(i, 1); renderReprompts(); } }, '✕'))),
      h('button', { type: 'button', class: 'secondary', onclick: () => { form.reprompts.push({ stage: form.reprompts.at(-1)?.stage || '2', prompt: '' }); renderReprompts(); } }, '+ Add follow-up prompt'));
  }

  // ---- saved setups --------------------------------------------------------------------
  function renderSaved() {
    const name = h('input', { placeholder: 'name for this setup', value: form.name || '' });
    clear(sections.saved,
      saved.length > 0 && h('select', { 'aria-label': 'Load a saved setup', onchange: (e) => { if (e.target.value) app.go(`#/new?setup=${e.target.value}`); } },
        h('option', { value: '' }, `Load a saved setup (${saved.length})…`), saved.map((s) => h('option', { value: s.id }, s.name))),
      name,
      h('button', { type: 'button', class: 'secondary', onclick: async () => {
        try {
          const existing = saved.find((s) => s.name === name.value.trim());
          const setup = await api('/api/workflows', { method: 'POST', body: { id: existing?.id, name: name.value, request: buildRequest(form) } });
          out.textContent = `Saved as "${setup.name}".`;
          saved.splice(0, saved.length, ...(await api('/api/workflows')));
          renderSaved();
        } catch (err) { out.textContent = err.message; }
      } }, 'Save setup'),
      params.get('setup') && confirmButton('Delete setup', 'Click again to delete', async () => {
        await api(`/api/workflows/${params.get('setup')}`, { method: 'DELETE' }); app.go('#/new');
      }, 'secondary danger'));
  }

  // ---- plan + start ---------------------------------------------------------------------
  async function preview() {
    try {
      const plan = await api('/api/runs/plan', { method: 'POST', body: buildRequest(form) });
      clear(planBox, h('h3', {}, `Plan: ${plan.stages.length} stage(s), one container each`),
        h('ol', { class: 'plan-list' }, plan.stages.map((s) => h('li', {},
          h('b', {}, `${s.tag ? `#${s.tag} ` : ''}${s.profile}`),
          ` · model ${s.model || 'default'}`,
          s.fallbackModel && ` · fallback ${s.fallbackModel}`,
          s.reprompts.length > 0 && ` · ${s.reprompts.length} follow-up(s)`))),
        h('p', { class: 'hint' }, `Global profile: ${plan.globalProfile || 'none'} · on failure: ${plan.continueOnFailure ? 'continue with the next stage' : 'stop'}`));
      return plan;
    } catch (err) {
      clear(planBox, h('p', { class: 'bad' }, err.message));
      return null;
    }
  }
  async function start() {
    out.textContent = '';
    try {
      const request = buildRequest(form);
      const run = await api('/api/runs', { method: 'POST', body: request });
      writeLast(request);
      app.go(`#/runs/${run.id}`);
    } catch (err) { clear(planBox, h('p', { class: 'bad' }, err.message)); }
  }

  const globalSelect = h('select', { onchange: (e) => { form.globalProfile = e.target.value; clear(planBox); } },
    h('option', { value: '', selected: !form.globalProfile }, 'none'),
    profiles.map((p) => h('option', { value: p.id, selected: form.globalProfile === p.id }, p.id)),
    form.globalProfile && !profiles.some((p) => p.id === form.globalProfile) && h('option', { value: form.globalProfile, selected: true }, form.globalProfile));

  clear(view,
    h('div', { class: 'page-head' }, h('h1', {}, source)),
    h('section', { class: 'card' }, sections.saved),
    h('section', { class: 'card' },
      h('h2', {}, 'Objective'),
      h('label', {}, 'Name (optional)', input('name', { placeholder: 'e.g. example.com recon' })),
      h('label', {}, 'Campaign objective',
        bind('prompt', h('textarea', { rows: 6, value: form.prompt, placeholder: 'Target, authorization scope, accounts, constraints and objective. Every stage gets this.' })),
        h('small', {}, 'Only target systems you are authorized to test.')),
      h('label', {}, 'Global profile', globalSelect, h('small', {}, 'Installed as the user in every stage.'))),
    h('section', { class: 'card' }, h('h2', {}, 'Stages'), sections.stages),
    h('section', { class: 'card' },
      h('h2', {}, 'Models'),
      h('div', { class: 'grid3' },
        h('label', {}, 'Model', input('model', { placeholder: 'default' })),
        h('label', {}, 'Fallback model', input('fallbackModel', { placeholder: 'none' }), h('small', {}, 'Retried once with this if a stage\'s first attempt fails.')),
        h('label', {}, 'Reasoning effort', bind('reasoningEffort', h('select', {}, EFFORTS.map((e) => h('option', { value: e, selected: form.reasoningEffort === e }, e || 'model default')))))),
      h('details', { open: Object.values(form.overrides).some(Boolean) }, h('summary', {}, 'Model per stage tag'), sections.overrides)),
    h('section', { class: 'card' },
      h('h2', {}, 'Follow-up prompts'),
      h('p', { class: 'hint' }, 'After a stage succeeds, each follow-up is sent to the same agent conversation, in order.'),
      sections.reprompts,
      h('label', { class: 'choice' }, bind('continueOnFailure', h('input', { type: 'checkbox', checked: form.continueOnFailure }), (e) => e.target.checked),
        'If a stage fails, continue with the next stage')),
    h('section', { class: 'card start' },
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: preview }, 'Preview plan'), h('button', { type: 'button', onclick: start }, 'Start run ▶')),
      out, planBox));

  renderStages();
  renderOverrides();
  renderReprompts();
  renderSaved();
  return () => {};
}
