// lib.js: display logic for the web UI, with no DOM access (unit-tested in
// Node: test/web-lib.test.js). Everything here returns plain data; the views
// put it on the page as TEXT only (agent output is untrusted).

export const ACTIVE = ['queued', 'running'];
export const STAGE_TAGS = ['1', '2', '3', '4'];
export const EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// ---- time ---------------------------------------------------------------------

export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

// duration of anything with startedAt/finishedAt; still running → until `now`.
export function elapsed(item, now = Date.now()) {
  if (!item?.startedAt) return null;
  const end = item.finishedAt ? Date.parse(item.finishedAt) : now;
  return end - Date.parse(item.startedAt);
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDay(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// groupByDay: runs (newest first) → [{ day, runs }] in the same order.
export function groupByDay(runs) {
  const groups = [];
  for (const run of runs) {
    const day = fmtDay(run.createdAt);
    if (groups.at(-1)?.day !== day) groups.push({ day, runs: [] });
    groups.at(-1).runs.push(run);
  }
  return groups;
}

// ---- status ---------------------------------------------------------------------

const STATUS = {
  queued: { label: 'Queued', tone: 'run', icon: '…' },
  running: { label: 'Running', tone: 'run', icon: '▶' },
  pending: { label: 'Pending', tone: 'muted', icon: '·' },
  succeeded: { label: 'Succeeded', tone: 'ok', icon: '✓' },
  failed: { label: 'Failed', tone: 'bad', icon: '✕' },
  cancelled: { label: 'Cancelled', tone: 'warn', icon: '⊘' },
  interrupted: { label: 'Interrupted', tone: 'warn', icon: '!' },
  skipped: { label: 'Skipped', tone: 'muted', icon: '–' },
};
export const statusInfo = (status) => STATUS[status] || { label: String(status || 'unknown'), tone: 'muted', icon: '?' };

export const RUN_FILTERS = {
  all: () => true,
  active: (r) => ACTIVE.includes(r.status),
  succeeded: (r) => r.status === 'succeeded',
  failed: (r) => r.status === 'failed',
  stopped: (r) => ['cancelled', 'interrupted'].includes(r.status),
};

export function runTitle(run) {
  if (run.name) return run.name;
  const chain = (run.stages || []).map((s) => (s.tag ? `${s.tag}:${s.profile}` : s.profile)).join(' → ');
  return chain || 'Untitled run';
}

export function tokens(usage) {
  if (!usage) return '—';
  const k = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(usage.input_tokens ?? 0)} in · ${k(usage.output_tokens ?? 0)} out`;
}

// timeline: each stage's bar as % offset/width of the whole run.
export function timeline(run, now = Date.now()) {
  const start = run.startedAt ? Date.parse(run.startedAt) : null;
  if (!start) return run.stages.map(() => null);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const span = Math.max(end - start, 1);
  return run.stages.map((s) => {
    if (!s.startedAt) return null;
    const a = Date.parse(s.startedAt) - start;
    const b = (s.finishedAt ? Date.parse(s.finishedAt) : now) - start;
    const left = Math.min(100, Math.max(0, (a / span) * 100));
    return { left, width: Math.max(0.8, Math.min(100 - left, ((b - a) / span) * 100)) };
  });
}

// ---- activity feed from Codex events ------------------------------------------------

const ATTEMPT_LABEL = { initial: 'First attempt', fallback: 'Fallback attempt', reprompt: 'Follow-up prompt' };

// activity turns a stage's events into feed items. Items for the same Codex
// item id (started → updated → completed) are merged, keeping first position.
export function activity(events) {
  const items = [];
  const byId = new Map();
  let reprompt = 0;
  let attemptNo = 0; // Codex restarts item ids (item_0, …) in every attempt
  const upsert = (key, item) => {
    if (key && byId.has(key)) Object.assign(byId.get(key), item);
    else { items.push(item); if (key) byId.set(key, item); }
  };
  for (const e of events) {
    const time = e.time;
    switch (e.type) {
      case 'engine.attempt': {
        attemptNo += 1;
        const n = e.kind === 'reprompt' ? ` ${++reprompt}` : '';
        items.push({ kind: 'attempt', time, text: `${ATTEMPT_LABEL[e.kind] || e.kind}${n}${e.model ? ` · model ${e.model}` : ''}` });
        break;
      }
      case 'engine.attempt.finished':
        if (e.exitCode !== 0) items.push({ kind: 'error', time, text: `Attempt ended with exit code ${e.exitCode}` });
        break;
      case 'turn.completed':
        items.push({ kind: 'turn', time, text: `Turn finished · ${tokens(e.usage)}` });
        break;
      case 'turn.failed':
        items.push({ kind: 'error', time, text: e.error?.message || 'Turn failed' });
        break;
      case 'error':
        items.push({ kind: 'error', time, text: e.message || 'Error' });
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const it = e.item || {};
        const done = e.type === 'item.completed';
        const key = it.id ? `${attemptNo}:${it.id}` : null;
        switch (it.type) {
          case 'agent_message':
            upsert(key, { kind: 'message', time, text: it.text || '' });
            break;
          case 'reasoning':
            upsert(key, { kind: 'reasoning', time, text: it.text || '' });
            break;
          case 'command_execution':
            upsert(key, { kind: 'command', time, text: it.command || '', output: it.aggregated_output || '',
              exitCode: it.exit_code ?? null, running: !done && it.status !== 'completed' });
            break;
          case 'file_change':
            upsert(key, { kind: 'file', time, text: (it.changes || []).map((c) => `${c.kind || 'change'} ${c.path}`).join('\n') || 'files changed' });
            break;
          case 'mcp_tool_call':
            upsert(key, { kind: 'tool', time, text: `${it.server || '?'} · ${it.tool || '?'}${it.status ? ` (${it.status})` : ''}` });
            break;
          case 'web_search':
            upsert(key, { kind: 'tool', time, text: `web search: ${it.query || ''}` });
            break;
          case 'todo_list':
            upsert(key, { kind: 'todo', time, text: (it.items || []).map((t) => `${t.completed ? '☑' : '☐'} ${t.text}`).join('\n') });
            break;
          case 'error':
            upsert(key, { kind: 'error', time, text: it.message || 'Error' });
            break;
          default:
            if (done) upsert(key, { kind: 'other', time, text: `${it.type || e.type}` });
        }
        break;
      }
      default:
        break; // thread.started, turn.started: shown through other items
    }
  }
  return items;
}

// ---- run requests ----------------------------------------------------------------------

// buildRequest turns the "New run" form state into a POST /api/runs body.
//  form = { name, prompt, globalProfile, mode: 'tags'|'pick', skip: [...],
//           picked: [{ profile, tag }], model, fallbackModel, reasoningEffort,
//           overrides: { '1': 'model', ... }, reprompts: [{ stage, prompt }],
//           continueOnFailure }
export function buildRequest(form) {
  const req = { name: form.name?.trim() || undefined, prompt: form.prompt ?? '', globalProfile: form.globalProfile ?? '' };
  if (form.mode === 'pick') {
    req.stages = (form.picked || []).map((p) => (p.tag ? { profile: p.profile, tag: p.tag } : { profile: p.profile }));
  } else {
    req.fromTags = { skip: [...(form.skip || [])].sort() };
  }
  for (const key of ['model', 'fallbackModel', 'reasoningEffort']) {
    if (form[key]?.trim()) req[key] = form[key].trim();
  }
  const overrides = Object.entries(form.overrides || {}).filter(([, m]) => m?.trim())
    .map(([stage, model]) => ({ stage: Number(stage), model: model.trim() }));
  if (overrides.length) req.modelOverrides = overrides;
  const reprompts = (form.reprompts || []).filter((r) => r.prompt?.trim()).map((r) => ({ stage: String(r.stage), prompt: r.prompt }));
  if (reprompts.length) req.reprompts = reprompts;
  if (form.continueOnFailure === false) req.continueOnFailure = false;
  return Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined));
}

// formFromRequest is the reverse (for "edit & run again" and saved setups).
export function formFromRequest(req = {}) {
  return {
    name: req.name || '', prompt: req.prompt || '', globalProfile: req.globalProfile ?? '',
    mode: req.stages ? 'pick' : 'tags',
    skip: [...(req.fromTags?.skip || [])],
    picked: (req.stages || []).map((s) => ({ profile: s.profile, tag: s.tag || '' })),
    model: req.model || '', fallbackModel: req.fallbackModel || '', reasoningEffort: req.reasoningEffort || '',
    overrides: Object.fromEntries((req.modelOverrides || []).map((o) => [String(o.stage), o.model])),
    reprompts: (req.reprompts || []).map((r) => ({ stage: String(r.stage), prompt: r.prompt })),
    continueOnFailure: req.continueOnFailure !== false,
  };
}

// stageTag: a profile's own stage tag ("1".."4") if it has exactly one.
export function stageTag(profile) {
  const tags = Array.isArray(profile?.tag) ? profile.tag : [];
  return tags.length === 1 && STAGE_TAGS.includes(tags[0]) ? tags[0] : '';
}
