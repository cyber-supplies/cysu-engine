// workspaces.js: named, saved run setups. A workspace is a blank template:
// global profile, stage profiles (from tags or picked in order), models,
// follow-ups… but NO objective. The user gives the objective when they start a
// run (/run in the CLI, POST /api/workspaces/{id}/run {"objective"}), and a
// schedule carries its own. Stored in <data>/workspaces.json.
//
// A workspace is referred to ONLY by its exact id. Its name is a label for
// people (unique, so lists stay readable), never a way to look it up.
//
// Older engines called these "saved setups" (workflows.json); they are carried
// over the first time workspaces are loaded.

import { randomUUID } from 'node:crypto';
import { load, save } from './store.js';

export class WorkspaceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim();

export const NO_OBJECTIVE = 'A workspace has no objective; give it when you start a run (POST /api/workspaces/{id}/run {"objective"})';

// objectiveOf: the objective an older workspace stored ('' if none): its
// prompt, else the first stage's own prompt.
const objectiveOf = (request) => {
  const stagePrompt = (Array.isArray(request?.stages) ? request.stages : []).map((st) => st?.prompt).find((p) => typeof p === 'string' && p.trim());
  return typeof request?.prompt === 'string' && request.prompt.trim() ? request.prompt : (stagePrompt || '');
};

// withoutObjective: the request with every objective removed.
const withoutObjective = (request) => {
  const { prompt, ...rest } = request;
  if (Array.isArray(rest.stages)) rest.stages = rest.stages.map((st) => { if (!st || typeof st !== 'object') return st; const { prompt: p, ...own } = st; return own; });
  return rest;
};

export class Workspaces {
  constructor({ store = { load, save } } = {}) {
    this.store = store;
    this.queue = Promise.resolve(); // one write at a time
  }

  async all() {
    let items = await this.store.load('workspaces', null);
    if (items === null) {
      const old = await this.store.load('workflows', []);
      const now = new Date().toISOString();
      items = (Array.isArray(old) ? old : []).filter((w) => w && w.request && typeof w.request === 'object')
        .map((w) => ({ id: w.id || randomUUID(), name: cleanName(w.name) || 'Untitled', request: w.request, createdAt: w.updatedAt || now, updatedAt: w.updatedAt || now }));
      await this.store.save('workspaces', items);
    }
    return items;
  }

  async list() {
    return (await this.all()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // get finds a workspace by its exact id: no names, no prefixes, no trimming.
  async get(id) {
    const ws = typeof id === 'string' && id ? (await this.all()).find((w) => w.id === id) : null;
    if (!ws) throw new WorkspaceError(404, `No workspace with id "${String(id ?? '').slice(0, 100)}"`);
    return ws;
  }

  // changeStages adds/removes picked stage profiles (in order) or sets the
  // global profile. Workspaces that build stages from tags have no list to
  // change. tagOf(profileId) gives the profile's stage tag ("1"-"4", or "" if
  // it has none): it is saved with each added stage, so per-tag models and
  // follow-ups reach it. Returns { workspace, added, skipped, removed }.
  async changeStages(id, { add = [], remove = [], global, tagOf = () => '' } = {}) {
    return this.write(async () => {
      const items = await this.all();
      const ws = await this.get(id);
      const request = structuredClone(ws.request);
      if ((add.length || remove.length) && request.fromTags !== undefined) {
        throw new WorkspaceError(409, `Workspace "${ws.name}" builds its stages from profile tags; switch it to picked stages (PATCH its request) first`);
      }
      const stages = Array.isArray(request.stages) ? request.stages : [];
      const out = { added: [], skipped: [], removed: [] };
      for (const id of remove) {
        const before = stages.length;
        const kept = stages.filter((st) => st.profile !== id);
        if (kept.length === before) throw new WorkspaceError(400, `${id} is not a stage of "${ws.name}"`);
        stages.splice(0, stages.length, ...kept);
        out.removed.push(id);
      }
      for (const id of add) {
        if (stages.some((st) => st.profile === id)) out.skipped.push(id);
        else { const tag = tagOf(id); stages.push(tag ? { profile: id, tag } : { profile: id }); out.added.push(id); }
      }
      if (add.length || remove.length) request.stages = stages;
      if (global !== undefined) request.globalProfile = global;
      const next = { ...ws, request, updatedAt: new Date().toISOString() };
      await this.store.save('workspaces', items.map((w) => (w.id === ws.id ? next : w)));
      return { workspace: next, ...out };
    });
  }

  write(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }

  static check(name, request) {
    if (!name) throw new WorkspaceError(400, 'A workspace needs a name');
    if (name.length > 80) throw new WorkspaceError(400, 'Workspace names are limited to 80 characters');
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new WorkspaceError(400, 'A workspace needs a run request');
    // An empty prompt is allowed (older clients send one) and dropped.
    if (objectiveOf(request)) throw new WorkspaceError(400, NO_OBJECTIVE);
  }

  // takeObjectives moves objectives out of workspaces saved by older engines.
  // It returns Map(workspace id → objective) and calls keep(map) BEFORE removing
  // them, so a crash in between loses nothing (keep runs again next start).
  async takeObjectives(keep) {
    return this.write(async () => {
      const items = await this.all();
      const found = new Map(items.filter((w) => objectiveOf(w.request)).map((w) => [w.id, objectiveOf(w.request)]));
      const dirty = items.some((w) => w.request && ('prompt' in w.request || (Array.isArray(w.request.stages) && w.request.stages.some((st) => st && 'prompt' in st))));
      if (found.size) await keep(found);
      if (dirty) await this.store.save('workspaces', items.map((w) => (w.request ? { ...w, request: withoutObjective(w.request) } : w)));
      return found;
    });
  }

  async create({ name, request }) {
    name = cleanName(name);
    Workspaces.check(name, request);
    return this.write(async () => {
      const items = await this.all();
      if (items.some((w) => w.name.toLowerCase() === name.toLowerCase())) throw new WorkspaceError(409, `A workspace called "${name}" already exists`);
      const now = new Date().toISOString();
      const ws = { id: randomUUID(), name, request: withoutObjective(structuredClone(request)), createdAt: now, updatedAt: now };
      await this.store.save('workspaces', [...items, ws]);
      return ws;
    });
  }

  async update(id, { name, request } = {}) {
    return this.write(async () => {
      const items = await this.all();
      const ws = await this.get(id);
      const next = { ...ws, name: name === undefined ? ws.name : cleanName(name), request: request === undefined ? ws.request : structuredClone(request) };
      Workspaces.check(next.name, next.request);
      next.request = withoutObjective(next.request);
      if (items.some((w) => w.id !== ws.id && w.name.toLowerCase() === next.name.toLowerCase())) throw new WorkspaceError(409, `A workspace called "${next.name}" already exists`);
      next.updatedAt = new Date().toISOString();
      await this.store.save('workspaces', items.map((w) => (w.id === ws.id ? next : w)));
      return next;
    });
  }

  async delete(id) {
    return this.write(async () => {
      const ws = await this.get(id);
      await this.store.save('workspaces', (await this.all()).filter((w) => w.id !== ws.id));
      return ws;
    });
  }
}
