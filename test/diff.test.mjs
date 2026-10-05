import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDiff, resolveLine, findFiles, buildPosition, summarizeFile,
  versionShas, latestVersion, formatRanges,
} from '../src/diff.ts';
import { fixtures } from './mock-gitlab.mjs';

const { APP_DIFF, README_DIFF } = fixtures;
const files = [
  { old_path: 'src/app.ts', new_path: 'src/app.ts', diff: APP_DIFF },
  { old_path: 'README.md', new_path: 'README.md', diff: README_DIFF },
  { old_path: 'logo.png', new_path: 'logo.png', diff: '' },
];

test('parseDiff reconstructs line numbers from the hunk header, not from line 1', () => {
  const parsed = parseDiff(APP_DIFF);
  assert.equal(parsed.hunks, 1);
  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 0);
  // First context line of the hunk is old 10 / new 10, not 1.
  assert.deepEqual(parsed.lines.get('new:10'), { old_line: 10, new_line: 10 });
  // The added lines sit at new 13/14 and have no old-side number, so they cannot be addressed
  // from the old side at all.
  assert.deepEqual(parsed.lines.get('new:13'), { new_line: 13 });
  assert.deepEqual(parsed.lines.get('new:14'), { new_line: 14 });
  assert.equal(parsed.lines.has('old:17'), false);
  // After two additions the sides disagree: the context line `const d = 4;` is new 15, old 13.
  assert.deepEqual(parsed.lines.get('new:15'), { old_line: 13, new_line: 15 });
  assert.deepEqual(parsed.lines.get('old:13'), { old_line: 13, new_line: 15 });
});

test('parseDiff gives a removed line an old-side number only', () => {
  const removal = ['@@ -1,3 +1,2 @@', ' keep', '-gone', ' keep too', ''].join('\n');
  const parsed = parseDiff(removal);
  assert.deepEqual(parsed.lines.get('old:2'), { old_line: 2 });
  assert.equal(parsed.lines.has('new:2'), true, 'new 2 is the context line that follows');
  assert.deepEqual(parsed.lines.get('new:2'), { old_line: 3, new_line: 2 });
  assert.equal(parsed.deletions, 1);
  assert.equal(parsed.additions, 0);
});

test('parseDiff does not invent a line past the end of the hunk', () => {
  // A diff string ends with a newline; treating the resulting empty element as a context line
  // is how a comment on a line that does not exist got through.
  const parsed = parseDiff(README_DIFF);
  assert.equal(parsed.lines.has('new:4'), false);
  assert.equal(parsed.lines.has('old:3'), false);
  assert.deepEqual(parsed.ranges.new, [{ from: 1, to: 3 }]);
  assert.deepEqual(parsed.ranges.old, [{ from: 1, to: 2 }]);
});

test('parseDiff handles a middle addition in a tiny file', () => {
  const parsed = parseDiff(README_DIFF);
  assert.deepEqual(parsed.lines.get('new:2'), { new_line: 2 });
  assert.deepEqual(parsed.lines.get('new:3'), { old_line: 2, new_line: 3 });
  assert.deepEqual(parsed.lines.get('old:2'), { old_line: 2, new_line: 3 });
});

test('parseDiff reports commentable ranges per side', () => {
  const parsed = parseDiff(APP_DIFF);
  assert.deepEqual(parsed.ranges.new, [{ from: 10, to: 18 }]);
  assert.deepEqual(parsed.ranges.old, [{ from: 10, to: 16 }]);
  assert.equal(formatRanges(parsed.ranges.old), '10-16');
  assert.equal(formatRanges([]), 'none');
});

test('resolveLine maps path + side + line onto a position', () => {
  const added = resolveLine(files, 'src/app.ts', 'new', 13);
  assert.deepEqual(added.target, { new_line: 13 });
  const context = resolveLine(files, 'README.md', 'new', 3);
  assert.deepEqual(context.target, { old_line: 2, new_line: 3 });
  const removedSide = resolveLine(files, 'src/app.ts', 'old', 12);
  assert.deepEqual(removedSide.target, { old_line: 12, new_line: 12 });
});

test('resolveLine tolerates a leading slash and reports the same file', () => {
  assert.equal(resolveLine(files, '/src/app.ts', 'new', 10).file.new_path, 'src/app.ts');
});

test('resolveLine names the lines that would have worked', () => {
  assert.throws(
    () => resolveLine(files, 'src/app.ts', 'new', 99),
    /no commentable new-side line 99 \(commentable new-side lines: 10-18\)/,
  );
  // Side matters: the old side simply has no line 17 in this hunk.
  assert.throws(
    () => resolveLine(files, 'src/app.ts', 'old', 17),
    /commentable old-side lines: 10-16/,
  );
});

test('resolveLine says which files do exist when the path is wrong', () => {
  assert.throws(
    () => resolveLine(files, 'src/nope.ts', 'new', 1),
    /no changed file at path 'src\/nope\.ts'.*Changed files: src\/app\.ts, README\.md, logo\.png/s,
  );
});

test('findFiles matches the old path of a rename and rejects an unknown one', () => {
  const renamed = [{ old_path: 'old/name.ts', new_path: 'new/name.ts', diff: README_DIFF }];
  assert.equal(findFiles(renamed, 'old/name.ts').length, 1);
  assert.throws(() => findFiles(renamed, 'nope.ts'), /no changed file/);
});

test('buildPosition fills both paths and only the lines that exist', () => {
  const shas = { base_sha: 'b', start_sha: 's', head_sha: 'h' };
  const added = buildPosition({ old_path: 'src/app.ts', new_path: 'src/app.ts', diff: APP_DIFF }, { new_line: 13 }, shas);
  assert.deepEqual(added, {
    base_sha: 'b', start_sha: 's', head_sha: 'h', position_type: 'text',
    old_path: 'src/app.ts', new_path: 'src/app.ts', new_line: 13,
  });
  // A deleted file has no new_path; the old path must then serve as both.
  const deleted = buildPosition({ old_path: 'gone.ts', new_path: null, diff: '' }, { old_line: 3 }, shas);
  assert.equal(deleted.old_path, 'gone.ts');
  assert.equal(deleted.new_path, 'gone.ts');
  assert.equal(deleted.new_line, undefined);
});

test('versionShas maps the *_commit_sha names the API returns onto the *_sha names a position needs', () => {
  const shas = versionShas({ id: 110, head_commit_sha: 'H', base_commit_sha: 'B', start_commit_sha: 'S' });
  assert.deepEqual(shas, { id: 110, base_sha: 'B', start_sha: 'S', head_sha: 'H' });
  assert.throws(() => versionShas({ id: 110, head_commit_sha: 'H' }), /has no 'base_commit_sha'/);
});

test('latestVersion picks the newest entry, not the first one', () => {
  const older = { id: 108, created_at: '2026-01-01T00:00:00.000Z' };
  const newer = { id: 110, created_at: '2026-01-02T00:00:00.000Z' };
  assert.equal(latestVersion([older, newer]).id, 110);
  assert.equal(latestVersion([newer, older]).id, 110);
  // Without timestamps the higher id wins, rather than trusting array order.
  assert.equal(latestVersion([{ id: 5 }, { id: 9 }]).id, 9);
  assert.throws(() => latestVersion([]), /no diff versions/);
});

test('summarizeFile caps the patch and says so', () => {
  const full = summarizeFile({ old_path: 'src/app.ts', new_path: 'src/app.ts', diff: APP_DIFF }, 10_000);
  assert.equal(full.patchTruncated, false);
  assert.equal(full.additions, 2);
  const cut = summarizeFile({ old_path: 'src/app.ts', new_path: 'src/app.ts', diff: APP_DIFF }, 20);
  assert.equal(cut.patchTruncated, true);
  assert.equal(cut.patch.length, 20);
  // Counts still describe the whole file, which is the point of reporting them separately.
  assert.equal(cut.additions, 2);
});

test('summarizeFile reports a file with no textual diff as zero hunks', () => {
  const binary = summarizeFile({ old_path: 'logo.png', new_path: 'logo.png', diff: '' }, 1000);
  assert.equal(binary.hunks, 0);
  assert.equal(binary.patch, '');
  assert.equal(binary.additions, 0);
});
