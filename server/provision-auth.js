// Internal installer command: receive the mandatory --token value on stdin,
// never through HTTP or Docker environment/arguments.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './store.js';
import { fetchProfiles } from './profiles.js';

try {
  let token = '';
  for await (const chunk of process.stdin) {
    token += chunk;
    if (token.length > 4096) throw new Error('User token is too long.');
  }
  if (!/^usr_[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('A Cyber Supplies user token (usr_...) is required by the installer.');
  }
  try {
    await fetchProfiles(token);
  } catch (error) {
    if (error.upstreamStatus === 401 || error.upstreamStatus === 403) {
      throw new Error('Cyber Supplies did not accept this user token.');
    }
    throw new Error('Could not check the user token with Cyber Supplies; try again when it is reachable.');
  }
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = join(DATA_DIR, 'auth.' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify({ token }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(DATA_DIR, 'auth.json'));
  } finally {
    await rm(temporary, { force: true });
  }
  console.log('Engine token provisioned locally.');
} catch (error) {
  console.error(error.code ? 'Could not write engine authentication data.' : error.message);
  process.exitCode = 1;
}
