// Claude Code owns the OAuth exchange and credentials. The engine only relays
// its authorization URL / one-time input and keeps a reference to its volume.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { hardeningArgs, IMAGE, LABEL } from './docker.js';
import { load, save, remove } from './store.js';
import { loadSettings, saveSettings } from './settings.js';
import { oneAtATime } from './auth.js';

export const CLAUDE_CONFIG_DIR = '/home/runner/.claude';
const ACTIVE = new Set(['starting', 'waiting', 'exchanging']);
const VOLUME = /^cysu-claude-[0-9a-f-]{36}$/;
const CONTAINER = /^cysu-claude-login-[0-9a-f-]{36}$/;
const LOGIN_COMMAND = `umask 077
claude auth login --claudeai &&
claude auth status | jq -e '.loggedIn == true and .authMethod == "claude.ai"' >/dev/null`;
const httpError = (status, message) => Object.assign(new Error(message), { status });

function docker(args) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: 30_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Wait for a complete URL (including its newline), rather than publishing a
// partially received code challenge. Never return arbitrary URLs from logs.
export function claudeAuthorizationUrl(output) {
  const clean = stripVTControlCharacters(output);
  for (const match of clean.matchAll(/https:\/\/[^\s<>"']+(?=\s)/g)) {
    try {
      const url = new URL(match[0]);
      const native = (url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize')
        || (url.hostname === 'claude.ai' && url.pathname === '/oauth/authorize');
      if (native && !url.port && !url.username && !url.password && !url.hash
        && url.searchParams.get('response_type') === 'code'
        && ['client_id', 'redirect_uri', 'state', 'code_challenge'].every((p) => url.searchParams.get(p))) return url.href;
    } catch { /* Not a complete authorization URL. */ }
  }
  return '';
}

export class ClaudeLogin {
  constructor({ image = IMAGE, timeoutMs = 15 * 60_000 } = {}) {
    Object.assign(this, { image, timeoutMs });
    this.session = null;
    this.queue = Promise.resolve();
    this.inUse = new Set();
  }

  exclusive(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }

  state() {
    if (!this.session) return { status: 'idle' };
    const { id, status, url, startedAt, expiresAt, finishedAt, error } = this.session;
    return { id, status, url, startedAt, expiresAt, ...(finishedAt && { finishedAt }), ...(error && { error }) };
  }

  async authInfo() {
    const saved = await load('claude-auth', null);
    return saved?.volume ? { saved: true, savedAt: saved.savedAt } : { saved: false };
  }

  // Workers mount this named volume with CLAUDE_CONFIG_DIR.
  // Do not copy its contents into engine settings or serialize them on stdin.
  async savedVolume() {
    const saved = await load('claude-auth', null);
    if (!saved?.volume) return null;
    if (!VOLUME.test(saved.volume)) throw httpError(500, 'Invalid saved Claude volume');
    return saved.volume;
  }

  acquireVolume() {
    return this.exclusive(async () => {
      const volume = await this.savedVolume();
      if (!volume) throw httpError(400, 'Log in to Claude before running this workflow');
      if (this.inUse.size) throw httpError(409, 'A Claude worker is already using the saved login');
      if (!(await docker(['volume', 'inspect', volume])).ok) throw httpError(400, 'The saved Claude volume is missing; log in again');
      this.inUse.add(volume);
      return { volume, release: () => this.exclusive(async () => {
        this.inUse.delete(volume);
        await this.retireVolumes();
      }) };
    });
  }

  async removeContainer(name) {
    if (!CONTAINER.test(name)) throw httpError(500, 'Invalid Claude login container');
    const out = await docker(['rm', '-f', name]);
    if (!out.ok && !out.stderr.includes('No such container')) throw httpError(503, 'Could not stop the Claude login container; retry the operation');
  }

  async removeVolume(volume) {
    if (!VOLUME.test(volume)) throw httpError(500, 'Invalid Claude authentication volume');
    const out = await docker(['volume', 'rm', volume]);
    if (!out.ok && !out.stderr.includes('no such volume')) throw httpError(503, 'Could not remove the Claude authentication volume; it may still be in use');
  }

  // Keep failed retirement attempts recorded, so a restart can retry cleanup
  // without losing the newly authenticated volume or orphaning old credentials.
  async retireVolumes() {
    const saved = await load('claude-auth', null);
    if (!saved?.retiredVolumes?.length) return;
    const remaining = [];
    for (const volume of saved.retiredVolumes) {
      if (volume === saved.volume) continue;
      if (this.inUse.has(volume)) { remaining.push(volume); continue; }
      try { await this.removeVolume(volume); } catch { remaining.push(volume); }
    }
    await save('claude-auth', { ...saved, retiredVolumes: remaining });
  }

  recover() {
    return this.exclusive(async () => {
      const pending = await load('claude-login-pending', null);
      if (pending) {
        await this.removeContainer(pending.container);
        // A crash between committing the new volume and removing pending state
        // must not delete a successful login.
        const committed = (await this.savedVolume()) === pending.volume;
        if (!committed) await this.removeVolume(pending.volume);
        await remove('claude-login-pending');
        this.session = { id: pending.id, startedAt: pending.startedAt, expiresAt: pending.expiresAt,
          status: committed ? 'succeeded' : 'failed', url: '', finishedAt: new Date().toISOString(),
          error: committed ? '' : 'The engine restarted during login; start a new login' };
      }
      await this.retireVolumes();
    });
  }

  start() {
    return this.exclusive(async () => {
      if (this.session && ACTIVE.has(this.session.status)) return this.state();
      // A failed cleanup must be retried before another container is started.
      if (await load('claude-login-pending', null)) throw httpError(409, 'Claude login cleanup is pending; cancel the login before starting another');
      const id = randomUUID();
      const current = { id, container: `cysu-claude-login-${id}`, volume: `cysu-claude-${id}`,
        startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(), status: 'starting', url: '' };
      await save('claude-login-pending', { id, container: current.container, volume: current.volume, startedAt: current.startedAt, expiresAt: current.expiresAt });
      this.session = current;
      try {
        const created = await docker(['volume', 'create', '--label', 'cysu-engine.claude-auth=true', current.volume]);
        if (!created.ok) throw new Error('volume creation failed');
        const env = { CLAUDE_CONFIG_DIR, DISABLE_AUTOUPDATER: '1', TERM: 'dumb', NO_COLOR: '1' };
        if (process.env.CYSU_ENGINE_TEST_NO_FIREWALL === '1') env.CYSU_EGRESS_GUARD = '0';
        const args = ['run', '-i', '--name', current.container, '--label', `${LABEL}=claude-login`, '--log-driver', 'none', ...hardeningArgs(),
          '--mount', `type=volume,source=${current.volume},target=${CLAUDE_CONFIG_DIR}`];
        for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
        args.push(this.image, 'sh', '-c', LOGIN_COMMAND);
        const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        current.child = child;
        let output = '';
        const onData = (chunk) => {
          if (current !== this.session || !ACTIVE.has(current.status) || current.url) return;
          output = (output + chunk.toString()).slice(-64_000);
          const url = claudeAuthorizationUrl(output);
          if (url) { current.url = url; current.status = 'waiting'; output = ''; }
        };
        // Native output is used only to find the authorization URL. It is never
        // returned as an error or persisted: it can contain sensitive input.
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.stdin.on('error', () => {});
        child.on('error', () => {}); // close follows spawn errors, too
        child.on('close', (code) => {
          this.exclusive(() => this.finish(current, code)).catch(() => {
            this.terminal(current, 'failed', 'Could not finish Claude login; cancel it to retry cleanup');
          });
        });
        current.timer = setTimeout(() => {
          this.exclusive(() => {
            if (this.session === current && ACTIVE.has(current.status)) return this.cancelCurrent('expired', 'Claude login expired; start a new login');
          }).catch(() => {
            this.terminal(current, 'failed', 'Could not clean up expired Claude login; cancel it to retry cleanup');
          });
        }, Math.max(0, Date.parse(current.expiresAt) - Date.now()));
        current.timer.unref();
      } catch {
        await this.cancelCurrent('failed', 'Could not start Claude Code; check Docker and rebuild the worker image');
      }
      return this.state();
    });
  }

  submitCode(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['id', 'code'].includes(k))
      || typeof input.id !== 'string' || typeof input.code !== 'string'
      || input.code.length > 4096 || !/^[A-Za-z0-9._~+/=-]+(?:#[A-Za-z0-9._~+/=-]+)?$/.test(input.code)) {
      throw httpError(400, 'Provide the login id and the one-time code from the Claude login page');
    }
    return this.exclusive(async () => {
      const current = this.session;
      if (!current || current.id !== input.id || current.status !== 'waiting') throw httpError(409, 'This Claude login is not waiting for a code');
      if (Date.now() >= Date.parse(current.expiresAt)) {
        await this.cancelCurrent('expired', 'Claude login expired; start a new login');
        throw httpError(409, 'Claude login expired; start a new login');
      }
      current.status = 'exchanging';
      await new Promise((resolve, reject) => current.child.stdin.write(`${input.code}\n`, (error) => error
        ? reject(httpError(409, 'The Claude login process is no longer accepting input')) : resolve()));
      return this.state();
    });
  }

  terminal(current, status, error = '') {
    clearTimeout(current.timer);
    current.status = status;
    current.error = error;
    current.url = '';
    current.finishedAt = new Date().toISOString();
    delete current.child;
    delete current.timer;
  }

  async finish(current, code) {
    if (current !== this.session || !ACTIVE.has(current.status)) return;
    clearTimeout(current.timer);
    await this.removeContainer(current.container);
    if (code === 0) {
      const previous = await load('claude-auth', null);
      await save('claude-auth', { volume: current.volume, savedAt: new Date().toISOString(),
        retiredVolumes: [...new Set([...(previous?.retiredVolumes || []), ...(previous?.volume ? [previous.volume] : [])])] });
      await oneAtATime(async () => {
        const settings = await loadSettings();
        await saveSettings({ ...settings, llm: { ...settings.llm, mode: 'codex' } });
      });
      await remove('claude-login-pending');
      this.terminal(current, 'succeeded');
      await this.retireVolumes();
    } else {
      await this.removeVolume(current.volume);
      await remove('claude-login-pending');
      this.terminal(current, 'failed', 'Claude Code could not complete login; start a new login and use its one-time code');
    }
  }

  async cancelCurrent(status = 'cancelled', error = '') {
    const pending = await load('claude-login-pending', null);
    const current = this.session;
    if (!pending) return this.state();
    if (current) this.terminal(current, status, error);
    await this.removeContainer(pending.container);
    if ((await this.savedVolume()) !== pending.volume) await this.removeVolume(pending.volume);
    await remove('claude-login-pending');
    return this.state();
  }

  cancel() { return this.exclusive(() => this.cancelCurrent()); }

  forget() {
    return this.exclusive(async () => {
      if (this.inUse.size) throw httpError(409, 'Wait for the Claude run to finish or cancel it before forgetting its login');
      await this.cancelCurrent();
      const saved = await load('claude-auth', null);
      for (const volume of new Set([...(saved?.retiredVolumes || []), ...(saved?.volume ? [saved.volume] : [])])) await this.removeVolume(volume);
      await remove('claude-auth');
      this.session = null;
      return { saved: false };
    });
  }
}
