// docker.js: shared helpers for worker containers, through the local
// `docker` CLI (hardening flags, secrets line, labels, cleanup, copying files
// out of a stopped container).

import { execFile } from 'node:child_process';
import { llmProvider } from './llm-policy.js';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

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
// firewall, CHOWN to restrict the proxy environment file to runner,
// SETUID/SETGID to drop to runner, KILL so the root init (tini) can forward
// stop signals to runner's processes. The agent ends up with none.
export function hardeningArgs() {
  return [
    '--init',
    '--cap-drop', 'ALL',
    '--cap-add', 'NET_ADMIN',
    '--cap-add', 'CHOWN',
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
// (CYSU_SECRETS=stdin). Secrets never go in Docker env vars or arguments.
// Only the selected provider credential enters the worker; the entrypoint
// installs it in a private file inside that ephemeral container.
export function secretsLine(settings, codexAuth = null, engineKey = '', userSecrets = {}, provider = llmProvider(settings.llm, codexAuth)) {
  const secrets = { token: settings.token, passphrase: settings.passkey };
  if (engineKey) secrets.engineKey = engineKey;
  if (userSecrets && Object.keys(userSecrets).length) secrets.env = { ...userSecrets };
  if (provider === 'openai') secrets.openaiApiKey = settings.llm.apiKey;
  if (provider === 'codex') secrets.codexAuth = codexAuth;
  if (provider === 'openrouter') secrets.openrouterApiKey = settings.llm.openrouter.apiKey;
  return `${JSON.stringify(secrets)}\n`;
}

function docker(args, { encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    execFile('docker', args, { encoding, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout, stderr: String(stderr || '') });
    });
  });
}

// ---- engine linked ------------------------------------------------------------
// With "engine linked", a stage's worker joins a private Docker network that
// the engine's own container is also on, and may reach the engine there (its
// agent port only; the worker firewall still blocks everything else private).
export const ENGINE_NETWORK = process.env.CYSU_ENGINE_NETWORK || 'cysu-engine-net';
export const AGENT_PORT = Number(process.env.CYSU_ENGINE_AGENT_PORT || 8788);

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

// networkIp: the container's IPv4 address on ENGINE_NETWORK, or ''.
async function networkIp(container) {
  const out = await docker(['inspect', '-f', `{{with index .NetworkSettings.Networks "${ENGINE_NETWORK}"}}{{.IPAddress}}{{end}}`, container]);
  const ip = out.ok ? out.stdout.trim() : '';
  return IPV4.test(ip) ? ip : '';
}

// connectEngine puts the engine's own container on ENGINE_NETWORK (creating
// the network the first time) and returns { network, ip }. Only works when
// the engine runs in its container (scripts/engine.sh); throws otherwise.
// CYSU_ENGINE_CONTAINER names the container when its hostname is not its id.
export async function connectEngine() {
  const self = process.env.CYSU_ENGINE_CONTAINER || (existsSync('/.dockerenv') ? hostname() : '');
  if (!self) throw new Error('engine linked needs the engine to run in its container (scripts/engine.sh start)');
  const me = await docker(['inspect', '-f', '{{.Id}}', self]);
  if (!me.ok) throw new Error(`engine linked: could not find the engine's own container (${self})`);
  const id = me.stdout.trim();
  const net = await docker(['network', 'inspect', '-f', '{{.Id}}', ENGINE_NETWORK]);
  if (!net.ok) {
    const made = await docker(['network', 'create', '--driver', 'bridge', '--label', `${LABEL}=network`, ENGINE_NETWORK]);
    if (!made.ok && !/already exists/i.test(made.stderr)) throw new Error(`engine linked: could not create the ${ENGINE_NETWORK} network: ${made.stderr.trim()}`);
  }
  let ip = await networkIp(id);
  if (!ip) {
    const joined = await docker(['network', 'connect', ENGINE_NETWORK, id]);
    if (!joined.ok && !/already exists|already attached/i.test(joined.stderr)) throw new Error(`engine linked: could not join the ${ENGINE_NETWORK} network: ${joined.stderr.trim()}`);
    ip = await networkIp(id);
  }
  if (!ip) throw new Error(`engine linked: the engine has no IPv4 address on ${ENGINE_NETWORK}`);
  return { network: ENGINE_NETWORK, ip };
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
