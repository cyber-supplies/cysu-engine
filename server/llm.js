// llm.js handles "Sign in with ChatGPT" for Codex: a device-code login run in
// a hardened worker container. The user opens the link, enters the code, and
// the resulting ~/.codex/auth.json is saved in the engine's data dir (0600).
// Every run then receives it on stdin with the other secrets.

import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hardeningArgs, IMAGE } from './docker.js';
import { load, save, remove } from './store.js';

const MARK = '__CYSU_CODEX_AUTH__';
const LOGIN_TIMEOUT_MS = 16 * 60_000; // Codex device codes expire after 15 minutes
const REAL_LOGIN = 'codex login --device-auth';

let login = null; // { id, name, status, url, code, error, startedAt, finishedAt }

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');

export function codexLoginState() {
  if (!login) return { status: 'idle' };
  const { child, timer, ...state } = login;
  return state;
}

// startCodexLogin starts the device login. `loginCommand` is replaceable so
// tests can stand in for OpenAI without a real account.
export function startCodexLogin({ loginCommand = REAL_LOGIN } = {}) {
  if (login && ['starting', 'waiting'].includes(login.status)) return codexLoginState();

  const id = randomUUID();
  const name = `cysu-codex-login-${id.slice(0, 8)}`;
  // On success the container prints auth.json as one base64 line after a marker.
  // --log-driver none keeps that line out of Docker's on-disk logs.
  const script = `( ${loginCommand} ) && printf '\\n${MARK}%s\\n' "$(base64 -w0 ~/.codex/auth.json)"`;
  const args = ['run', '--rm', '-t', '--name', name, '--log-driver', 'none', ...hardeningArgs(), IMAGE, 'sh', '-c', script];

  const current = { id, name, status: 'starting', url: '', code: '', error: '', startedAt: new Date().toISOString() };
  login = current;
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  current.child = child;

  let output = '';
  let auth = null;
  const onData = (chunk) => {
    output += stripAnsi(chunk.toString());
    if (output.length > 64_000) output = output.slice(-64_000);
    if (!current.url) current.url = output.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0] || '';
    if (!current.code) current.code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/)?.[0] || '';
    if (current.status === 'starting' && current.url && current.code) current.status = 'waiting';
    const marked = output.match(new RegExp(`${MARK}([A-Za-z0-9+/=]+)\\n`));
    if (marked) {
      try { auth = JSON.parse(Buffer.from(marked[1], 'base64').toString('utf8')); } catch { auth = null; }
      output = output.replace(marked[0], '');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  current.timer = setTimeout(() => {
    current.error = 'Login timed out (the code expires after 15 minutes)';
    stopContainer(name);
  }, LOGIN_TIMEOUT_MS);
  current.timer.unref();

  child.on('error', (error) => finish(current, 'failed', `Could not start docker: ${error.message}`));
  child.on('close', async (code) => {
    clearTimeout(current.timer);
    if (current.status === 'cancelled') return;
    if (code === 0 && auth && typeof auth === 'object') {
      try {
        await saveCodexAuth(auth);
        return finish(current, 'succeeded');
      } catch (error) {
        return finish(current, 'failed', `Could not save the login: ${error.message}`);
      }
    }
    const last = output.trim().split('\n').filter(Boolean).slice(-3).join(' ');
    finish(current, 'failed', current.error || `Login did not complete (exit ${code})${last ? `: ${last}` : ''}`);
  });

  return codexLoginState();
}

function finish(current, status, error = '') {
  current.status = status;
  current.error = error;
  current.finishedAt = new Date().toISOString();
  delete current.child;
}

function stopContainer(name) {
  return new Promise((resolve) => execFile('docker', ['rm', '-f', name], () => resolve()));
}

export async function cancelCodexLogin() {
  if (!login || !['starting', 'waiting'].includes(login.status)) return codexLoginState();
  const current = login;
  finish(current, 'cancelled');
  clearTimeout(current.timer);
  await stopContainer(current.name);
  return codexLoginState();
}

// ---- stored login ----------------------------------------------------------

export async function saveCodexAuth(auth) {
  await save('codex-auth', { savedAt: new Date().toISOString(), auth });
  const settings = await load('settings', {});
  await save('settings', { ...settings, llm: { ...(settings.llm || {}), mode: 'codex' } });
}

export async function loadCodexAuth() {
  return (await load('codex-auth', null))?.auth || null;
}

export async function codexAuthInfo() {
  const stored = await load('codex-auth', null);
  return stored ? { saved: true, savedAt: stored.savedAt } : { saved: false };
}

export async function forgetCodexAuth() {
  await remove('codex-auth');
  const settings = await load('settings', {});
  if (settings.llm?.mode === 'codex') await save('settings', { ...settings, llm: { ...settings.llm, mode: 'none' } });
}

// keepRefreshedCodexAuth saves the auth.json a stage ended with, when Codex
// refreshed its tokens during the stage. It only replaces the stored login if
// that is still the one the stage started with (a newer sign-in wins).
// Returns true when the stored login was updated.
export async function keepRefreshedCodexAuth(sent, refreshed) {
  if (!sent || !refreshed || typeof refreshed !== 'object' || Array.isArray(refreshed)) return false;
  if (JSON.stringify(refreshed) === JSON.stringify(sent)) return false;
  if (!refreshed.tokens && !refreshed.OPENAI_API_KEY) return false; // not a usable login
  const current = await loadCodexAuth();
  if (JSON.stringify(current) !== JSON.stringify(sent)) return false;
  await save('codex-auth', { savedAt: new Date().toISOString(), auth: refreshed });
  return true;
}
