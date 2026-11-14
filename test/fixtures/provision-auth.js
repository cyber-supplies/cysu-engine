import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Exercise the installer's local provisioning command, not an HTTP endpoint.
export function provisionToken({ dir, apiUrl, container }, token) {
  return new Promise((resolve) => {
    const child = execFile(container ? 'docker' : process.execPath,
      container ? ['exec', '-i', container, 'node', 'server/provision-auth.js']
        : [fileURLToPath(new URL('../../server/provision-auth.js', import.meta.url))],
      { env: { ...process.env, CYSU_ENGINE_DATA: dir, CYSU_API_URL: apiUrl }, timeout: 20000 },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, output: stdout + stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(token);
  });
}
