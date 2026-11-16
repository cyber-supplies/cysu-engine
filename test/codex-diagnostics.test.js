import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { safeCodexDiagnostic } from '../server/stage.js';

const script = new URL('../image/codex-diagnostics.py', import.meta.url).pathname;

test('failed Codex request diagnostics retain correlation fields but no free-form log text', () => {
  const home = mkdtempSync(join(tmpdir(), 'cysu-codex-diagnostics-'));
  try {
    mkdirSync(join(home, '.codex'));
    const db = join(home, '.codex', 'logs_2.sqlite');
    execFileSync('python3', ['-c', `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('create table logs (ts integer, level text, feedback_log_body text)')
c.executemany('insert into logs values (?,?,?)', [
 (1001,'WARN','sampling_error=unexpected status 400 Bad Request: {"detail":"secret-user-data","code":"invalid_request_error","param":"input"}, url: https://chatgpt.com/backend-api/codex/responses, cf-ray: a5a578aa19478c21-DUB, request id: d835041f-009a-48d1-82df-34a8a4691909'),
 (999,'WARN','unexpected status 403, url: https://chatgpt.com/backend-api/codex/responses, request id: old-request-id'),
 (1002,'WARN','unexpected status 400, url: https://example.com/backend-api/codex/responses, request id: other-request-id'),
])
c.commit()
`, db]);
    const output = execFileSync('python3', [script, '1000', 'initial'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    const event = JSON.parse(output);
    assert.equal(event.type, 'engine.codex.diagnostic');
    assert.equal(event.kind, 'initial');
    assert.equal(event.logFound, true);
    assert.deepEqual(event.records, [{
      timestamp: 1001, status: 400, requestId: 'd835041f-009a-48d1-82df-34a8a4691909',
      cfRay: 'a5a578aa19478c21-DUB', errorCode: 'invalid_request_error', errorParam: 'input',
    }]);
    assert.doesNotMatch(output, /secret-user-data|old-request-id|other-request-id/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('diagnostics report when Codex did not create a log database', () => {
  const home = mkdtempSync(join(tmpdir(), 'cysu-codex-diagnostics-'));
  try {
    const event = JSON.parse(execFileSync('python3', [script, '1000', 'initial'],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
    assert.deepEqual(event.records, []);
    assert.equal(event.logFound, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('engine rejects free-form diagnostic content and invalid correlation IDs', () => {
  assert.deepEqual(safeCodexDiagnostic({ kind: 'initial', logFound: true, records: [
    { timestamp: 1001, status: 400, requestId: 'd835041f-009a-48d1-82df-34a8a4691909',
      cfRay: 'a5a578aa19478c21-DUB', rawMessage: 'Authorization: Bearer secret' },
    { status: 400, requestId: 'secret-token', cfRay: 'contains spaces', errorCode: 'bad code' },
  ] }), { kind: 'initial', logFound: true, records: [
    { timestamp: 1001, status: 400, requestId: 'd835041f-009a-48d1-82df-34a8a4691909', cfRay: 'a5a578aa19478c21-DUB' },
    { status: 400 },
  ] });
});
