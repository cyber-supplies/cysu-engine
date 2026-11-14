// secrets.js keeps the user's own secrets (API keys their profiles' skills
// need, such as BROWSERBASE_API_KEY) in DATA_DIR/secrets.json, next to the
// token and passkey. Workers get them as environment variables, so a skill can
// say `$BROWSERBASE_API_KEY` instead of carrying the key in its text, where the
// agent reads it and it ends up in run events.
//
// Values never leave the engine through the API: listing shows names and when
// each was set. They go to workers only on the stdin secrets line.

import { load, save } from './store.js';

const FILE = 'secrets';

// An environment variable name, upper case so it cannot shadow the lower-case
// proxy variables either.
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRETS = 50;
export const MAX_VALUE_BYTES = 16 * 1024;

// Names the worker itself depends on, or that change how programs start. A
// secret must never replace them.
const RESERVED_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TERM', 'LANG', 'TZ', 'TMPDIR', 'IFS', 'ENV', 'BASH_ENV', 'PS4',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);
const RESERVED_PREFIXES = ['CYSU_', 'OPENAI_', 'OPENROUTER_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'NODE_', 'NPM_', 'LD_', 'GIT_', 'PYTHON', 'PERL', 'RUBY', 'BASH_', 'LC_'];

export function secretNameError(name) {
  if (typeof name !== 'string' || !SECRET_NAME.test(name)) {
    return 'secret names are environment variable names: A-Z, 0-9 and _, starting with a letter, at most 64 characters';
  }
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return `${name} is reserved for the worker; choose another name`;
  }
  return null;
}

export function secretValueError(value) {
  if (typeof value !== 'string' || value.length === 0) return 'value must be a non-empty string';
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return `value must be at most ${MAX_VALUE_BYTES} bytes`;
  if (value.includes('\0')) return 'value must not contain NUL characters';
  return null;
}

async function read() {
  const stored = await load(FILE, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/** Names and when each was set, never values. */
export async function listSecrets() {
  const stored = await read();
  return Object.keys(stored).sort().map((name) => ({ name, updatedAt: stored[name].updatedAt }));
}

/** Set (create or replace) one secret. Throws { status } for bad input. */
export async function setSecret(name, value) {
  const problem = secretNameError(name) || secretValueError(value);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const stored = await read();
  if (!stored[name] && Object.keys(stored).length >= MAX_SECRETS) {
    throw Object.assign(new Error(`at most ${MAX_SECRETS} secrets`), { status: 400 });
  }
  stored[name] = { value, updatedAt: new Date().toISOString() };
  await save(FILE, stored);
  return { name, updatedAt: stored[name].updatedAt };
}

/** Remove one secret; false if there was none by that name. */
export async function deleteSecret(name) {
  const stored = await read();
  if (!Object.hasOwn(stored, name)) return false;
  delete stored[name];
  await save(FILE, stored);
  return true;
}

/** { NAME: value } for the workers' secrets line. */
export async function secretValues() {
  const stored = await read();
  return Object.fromEntries(Object.entries(stored)
    .filter(([name, entry]) => !secretNameError(name) && typeof entry?.value === 'string')
    .map(([name, entry]) => [name, entry.value]));
}
