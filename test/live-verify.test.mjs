import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startMock } from './mock-gitlab.mjs';
import { ROOT } from './harness.mjs';

/**
 * The live verification script is the thing that runs on VPN day, against the real instance.
 * It is exercised here against the mock so that a bug in *the script* cannot be mistaken for a
 * finding about the instance - the two failure modes look identical in its output.
 */

let mock;

before(async () => { mock = await startMock(18093); });
after(() => mock?.server.close());

const runVerify = (args) => new Promise((ok) => {
  const proc = spawn(process.execPath, [`${ROOT}/test/live-verify.mjs`, ...args], {
    cwd: ROOT,
    env: { ...process.env, GITLAB_BASE_URL: mock.url, GITLAB_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.on('close', (code) => ok({ code, stdout, stderr }));
});

test('read-only verification passes against a faithful 11.3 instance', async () => {
  const { code, stdout, stderr } = await runVerify(['--project', 'group/app', '--iid', '7']);
  assert.equal(stderr, '');
  assert.equal(code, 0, stdout);
  assert.match(stdout, /\[PASS\] GET \/version answers/);
  assert.match(stdout, /\[PASS\] GET \/versions exists and names its SHAs \*_commit_sha/);
  assert.match(stdout, /\[PASS\] a diff version carries diffs that parse/);
  assert.match(stdout, /\[SKIP\] diff note write path/);
  assert.equal(stdout.includes('[FAIL]'), false, stdout);
});

test('write verification creates, resolves and deletes one probe note', async () => {
  const { code, stdout } = await runVerify(['--project', 'group/app', '--iid', '7', '--write']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /\[PASS\] POST a diff note with a nested position object/);
  assert.match(stdout, /\[PASS\] the note is really on the diff/);
  assert.match(stdout, /\[PASS\] resolve and unresolve a thread/);
  assert.match(stdout, /\[PASS\] cleanup: the probe note is deleted/);
  assert.equal(stdout.includes('[FAIL]'), false, stdout);

  // The probe must not survive the run.
  const remaining = mock.log.filter((c) => c.method === 'DELETE');
  assert.equal(remaining.length >= 1, true, 'the probe note was never deleted');
});

test('an unresolvable project searches for candidates instead of repeating the 404', async () => {
  const { code, stdout } = await runVerify(['--project', 'nope/AutoTest_Python', '--iid', '7']);
  assert.equal(code, 1);
  assert.match(stdout, /'nope\/AutoTest_Python' did not resolve/);
  assert.match(stdout, /projects matching 'AutoTest_Python'/);
  assert.match(stdout, /group\/app {2}id=42/);
  assert.match(stdout, /users matching 'nope'/);
  assert.match(stdout, /re-run with --project/);
  // One failure and one skip, not the same 404 repeated once per check.
  assert.equal(stdout.match(/\[FAIL\]/g).length, 1, stdout);
  assert.match(stdout, /\[SKIP\] the remaining project checks/);
});

test('the script refuses to run without connection settings', async () => {
  const proc = spawn(process.execPath, [`${ROOT}/test/live-verify.mjs`], {
    cwd: ROOT, env: { ...process.env, GITLAB_BASE_URL: '', GITLAB_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  const code = await new Promise((ok) => proc.on('close', ok));
  assert.equal(code, 1);
  assert.match(stdout, /\[FAIL\] connection settings/);
});
