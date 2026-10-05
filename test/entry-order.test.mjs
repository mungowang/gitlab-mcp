import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

/**
 * The bin entries decide between the sources and the bundle by what is on disk, and the order is
 * load-bearing: preferring dist/ lets a checkout run a stale build after any `npm run build`,
 * which is how a fixed bug stayed hidden in the sibling jira-mcp project during exactly this kind
 * of verification. The rule therefore gets a test rather than a comment.
 *
 * Stubs are used instead of the real tree so the test never touches the package's own dist/.
 */
const STUB_SRC = "process.stdout.write('SRC\\n');\n";
const STUB_DIST = "process.stdout.write('DIST\\n');\n";
const BINS = ['gitlab-server.mjs', 'gitlab.mjs'];

function fixture({ source, dist }) {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-entry-'));
  mkdirSync(join(dir, 'bin'));
  for (const bin of BINS) copyFileSync(join(ROOT, 'bin', bin), join(dir, 'bin', bin));
  if (source) {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/index.ts'), STUB_SRC);
    writeFileSync(join(dir, 'src/cli.ts'), STUB_SRC);
  }
  if (dist) {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist/index.js'), STUB_DIST);
    writeFileSync(join(dir, 'dist/cli.js'), STUB_DIST);
  }
  return dir;
}

const run = (dir, bin) => spawnSync(process.execPath, [join(dir, 'bin', bin)], { encoding: 'utf8' });

test('sources win when both are present, so a checkout cannot run a stale build', () => {
  const dir = fixture({ source: true, dist: true });
  for (const bin of BINS) {
    const result = run(dir, bin);
    assert.equal(result.stdout.trim(), 'SRC', `${bin} ran the bundle while sources were present`);
  }
});

test('an install with no sources runs the bundle', () => {
  const dir = fixture({ source: false, dist: true });
  for (const bin of BINS) {
    const result = run(dir, bin);
    assert.equal(result.stdout.trim(), 'DIST', `${bin} did not fall back to the bundle`);
  }
});

test('a checkout with no build runs the sources', () => {
  const dir = fixture({ source: true, dist: false });
  for (const bin of BINS) {
    assert.equal(run(dir, bin).stdout.trim(), 'SRC');
  }
});

test('neither entry present fails with a message that says what to do', () => {
  const dir = fixture({ source: false, dist: false });
  for (const bin of BINS) {
    const result = run(dir, bin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /found neither .*src[/\\](index|cli)\.ts nor .*dist[/\\](index|cli)\.js/);
    assert.match(result.stderr, /source checkout|install the published package/);
  }
});
