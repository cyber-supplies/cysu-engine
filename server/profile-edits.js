// profile-edits.js: create and edit profiles in the user's Cyber Supplies
// account, for the main agent, ALWAYS through a plan + a proposal the user
// approves (see agent-tools.js). Whole profiles are never deleted here.
//
// The gateway replaces a profile as a whole (PUT /api/profiles/{id}), so a
// change is a small list of edits applied to the current profile:
//   { profile, tags?, upsert?: { skills|agents|mcp|prompts: [item…] },
//     remove?: { skills|agents|mcp|prompts: [name…] } }
// Validation mirrors cysu-storage (src/data/profiles.js), so mistakes show up
// in the plan, not at approval. MCP header values can hold secrets: the agent
// sees them redacted, and redacted values are restored from the stored profile.

import { createHash } from 'node:crypto';
import { API_URL, ProfileError } from './profiles.js';

export const KINDS = ['skills', 'agents', 'mcp', 'prompts'];
export const REDACTED = '<redacted by engine>';
const slug = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const nonempty = (v) => typeof v === 'string' && v.trim() !== '' && !v.includes('\0');
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (message) => new ProfileError(400, message);

// ---- validation (mirrors cysu-storage) ---------------------------------------------

export function validateProfileId(id) {
  if (!nonempty(id) || id !== id.trim() || id === '.' || id === '..' || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(id) ||
      id.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) {
    throw bad('Profile id must be a non-empty portable directory name');
  }
  return id;
}

function validateTags(tag) {
  if (!Array.isArray(tag) || tag.some((v) => !nonempty(v) || v !== v.trim())) throw bad('Profile tags must be a list of non-empty strings');
  if (new Set(tag).size !== tag.length) throw bad('Profile tags must not repeat');
  return [...tag];
}

function validateItem(kind, item) {
  if (!plain(item)) throw bad(`Each ${kind} entry must be an object`);
  const allowed = kind === 'mcp'
    ? item.type === 'stdio' ? ['name', 'type', 'url', 'command', 'args'] : ['name', 'type', 'url', 'headers']
    : ['name', 'description', 'content', ...(kind === 'agents' ? ['model'] : [])];
  for (const key of Object.keys(item)) if (!allowed.includes(key)) throw bad(`Unsupported ${kind} field '${key}'`);
  if (typeof item.name !== 'string' || !slug.test(item.name)) throw bad(`${kind} name must be a lowercase hyphenated slug (got ${JSON.stringify(item.name)})`);
  if (kind !== 'mcp') {
    for (const field of ['content', ...(kind === 'agents' ? ['model'] : []), ...(kind !== 'prompts' ? ['description'] : [])]) {
      if (!nonempty(item[field])) throw bad(`${kind} ${item.name}: '${field}' must be a non-empty string`);
    }
    return item;
  }
  if (!['stdio', 'http'].includes(item.type)) throw bad(`mcp ${item.name}: type must be 'stdio' or 'http'`);
  if (!nonempty(item.url)) throw bad(`mcp ${item.name}: url must be a non-empty string`);
  if (item.type === 'stdio') {
    if (!nonempty(item.command)) throw bad(`mcp ${item.name}: command must be a non-empty string`);
    if (!Array.isArray(item.args) || item.args.some((a) => typeof a !== 'string' || a.includes('\0'))) throw bad(`mcp ${item.name}: args must be a list of strings`);
  } else {
    let url;
    try { url = new URL(item.url); } catch { /* below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol)) throw bad(`mcp ${item.name}: url must be http(s)`);
    if (!plain(item.headers)) throw bad(`mcp ${item.name}: headers must be an object`);
    for (const [n, v] of Object.entries(item.headers)) {
      if (!headerName.test(n) || typeof v !== 'string' || /[\r\n\0]/.test(v)) throw bad(`mcp ${item.name}: invalid header ${n}`);
    }
  }
  return item;
}

// ---- gateway calls ---------------------------------------------------------------

async function gateway(token, method, path, body, { apiUrl = API_URL, fetchImpl = fetch } = {}) {
  if (!token) throw new ProfileError(400, 'Add your Cyber Supplies token first');
  let res;
  try {
    res = await fetchImpl(new URL(path, apiUrl), {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new ProfileError(502, `Could not reach Cyber Supplies: ${error.message}`);
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// readProfile returns the stored profile, or null when it does not exist.
export async function readProfile(token, id, opts) {
  validateProfileId(id);
  const { status, data } = await gateway(token, 'GET', `/api/profiles/${encodeURIComponent(id)}`, undefined, opts);
  if (status === 404) return null;
  if (status !== 200 || !plain(data)) throw new ProfileError(status === 401 ? 401 : 502, `Cyber Supplies profile read failed (${status})`);
  const doc = { id, tag: Array.isArray(data.tag) ? data.tag : [] };
  for (const kind of KINDS) doc[kind] = Array.isArray(data[kind]) ? data[kind] : [];
  return doc;
}

async function writeProfile(token, doc, opts) {
  const { status, data } = await gateway(token, 'PUT', `/api/profiles/${encodeURIComponent(doc.id)}`, doc, opts);
  if (status !== 200) throw new ProfileError(status === 401 ? 401 : status === 400 ? 400 : 502, `Cyber Supplies rejected the profile (${status})${data?.error ? `: ${data.error}` : ''}`);
  return data;
}

// ---- for the agent: secrets redacted --------------------------------------------------

export function redact(doc) {
  if (!doc) return null;
  const copy = structuredClone(doc);
  for (const server of copy.mcp) {
    if (plain(server.headers)) for (const name of Object.keys(server.headers)) server.headers[name] = REDACTED;
  }
  return copy;
}

const hashOf = (doc) => (doc ? createHash('sha256').update(JSON.stringify(doc)).digest('hex') : 'none');

// ---- plan + apply ------------------------------------------------------------------------

// applyChange builds the new profile from the current one (or null = create).
export function applyChange(current, change) {
  if (!plain(change)) throw bad('A profile change must be an object');
  for (const key of Object.keys(change)) if (!['profile', 'tags', 'upsert', 'remove'].includes(key)) throw bad(`Unsupported change field '${key}'`);
  const id = validateProfileId(change.profile);
  const next = current ? structuredClone(current) : { id, tag: [], skills: [], agents: [], mcp: [], prompts: [] };
  if (change.tags !== undefined) next.tag = validateTags(change.tags);

  for (const [section, value] of [['upsert', change.upsert], ['remove', change.remove]]) {
    if (value === undefined) continue;
    if (!plain(value)) throw bad(`${section} must be an object with skills/agents/mcp/prompts lists`);
    for (const key of Object.keys(value)) {
      if (!KINDS.includes(key)) throw bad(`${section}: unknown kind '${key}' (use skills, agents, mcp or prompts)`);
      if (!Array.isArray(value[key])) throw bad(`${section}.${key} must be a list`);
    }
  }
  for (const kind of KINDS) {
    for (const name of change.remove?.[kind] || []) {
      const before = next[kind].length;
      next[kind] = next[kind].filter((item) => item.name !== name);
      if (next[kind].length === before) throw bad(`Cannot remove ${kind} '${name}': the profile has none`);
    }
    for (const raw of change.upsert?.[kind] || []) {
      const item = structuredClone(raw);
      if (kind === 'mcp' && plain(item.headers)) {
        const stored = current?.mcp.find((s) => s.name === item.name);
        for (const [name, value] of Object.entries(item.headers)) {
          if (value !== REDACTED) continue;
          if (typeof stored?.headers?.[name] !== 'string') throw bad(`mcp ${item.name}: header ${name} is redacted but has no stored value; leave it out or ask the user to set it`);
          item.headers[name] = stored.headers[name];
        }
      }
      validateItem(kind, item);
      const at = next[kind].findIndex((x) => x.name === item.name);
      if (at >= 0) next[kind][at] = item; else next[kind].push(item);
    }
    const names = next[kind].map((i) => i.name);
    if (new Set(names).size !== names.length) throw bad(`Duplicate ${kind} names`);
  }
  return next;
}

// diff describes a change for the plan and the approval screen (no secrets).
export function diff(current, next) {
  const out = { profile: next.id, exists: Boolean(current), tagsBefore: current?.tag ?? null, tagsAfter: next.tag, created: [], updated: [], removed: [], unchanged: 0 };
  for (const kind of KINDS) {
    const before = new Map((current?.[kind] || []).map((i) => [i.name, i]));
    for (const item of next[kind]) {
      const old = before.get(item.name);
      const shown = redact({ mcp: kind === 'mcp' ? [item] : [] }).mcp[0] || item;
      const preview = kind === 'mcp' ? JSON.stringify(shown) : String(item.content || '').slice(0, 400);
      if (!old) out.created.push({ kind, name: item.name, preview });
      else if (JSON.stringify(old) !== JSON.stringify(item)) out.updated.push({ kind, name: item.name, preview });
      else out.unchanged += 1;
      before.delete(item.name);
    }
    for (const name of before.keys()) out.removed.push({ kind, name });
  }
  out.changes = out.created.length + out.updated.length + out.removed.length + (JSON.stringify(out.tagsBefore) !== JSON.stringify(out.tagsAfter) ? 1 : 0);
  return out;
}

// planChange reads the profile and returns what the change would do.
export async function planChange(token, change, opts) {
  const current = await readProfile(token, String(change?.profile ?? ''), opts);
  const next = applyChange(current, change);
  const plan = diff(current, next);
  if (!plan.changes && plan.exists) throw bad('This change would not change anything');
  return { plan, baseHash: hashOf(current) };
}

// applyApproved runs an approved proposal: refuses if the profile changed
// since the plan (so nothing is overwritten silently), then saves it.
export async function applyApproved(token, change, baseHash, opts) {
  const current = await readProfile(token, String(change.profile), opts);
  if (hashOf(current) !== baseHash) {
    throw new ProfileError(409, `Profile ${change.profile} changed since this was proposed; ask the agent to propose again`);
  }
  const next = applyChange(current, change);
  const result = await writeProfile(token, next, opts);
  return { profile: next.id, changes: result?.changes ?? null };
}
