// workspaces.js: named, saved run setups. A workspace holds a run request
// (global profile, stage profiles from tags or picked in order, objective,
// models, follow-ups…). The assistant builds them; the user starts one with
// /run in the CLI. Stored in <data>/workspaces.json.
//
// One workspace is "current" (shared by the CLI and the assistant): `current`
// can be used wherever a workspace name is expected, and /run without a name
// starts it. Stored in <data>/workspace-current.json.
//
// Older engines called these "saved setups" (workflows.json); they are carried
// over the first time workspaces are loaded.

import { randomUUID } from 'node:crypto';
import { load, save } from './store.js';

export class WorkspaceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim();
const RESERVED = ['current'];

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

  // find by id, by name (case-insensitive) — the CLI and the assistant use
  // names — or "current".
  async find(ref) {
    const key = cleanName(ref);
    if (!key) return null;
    if (key.toLowerCase() === 'current') return this.current();
    const items = await this.all();
    return items.find((w) => w.id === key) || items.find((w) => w.name.toLowerCase() === key.toLowerCase()) || null;
  }

  async get(ref) {
    const ws = await this.find(ref);
    if (!ws) {
      if (cleanName(ref).toLowerCase() === 'current') throw new WorkspaceError(404, 'No current workspace: pick one with /workspace <name>, or create one');
      throw new WorkspaceError(404, `No workspace called "${cleanName(ref)}"`);
    }
    return ws;
  }

  async current() {
    const id = (await this.store.load('workspace-current', null))?.id;
    if (!id) return null;
    return (await this.all()).find((w) => w.id === id) || null;
  }

  async select(ref) {
    const ws = await this.get(ref);
    await this.store.save('workspace-current', { id: ws.id });
    return ws;
  }

  // changeStages adds/removes picked stage profiles (in order) or sets the
  // global profile. Workspaces that build stages from tags have no list to
  // change. Returns { workspace, added, skipped, removed }.
  async changeStages(ref, { add = [], remove = [], global } = {}) {
    return this.write(async () => {
      const items = await this.all();
      const ws = await this.get(ref);
      const request = structuredClone(ws.request);
      if ((add.length || remove.length) && request.fromTags !== undefined) {
        throw new WorkspaceError(409, `Workspace "${ws.name}" builds its stages from profile tags; ask the assistant to switch it to picked stages first`);
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
        else { stages.push({ profile: id }); out.added.push(id); }
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
    if (RESERVED.includes(name.toLowerCase())) throw new WorkspaceError(400, `"${name}" is a reserved word; pick another name`);
    if (name.length > 80) throw new WorkspaceError(400, 'Workspace names are limited to 80 characters');
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new WorkspaceError(400, 'A workspace needs a run request');
  }

  async create({ name, request }) {
    name = cleanName(name);
    Workspaces.check(name, request);
    return this.write(async () => {
      const items = await this.all();
      if (items.some((w) => w.name.toLowerCase() === name.toLowerCase())) throw new WorkspaceError(409, `A workspace called "${name}" already exists`);
      const now = new Date().toISOString();
      const ws = { id: randomUUID(), name, request: structuredClone(request), createdAt: now, updatedAt: now };
      await this.store.save('workspaces', [...items, ws]);
      return ws;
    });
  }

  async update(ref, { name, request } = {}) {
    return this.write(async () => {
      const items = await this.all();
      const ws = await this.get(ref);
      const next = { ...ws, name: name === undefined ? ws.name : cleanName(name), request: request === undefined ? ws.request : structuredClone(request) };
      Workspaces.check(next.name, next.request);
      if (items.some((w) => w.id !== ws.id && w.name.toLowerCase() === next.name.toLowerCase())) throw new WorkspaceError(409, `A workspace called "${next.name}" already exists`);
      next.updatedAt = new Date().toISOString();
      await this.store.save('workspaces', items.map((w) => (w.id === ws.id ? next : w)));
      return next;
    });
  }

  async delete(ref) {
    return this.write(async () => {
      const ws = await this.get(ref);
      await this.store.save('workspaces', (await this.all()).filter((w) => w.id !== ws.id));
      if ((await this.store.load('workspace-current', null))?.id === ws.id) await this.store.save('workspace-current', {});
      return ws;
    });
  }
}
