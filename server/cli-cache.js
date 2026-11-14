// cli-cache.js keeps the Cyber Supplies CLI (and its skill) for workers in a
// Docker volume, so a new CLI release reaches stages without a new worker
// image and without every stage running `npm install` (option B).
//
//   - At the start of each run the engine decides which CLI version the run
//     uses (CYSU_CLI_VERSION: "latest", the default; an exact "x.y.z"; or
//     "image" for the copy baked into the worker image). "latest" is looked up
//     on npm at most once an hour.
//   - A version not in the volume yet is installed ONCE, by a short-lived
//     container of the worker image: `npm install` of that exact version plus
//     the skill from the cysu-cli release tag of the same version, into
//     <volume>/<version>, swapped in only when complete and working.
//   - Every stage of the run mounts the volume read-only and gets
//     CYSU_CLI_DIR=/opt/cysu-cache/<version>; the entrypoint puts that CLI
//     first on PATH and uses its skill. One version for the whole run.
//   - If npm or GitHub cannot be reached, or the install fails, the run uses
//     the newest version already in the volume, else the image's own copy.

import { execFile } from 'node:child_process';
import { IMAGE } from './docker.js';

export const CLI_VOLUME = process.env.CYSU_CLI_VOLUME || 'cysu-engine-cli';
export const CLI_MOUNT = '/opt/cysu-cache';
const PACKAGE = '@cyber-supplies/cysu';
const NPM_LATEST_URL = 'https://registry.npmjs.org/@cyber-supplies%2fcysu/latest';
export const LATEST_CHECK_MS = 60 * 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const KEEP_VERSIONS = 3;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

export const isVersion = (value) => typeof value === 'string' && VERSION.test(value);

// Newest first.
export function byVersionDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
}

/** The setting: "latest" (default), "image", or an exact version. Anything else is "latest". */
export function cliSetting(value = process.env.CYSU_CLI_VERSION) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'image') return 'image';
  if (isVersion(v)) return v;
  return 'latest';
}

async function npmLatest() {
  const response = await fetch(NPM_LATEST_URL, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`npm answered HTTP ${response.status}`);
  const { version } = await response.json();
  if (!isVersion(version)) throw new Error('npm gave no usable version');
  return version;
}

function runDocker(args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error((stderr || error.message).trim().split('\n').slice(-3).join(' | ')), { stdout }));
      else resolve(stdout);
    });
  });
}

// The installer, run as root in a throwaway worker-image container with the
// volume at /c. $V is the exact version. Everything goes to a temporary
// folder first; it replaces /c/$V only when the CLI runs and the skill is there.
const INSTALL_SCRIPT = `
set -eu
t="/c/.tmp-$V-$$"
rm -rf "$t"; mkdir -p "$t/skill"
npm install -g --prefix "$t" --no-audit --no-fund --loglevel=error "${PACKAGE}@$V" >/dev/null
"$t/bin/cysu" help >/dev/null
curl -fsSL --max-time 120 "https://codeload.github.com/cyber-supplies/cysu-cli/tar.gz/refs/tags/v$V" \\
  | tar -xz -C "$t/skill" --strip-components=3 "cysu-cli-$V/skill/cysu"
test -f "$t/skill/SKILL.md"
printf '%s\\n' "$V" > "$t/version"
chmod -R a+rX "$t"
rm -rf "/c/$V"; mv "$t" "/c/$V"
`;

// Lists the versions in the volume (folders with a version file and a CLI).
const LIST_SCRIPT = `for d in /c/*/; do v=$(basename "$d"); [ -f "$d/version" ] && [ -x "$d/bin/cysu" ] && echo "$v"; done; exit 0`;

export class CliCache {
  constructor({ image = IMAGE, volume = CLI_VOLUME, setting = cliSetting(), latest = npmLatest, docker = runDocker, now = Date.now } = {}) {
    Object.assign(this, { image, volume, setting, latestLookup: latest, docker, now });
    this.latestKnown = null; // { version, at }
    this.installed = null;   // Set of versions, read from the volume once
    this.busy = null;        // one prepare at a time
  }

  volumeArgs(extra = []) {
    return ['run', '--rm', '--entrypoint', 'sh', '-v', `${this.volume}:/c`, '--memory', '1g', ...extra, this.image];
  }

  async installedVersions() {
    if (!this.installed) {
      const out = await this.docker([...this.volumeArgs(), '-c', LIST_SCRIPT]).catch(() => '');
      this.installed = new Set(out.split('\n').map((line) => line.trim()).filter(isVersion));
    }
    return this.installed;
  }

  async latestVersion() {
    if (this.latestKnown && this.now() - this.latestKnown.at < LATEST_CHECK_MS) return this.latestKnown.version;
    const version = await this.latestLookup();
    this.latestKnown = { version, at: this.now() };
    return version;
  }

  async install(version) {
    await this.docker([...this.volumeArgs(['-e', `V=${version}`]), '-c', INSTALL_SCRIPT], { timeout: INSTALL_TIMEOUT_MS });
    (await this.installedVersions()).add(version);
    await this.prune().catch(() => {});
  }

  // Keeps the newest KEEP_VERSIONS (a run that started earlier may still use an older one).
  async prune() {
    const versions = [...(await this.installedVersions())].sort(byVersionDesc);
    const drop = versions.slice(KEEP_VERSIONS);
    if (drop.length === 0) return;
    await this.docker([...this.volumeArgs(), '-c', `cd /c && rm -rf ${drop.map((v) => `'${v}'`).join(' ')}`]);
    for (const v of drop) this.installed.delete(v);
  }

  /**
   * Decide the CLI for one run. Never throws: the answer is always usable.
   * Returns { version, source: 'cache'|'image', note, mounts, env }.
   */
  prepare() {
    this.busy = (this.busy || Promise.resolve()).then(() => this.decide(), () => this.decide());
    return this.busy;
  }

  async decide() {
    const image = (note) => ({ version: null, source: 'image', note, mounts: [], env: {} });
    const cached = (version, note) => ({
      version, source: 'cache', note,
      mounts: ['-v', `${this.volume}:${CLI_MOUNT}:ro`],
      env: { CYSU_CLI_DIR: `${CLI_MOUNT}/${version}` },
    });
    if (this.setting === 'image') return image('CYSU_CLI_VERSION=image: the copy in the worker image');

    let wanted = this.setting === 'latest' ? null : this.setting;
    let problem = '';
    if (!wanted) {
      try { wanted = await this.latestVersion(); } catch (error) { problem = `could not check npm for the newest CLI (${error.message})`; }
    }
    const installed = await this.installedVersions();
    if (wanted && installed.has(wanted)) return cached(wanted, wanted);
    if (wanted) {
      try {
        await this.install(wanted);
        return cached(wanted, `${wanted} (just downloaded)`);
      } catch (error) {
        problem = `could not download CLI ${wanted} (${error.message})`;
      }
    }
    const fallback = [...installed].sort(byVersionDesc)[0];
    if (fallback) return cached(fallback, `${fallback}, the newest already downloaded: ${problem}`);
    return image(`the copy in the worker image: ${problem}`);
  }
}
