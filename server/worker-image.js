// Resolve one worker image per run. The mutable :latest tag is refreshed before
// a run starts, then its local image ID is used for every stage in that run.

import { execFile } from 'node:child_process';

const PULL_TIMEOUT_MS = 10 * 60_000;

function docker(args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

export async function prepareWorkerImage(ref, runDocker = docker) {
  let warning;
  let refreshed = false;
  if (ref.endsWith(':latest')) {
    try {
      await runDocker(['pull', '--quiet', ref], PULL_TIMEOUT_MS);
      refreshed = true;
    } catch (error) {
      warning = `Could not refresh ${ref}: ${error.message}`;
    }
  }
  let id;
  try {
    id = await runDocker(['image', 'inspect', '--format', '{{.Id}}', ref]);
  } catch (error) {
    throw new Error(warning || `Worker image ${ref} is unavailable: ${error.message}`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error(`Worker image ${ref} returned an invalid image ID`);
  return { ref, id, refreshed, ...(warning ? { warning } : {}) };
}
