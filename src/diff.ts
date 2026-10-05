/**
 * Unified-diff parsing and diff-position construction.
 *
 * This is the part that decides whether a line comment lands or the instance answers
 * `400 Note position is invalid`. GitLab does not accept a file + line number: a diff note
 * needs the MR's base/start/head SHAs plus the old *and* new line numbers of that position.
 * The model should be able to say "comment on src/app.ts line 42 of the new side" and have
 * the old-side number and the SHAs filled in here.
 */

export type DiffFile = {
  old_path: string | null;
  new_path: string | null;
  diff: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
};

/** A position GitLab accepts, in its own parameter names. */
export type Position = {
  base_sha: string;
  start_sha: string;
  head_sha: string;
  position_type: 'text';
  old_path: string;
  new_path: string;
  old_line?: number;
  new_line?: number;
};

export type LineSide = 'new' | 'old';
export type LineTarget = { old_line?: number; new_line?: number };
export type Range = { from: number; to: number };

export type ParsedDiff = {
  /** `new:42` / `old:17` -> the commentable position on that side. */
  lines: Map<string, LineTarget>;
  /** Commentable line numbers per side, merged into contiguous ranges (for error messages). */
  ranges: { new: Range[]; old: Range[] };
  hunks: number;
  additions: number;
  deletions: number;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse one file's unified diff.
 *
 * Line numbers are reconstructed from the hunk headers rather than counted from the header
 * line's own content, because the diff text GitLab returns starts at the hunk - the file's
 * first hunk may begin anywhere in the file.
 */
export function parseDiff(diff: string): ParsedDiff {
  const lines = new Map<string, LineTarget>();
  const perSide: { new: number[]; old: number[] } = { new: [], old: [] };
  let hunks = 0, additions = 0, deletions = 0;
  let oldLine = 0, newLine = 0, inHunk = false;

  const record = (side: LineSide, line: number, target: LineTarget) => {
    const key = `${side}:${line}`;
    if (!lines.has(key)) { lines.set(key, target); perSide[side].push(line); }
  };

  const rawLines = diff.split('\n');
  const lastIndex = rawLines.length - 1;

  for (const [index, raw] of rawLines.entries()) {
    const header = HUNK.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      inHunk = true;
      hunks++;
      continue;
    }
    if (!inHunk) continue;           // `--- a/x` / `+++ b/x` file preamble
    if (raw.startsWith('\\')) continue; // `\ No newline at end of file`
    // A diff string ends with a newline, and splitting on it yields a trailing empty element.
    // Counting that as an empty context line invents a line number past the end of the hunk,
    // which is how a comment on a line that does not exist got through.
    if (raw === '' && index === lastIndex) continue;

    if (raw.startsWith('+')) {
      record('new', newLine, { new_line: newLine });
      newLine++; additions++;
    } else if (raw.startsWith('-')) {
      record('old', oldLine, { old_line: oldLine });
      oldLine++; deletions++;
    } else if (raw.startsWith(' ') || raw === '') {
      // A context line: commentable from both sides, and the only case where a position
      // carries both numbers. An empty string is a context line whose leading space was lost.
      record('old', oldLine, { old_line: oldLine, new_line: newLine });
      record('new', newLine, { old_line: oldLine, new_line: newLine });
      oldLine++; newLine++;
    }
    // Anything else is not a diff line; ignoring it is safer than guessing.
  }

  const toRanges = (nums: number[]): Range[] => {
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    const out: Range[] = [];
    for (const n of sorted) {
      const last = out[out.length - 1];
      if (last && n === last.to + 1) last.to = n;
      else out.push({ from: n, to: n });
    }
    return out;
  };

  return { lines, ranges: { new: toRanges(perSide.new), old: toRanges(perSide.old) }, hunks, additions, deletions };
}

export const formatRanges = (ranges: Range[]): string =>
  ranges.length === 0 ? 'none' : ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(', ');

export type ResolvedLine = { file: DiffFile; target: LineTarget };

/**
 * Turn (path, side, line) into a position, or fail with the ranges that would have worked.
 * The error is the product here: a model that guessed the wrong line number can correct
 * itself from `commentable new-side lines: 12-40, 55` in one step instead of guessing again.
 */
export function findFiles(files: DiffFile[], path: string): DiffFile[] {
  const wanted = path.replace(/^\/+/, '');
  const candidates = files.filter((f) => f.new_path === wanted || f.old_path === wanted);
  if (candidates.length === 0) {
    const changed = files.slice(0, 20).map((f) => f.new_path ?? f.old_path).filter(Boolean);
    const more = files.length > changed.length ? `, and ${files.length - changed.length} more` : '';
    throw new Error(
      `no changed file at path '${wanted}' in this merge request. ` +
      `Changed files: ${changed.length ? changed.join(', ') + more : '(none - the MR has no diff yet)'}. ` +
      `Pass a path exactly as it appears in gitlab_mr_changes.`,
    );
  }
  return candidates;
}

export function resolveLine(
  files: DiffFile[],
  path: string,
  side: LineSide,
  line: number,
): ResolvedLine {
  const wanted = path.replace(/^\/+/, '');
  const candidates = findFiles(files, path);

  const tried: string[] = [];
  for (const file of candidates) {
    const parsed = parseDiff(file.diff ?? '');
    const hit = parsed.lines.get(`${side}:${line}`);
    if (hit) return { file, target: hit };
    tried.push(
      `${file.new_path ?? file.old_path}: no commentable ${side}-side line ${line} ` +
      `(commentable ${side}-side lines: ${formatRanges(parsed.ranges[side])})` +
      (file.diff ? '' : ' - this file has no textual diff (binary or mode change only)'),
    );
  }
  throw new Error(
    `cannot place a comment at ${wanted}:${line} (${side} side). ${tried.join('; ')}. ` +
    `Lines that exist in the diff can be commented on; use gitlab_mr_changes to see the diff.`,
  );
}

/** The position object GitLab wants, built from the resolved line and the MR's diff-version SHAs. */
export function buildPosition(
  file: DiffFile,
  target: LineTarget,
  shas: { base_sha: string; start_sha: string; head_sha: string },
): Position {
  const oldPath = file.old_path ?? file.new_path ?? '';
  const newPath = file.new_path ?? file.old_path ?? '';
  return {
    base_sha: shas.base_sha,
    start_sha: shas.start_sha,
    head_sha: shas.head_sha,
    position_type: 'text',
    old_path: oldPath,
    new_path: newPath,
    ...(target.old_line !== undefined ? { old_line: target.old_line } : {}),
    ...(target.new_line !== undefined ? { new_line: target.new_line } : {}),
  };
}

export type FileSummary = {
  old_path: string | null;
  new_path: string | null;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  additions: number;
  deletions: number;
  hunks: number;
  patch: string;
  patchTruncated: boolean;
};

/** Bounded per-file view: the model gets counts, hunk count and a capped patch. */
export function summarizeFile(file: DiffFile, maxPatchChars: number): FileSummary {
  const parsed = parseDiff(file.diff ?? '');
  const patch = file.diff ?? '';
  const cut = patch.length > maxPatchChars;
  return {
    old_path: file.old_path ?? null,
    new_path: file.new_path ?? null,
    new_file: !!file.new_file,
    deleted_file: !!file.deleted_file,
    renamed_file: !!file.renamed_file,
    additions: parsed.additions,
    deletions: parsed.deletions,
    hunks: parsed.hunks,
    patch: cut ? patch.slice(0, maxPatchChars) : patch,
    patchTruncated: cut,
  };
}

/**
 * The MR's diff-version SHAs.
 *
 * Named the way GitLab returns them (`*_commit_sha`) and mapped here to the way a position
 * needs them (`*_sha`) - the two names differ, and mixing them up is a silent 400.
 */
export function versionShas(version: Record<string, unknown>): { base_sha: string; start_sha: string; head_sha: string; id: number } {
  const pick = (key: string): string => {
    const value = version[key];
    if (typeof value !== 'string' || value === '') {
      throw new Error(
        `merge request diff version ${String(version.id)} has no '${key}'; ` +
        `cannot build a comment position. Instance response keys: ${Object.keys(version).join(', ')}`,
      );
    }
    return value;
  };
  return {
    id: Number(version.id),
    base_sha: pick('base_commit_sha'),
    start_sha: pick('start_commit_sha'),
    head_sha: pick('head_commit_sha'),
  };
}

/** Newest diff version wins: GitLab lists versions newest-first, but ordering is not a promise. */
export function latestVersion(versions: Record<string, unknown>[]): Record<string, unknown> {
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(
      'this merge request has no diff versions (it has no changes yet), so a line comment ' +
      'cannot be positioned. Comment on the merge request instead (gitlab_mr_comment).',
    );
  }
  return versions.reduce((best, v) => {
    const a = Date.parse(String(v.created_at ?? '')) || 0;
    const b = Date.parse(String(best.created_at ?? '')) || 0;
    if (a !== b) return a > b ? v : best;
    return Number(v.id) > Number(best.id) ? v : best;
  });
}
