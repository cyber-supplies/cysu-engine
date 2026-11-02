// runs.js: runs saved on disk, executed one stage container at a time.
//
//   <runsDir>/<run id>/run.json                     the run and its stages
//   <runsDir>/<run id>/stages/<n>/events.jsonl      Codex events, one per line, with a seq number
//   <runsDir>/<run id>/stages/<n>/log.txt           [engine] lines, cysu output, Codex stderr
//
// A run is a list of stages, executed one after another, each in a fresh
// container. The stages are either given explicitly, or built from the user's
// profile tags the way the Windmill flow did (`fromTags`, see profiles.js).
// A failed stage is recorded and the next one still runs (continueOnFailure,
// default true, like Windmill's skip_failures).
// One run executes at a time. Runs that were active when the engine stopped
// are marked "interrupted" at the next start.

import { mkdir, readFile, readdir, rm, rename, writeFile, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startStage, cancelStage, validateStage, StageError } from './stage.js';
import { removeOrphanContainers } from './docker.js';
import { keepRefreshedCodexAuth } from './llm.js';
import { orderProfiles, STAGE_TAGS, ProfileError } from './profiles.js';
import { tarGz } from './tar.js';

// The request fields a run remembers, so it can be run again.
const REQUEST_FIELDS = ['name', 'prompt', 'globalProfile', 'model', 'reasoningEffort', 'fallbackModel',
  'continueOnFailure', 'stages', 'fromTags', 'modelOverrides', 'reprompts'];
const requestOf = (input) => structuredClone(Object.fromEntries(REQUEST_FIELDS.filter((k) => input[k] !== undefined).map((k) => [k, input[k]])));

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE = ['queued', 'running'];
const MAX_STAGES = 20;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function writeJson(file, value) {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`; // unique: saves may overlap
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

// summary is what a run list shows (no per-stage results).
function summary(run) {
  const { stages, prompt, ...rest } = run;
  return { ...rest, stageCount: stages.length, stages: stages.map(({ index, profile, tag, status }) => ({ index, profile, tag, status })) };
}

export class Runs {
  // getSecrets: async () => ({ settings, codexAuth }) — read fresh for every stage.
  // listProfiles: async (settings) => the user's profiles [{ id, tag }] (for fromTags).
  // stageOptions: passed through to startStage (tests use a stand-in image/API).
  constructor({ dir, getSecrets, listProfiles = async () => { throw new HttpError(501, 'Profile lookup is not configured'); }, stageOptions = {} }) {
    this.dir = dir;
    this.getSecrets = getSecrets;
    this.listProfiles = listProfiles;
    this.stageOptions = stageOptions;
    this.active = null; // { run, stage (live stage record) }
    this.saveTimer = null;
  }

  folder(id) {
    if (!RUN_ID.test(id)) throw new HttpError(404, 'Run not found');
    return join(this.dir, id);
  }
  stageFolder(id, index) { return join(this.folder(id), 'stages', String(index)); }

  // recover marks runs left active by a stopped engine as interrupted and
  // removes leftover engine containers. Call once at startup.
  async recover() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const removed = await removeOrphanContainers();
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
      const run = await this.read(entry.name).catch(() => null);
      if (!run || !ACTIVE.includes(run.status)) continue;
      run.status = 'interrupted';
      run.finishedAt ||= new Date().toISOString();
      for (const stage of run.stages) {
        if (stage.status === 'running') { stage.status = 'interrupted'; stage.finishedAt ||= run.finishedAt; }
        else if (stage.status === 'pending') stage.status = 'skipped';
      }
      await writeJson(join(this.folder(run.id), 'run.json'), run);
    }
    return { removedContainers: removed };
  }

  async read(id) {
    if (this.active?.run.id === id) return this.active.run;
    try {
      return JSON.parse(await readFile(join(this.folder(id), 'run.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'Run not found');
      throw error;
    }
  }

  async get(id) {
    return structuredClone(await this.read(id));
  }

  async list() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const runs = [];
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
      const run = await this.read(entry.name).catch(() => null);
      if (run) runs.push(summary(run));
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // plan validates a run request and works out its stages, without saving or
  // starting anything. Used by create and by POST /api/runs/plan (preview).
  async plan(input = {}) {
    const { settings, codexAuth } = await this.getSecrets();
    if (!settings?.token || !settings?.passkey) throw new HttpError(400, 'Add your Cyber Supplies token and passkey first');
    // Every stage's agent works with the user's own LLM login.
    const llm = settings.llm || {};
    const llmReady = (llm.mode === 'openai-api-key' && llm.apiKey) || (llm.mode === 'codex' && codexAuth);
    if (!llmReady) throw new HttpError(400, 'Log in to your LLM first: sign in with ChatGPT (Codex) or add an OpenAI API key');

    const defaults = {
      prompt: String(input.prompt ?? ''),
      globalProfile: String(input.globalProfile ?? settings.globalProfile ?? '').trim(),
      model: String(input.model ?? '').trim(),
      reasoningEffort: String(input.reasoningEffort ?? '').trim(),
      fallbackModel: String(input.fallbackModel ?? '').trim(),
    };
    const continueOnFailure = input.continueOnFailure === undefined ? true : input.continueOnFailure;
    if (typeof continueOnFailure !== 'boolean') throw new HttpError(400, 'continueOnFailure must be true or false');

    // Per-tag model choice (Windmill's "stage model overrides").
    const overrides = input.modelOverrides ?? [];
    if (!Array.isArray(overrides)) throw new HttpError(400, 'modelOverrides must be a list');
    const modelForTag = new Map();
    for (const o of overrides) {
      const tag = String(o?.stage ?? '');
      if (!STAGE_TAGS.includes(tag) || typeof o?.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,120}$/.test(o.model)) {
        throw new HttpError(400, 'Each model override needs a stage 1 to 4 and a model name');
      }
      if (modelForTag.has(tag)) throw new HttpError(400, `Duplicate model override for stage ${tag}`);
      modelForTag.set(tag, o.model);
    }

    // Follow-up prompts per stage tag (Windmill's "post-completion prompts"):
    // after a stage's first Codex turn succeeds, each matching prompt is sent
    // to the same Codex thread, in this order.
    const repromptList = input.reprompts ?? [];
    if (!Array.isArray(repromptList)) throw new HttpError(400, 'reprompts must be a list');
    const repromptsForTag = new Map();
    for (const r of repromptList) {
      const tag = String(r?.stage ?? '');
      if (!STAGE_TAGS.includes(tag) || typeof r?.prompt !== 'string' || !r.prompt.trim()) {
        throw new HttpError(400, 'Each follow-up prompt needs a stage 1 to 4 and a non-empty prompt');
      }
      repromptsForTag.set(tag, [...(repromptsForTag.get(tag) || []), r.prompt]);
    }

    let requested;
    if (input.fromTags !== undefined && input.stages !== undefined) throw new HttpError(400, 'Send either stages or fromTags, not both');
    if (input.fromTags !== undefined) {
      if (typeof input.fromTags !== 'object' || input.fromTags === null || Array.isArray(input.fromTags)) throw new HttpError(400, 'fromTags must be an object');
      const rows = await this.listProfiles(settings);
      try {
        requested = orderProfiles(rows, { globalProfile: defaults.globalProfile, skip: input.fromTags.skip ?? [] });
      } catch (error) {
        if (error instanceof ProfileError) throw new HttpError(error.status, error.message);
        throw error;
      }
    } else {
      requested = Array.isArray(input.stages) ? input.stages : [];
    }
    if (requested.length < 1) throw new HttpError(400, 'A run needs at least one stage (send stages, or fromTags)');
    if (requested.length > MAX_STAGES) throw new HttpError(400, `At most ${MAX_STAGES} stages per run`);
    if ((modelForTag.size || repromptsForTag.size) && input.fromTags === undefined && !requested.some((s) => s?.tag)) {
      throw new HttpError(400, 'modelOverrides and reprompts apply to tagged stages (use fromTags, or set them on each stage)');
    }

    let stages;
    try {
      stages = requested.map((s, index) => {
        const own = Object.fromEntries(Object.entries(s || {}).filter(([, v]) => v !== undefined && v !== ''));
        const tag = own.tag === undefined ? '' : String(own.tag);
        if (tag && !STAGE_TAGS.includes(tag)) throw new StageError('Stage tag must be 1 to 4');
        const model = own.model ?? modelForTag.get(tag) ?? defaults.model;
        const reprompts = own.reprompts ?? repromptsForTag.get(tag) ?? [];
        const stage = validateStage({ ...defaults, ...own, model, reprompts });
        return { index, tag, ...stage, status: 'pending', startedAt: null, finishedAt: null, exitCode: null,
          threadId: null, turns: 0, usage: null, result: '', errors: [], attempts: [], eventCount: 0 };
      });
    } catch (error) {
      if (error instanceof StageError) throw new HttpError(400, error.message);
      throw error;
    }

    return {
      name: String(input.name ?? '').trim().slice(0, 120),
      ...defaults,
      source: input.fromTags !== undefined ? 'tags' : 'explicit',
      skip: input.fromTags?.skip ?? [],
      modelOverrides: [...modelForTag].map(([stage, model]) => ({ stage: Number(stage), model })),
      reprompts: repromptList.map((r) => ({ stage: String(r.stage), prompt: r.prompt })),
      continueOnFailure,
      stages,
    };
  }

  // create plans the run, saves it and starts it in the background.
  async create(input = {}) {
    if (this.active) throw new HttpError(409, 'A run is already active; cancel it or wait for it to finish');
    const plan = await this.plan(input);
    if (this.active) throw new HttpError(409, 'A run is already active; cancel it or wait for it to finish');
    const run = {
      id: randomUUID(), status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      cancelRequested: false, ...plan,
      // What was asked for: "run again" repeats it (fromTags runs re-read the
      // profile tags, so they pick up profile changes).
      request: requestOf(input), rerunOf: input.rerunOf ?? null,
    };
    await mkdir(this.folder(run.id), { recursive: true, mode: 0o700 });
    await writeJson(join(this.folder(run.id), 'run.json'), run);
    const created = structuredClone(run); // as saved: "queued"
    this.active = { run, stage: null };
    this.active.finished = this.execute(run).catch((error) => console.error(`run ${run.id}:`, error));
    return created;
  }

  async save(run) {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await writeJson(join(this.folder(run.id), 'run.json'), run);
  }
  saveSoon(run) {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(run).catch(() => {}), 1000);
  }

  async execute(run) {
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    await this.save(run);
    try {
      let failed = false;
      for (const stage of run.stages) {
        if (run.cancelRequested) { stage.status = 'cancelled'; continue; }
        if (failed && run.continueOnFailure === false) { stage.status = 'skipped'; continue; }
        await this.executeStage(run, stage);
        if (stage.status !== 'succeeded') failed = true;
      }
      run.status = run.cancelRequested ? 'cancelled'
        : run.stages.every((s) => s.status === 'succeeded') ? 'succeeded' : 'failed';
    } catch (error) {
      run.status = 'failed';
      run.error = error.message;
    } finally {
      run.finishedAt = new Date().toISOString();
      await this.save(run);
      this.active = null;
    }
  }

  async executeStage(run, stage) {
    const folder = this.stageFolder(run.id, stage.index);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const events = await open(join(folder, 'events.jsonl'), 'a', 0o600);
    const log = await open(join(folder, 'log.txt'), 'a', 0o600);
    // Writes are chained so lines land in order.
    let writes = Promise.resolve();
    const write = (handle, text) => { writes = writes.then(() => handle.appendFile(text)).catch(() => {}); };

    const { settings, codexAuth } = await this.getSecrets();
    stage.status = 'running';
    stage.startedAt = new Date().toISOString();
    try {
      const live = startStage({
        stage: { profile: stage.profile, globalProfile: stage.globalProfile, prompt: stage.prompt, model: stage.model,
          reasoningEffort: stage.reasoningEffort, fallbackModel: stage.fallbackModel, reprompts: stage.reprompts },
        settings, codexAuth, ...this.stageOptions,
        onLog: (line) => write(log, `${line}\n`),
        onUpdate: (live, event) => {
          if (event) {
            stage.eventCount += 1;
            write(events, `${JSON.stringify({ seq: stage.eventCount, ...event })}\n`);
          }
          Object.assign(stage, { threadId: live.threadId, turns: live.turns, usage: live.usage, result: live.result, errors: [...live.errors], attempts: structuredClone(live.attempts) });
          this.saveSoon(run);
        },
      });
      stage.container = live.container;
      this.active.stage = live;
      if (run.cancelRequested) cancelStage(live);
      await this.save(run);

      const done = await live.done;
      Object.assign(stage, {
        status: done.status, exitCode: done.exitCode, finishedAt: done.finishedAt,
        threadId: done.threadId, turns: done.turns, usage: done.usage, result: done.result, errors: [...done.errors],
        attempts: structuredClone(done.attempts),
      });
      if (await keepRefreshedCodexAuth(codexAuth, done.refreshedCodexAuth)) {
        write(log, '[engine] saved the refreshed ChatGPT login\n');
      }
    } catch (error) {
      stage.status = 'failed';
      stage.finishedAt = new Date().toISOString();
      stage.errors.push(error.message);
      write(log, `[engine] stage could not run: ${error.message}\n`);
    } finally {
      if (this.active) this.active.stage = null;
      await writes;
      await events.close();
      await log.close();
      await this.save(run);
    }
  }

  // rerun starts a new run with the same request as an earlier one.
  async rerun(id) {
    const old = await this.read(id);
    if (!old.request) throw new HttpError(409, 'This run was made by an older engine version and cannot be run again');
    return this.create({ ...structuredClone(old.request), rerunOf: old.id });
  }

  // download packs a finished run's files into a .tar.gz.
  async download(id) {
    const run = await this.read(id);
    if (ACTIVE.includes(run.status)) throw new HttpError(409, 'Wait for the run to finish (or cancel it) before downloading');
    const root = `run-${id}`;
    const files = [{ name: `${root}/run.json`, data: `${JSON.stringify(run, null, 2)}\n` }];
    for (const stage of run.stages) {
      for (const name of ['events.jsonl', 'log.txt']) {
        try {
          files.push({ name: `${root}/stages/${stage.index}/${name}`, data: await readFile(join(this.stageFolder(id, stage.index), name)) });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (stage.result) files.push({ name: `${root}/stages/${stage.index}/result.md`, data: `${stage.result}\n` });
    }
    return { filename: `${root}.tar.gz`, data: tarGz(files) };
  }

  async cancel(id) {
    const run = await this.read(id);
    if (!this.active || this.active.run.id !== id || !ACTIVE.includes(run.status)) {
      throw new HttpError(409, 'This run is not active');
    }
    run.cancelRequested = true;
    await this.save(run);
    if (this.active.stage) await cancelStage(this.active.stage);
    return structuredClone(run);
  }

  async delete(id) {
    const run = await this.read(id);
    if (this.active?.run.id === id || ACTIVE.includes(run.status)) throw new HttpError(409, 'Cancel the run before deleting it');
    await rm(this.folder(id), { recursive: true, force: true });
  }

  stage(run, index) {
    const stage = run.stages[Number(index)];
    if (!/^\d+$/.test(String(index)) || !stage) throw new HttpError(404, 'Stage not found');
    return stage;
  }

  // events returns a stage's events with seq > after (cursor paging for live views).
  async events(id, index, { after = 0, limit = 500 } = {}) {
    const run = await this.read(id);
    this.stage(run, index);
    after = Math.max(0, Number(after) || 0);
    limit = Math.min(5000, Math.max(1, Number(limit) || 500));
    const out = [];
    try {
      const lines = createInterface({ input: createReadStream(join(this.stageFolder(id, index), 'events.jsonl')), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.seq <= after) continue;
        out.push(event);
        if (out.length >= limit) break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { events: out, next: out.length ? out[out.length - 1].seq : after, done: !ACTIVE.includes(run.status) && run.stages[index].status !== 'running' };
  }

  async log(id, index) {
    const run = await this.read(id);
    this.stage(run, index);
    try {
      return await readFile(join(this.stageFolder(id, index), 'log.txt'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  }

  // close cancels the active run (used on engine shutdown and in tests).
  async close() {
    if (!this.active) return;
    const { run } = this.active;
    const finished = this.active.finished;
    await this.cancel(run.id).catch(() => {});
    await finished;
  }
}
