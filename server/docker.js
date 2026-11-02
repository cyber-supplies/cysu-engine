// docker.js: shared helpers for worker containers, through the local
// `docker` CLI (hardening flags, secrets line, labels, cleanup, copying files
// out of a stopped container).

import { execFile } from 'node:child_process';

export const IMAGE = process.env.CYSU_ENGINE_IMAGE || 'cysu-engine-workspace:dev';

// Every container the engine starts carries this label, so containers left
// behind by a crash can be found and removed at the next start.
export const LABEL = 'cysu-engine.container';

// Container limits; override with env when a machine needs more or less.
const MEMORY = process.env.CYSU_ENGINE_MEMORY || '4g';
const PIDS = process.env.CYSU_ENGINE_PIDS || '512';
const CPUS = process.env.CYSU_ENGINE_CPUS || '';

// hardeningArgs are the `docker run` flags every worker container gets.
// Only the capabilities root needs at start are kept: NET_ADMIN for the
// firewall, SETUID/SETGID to drop to runner, KILL so the root init (tini) can
// forward stop signals to runner's processes. The agent ends up with none.
export function hardeningArgs() {
  return [
    '--init',
    '--cap-drop', 'ALL',
    '--cap-add', 'NET_ADMIN',
    '--cap-add', 'SETUID',
    '--cap-add', 'SETGID',
    '--cap-add', 'KILL',
    '--security-opt', 'no-new-privileges',
    '--memory', MEMORY,
    '--memory-swap', MEMORY,
    '--pids-limit', PIDS,
    ...(CPUS ? ['--cpus', CPUS] : []),
  ];
}

export function dockerAvailable() {
  return new Promise((resolve) => {
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

// secretsLine is the one JSON line the entrypoint reads from stdin
// (CYSU_SECRETS=stdin). Secrets never go in env vars, args or files.
// The LLM login is either an OpenAI API key or a saved Codex (ChatGPT) login.
export function secretsLine(settings, codexAuth = null) {
  const secrets = { token: settings.token, passphrase: settings.passkey };
  if (settings.llm?.mode === 'openai-api-key' && settings.llm.apiKey) secrets.openaiApiKey = settings.llm.apiKey;
  if (settings.llm?.mode === 'codex' && codexAuth) secrets.codexAuth = codexAuth;
  return `${JSON.stringify(secrets)}\n`;
}

function docker(args, { encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    execFile('docker', args, { encoding, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout, stderr: String(stderr || '') });
    });
  });
}

export async function removeContainer(name) {
  await docker(['rm', '-f', name]);
}

// removeOrphanContainers removes every engine container that is still around
// (from a crash or a killed engine). Returns their names.
export async function removeOrphanContainers() {
  const list = await docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Names}}']);
  const names = list.ok ? list.stdout.split('\n').filter(Boolean) : [];
  for (const name of names) await removeContainer(name);
  return names;
}

// copyFileFromContainer reads one regular file out of a (stopped) container.
// `docker cp … -` returns a tar stream; returns the file's bytes or null.
export async function copyFileFromContainer(name, path) {
  const out = await docker(['cp', `${name}:${path}`, '-'], { encoding: 'buffer' });
  if (!out.ok || out.stdout.length < 512) return null;
  const header = out.stdout.subarray(0, 512);
  const type = String.fromCharCode(header[156] || 48);
  if (type !== '0' && type !== '\0') return null;
  const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
  if (!Number.isFinite(size) || 512 + size > out.stdout.length) return null;
  return out.stdout.subarray(512, 512 + size);
}
