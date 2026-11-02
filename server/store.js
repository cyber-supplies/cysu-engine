// store.js keeps the engine's local state as JSON files in DATA_DIR.
// Secrets (token, passkey, LLM key) live only here, on the user's machine.

import { mkdir, readFile, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const DATA_DIR = process.env.CYSU_ENGINE_DATA || join(process.cwd(), 'data');

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
}

export async function load(name, fallback) {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, `${name}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function save(name, value) {
  await ensureDir();
  const file = join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
}

export async function remove(name) {
  await rm(join(DATA_DIR, `${name}.json`), { force: true });
}
