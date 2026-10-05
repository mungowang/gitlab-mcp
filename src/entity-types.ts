import { z } from 'zod';

/**
 * Entity *return type* registry - the mirror image of `T` (src/types.ts) on the output side.
 *
 * ## Rule for `required` (stricter than Jira's, on purpose)
 *
 * Only keys **this client constructs itself** may be required (`items`, `pagination`, and the
 * summary objects built in `src/entities/*`). Every key that comes from the GitLab response
 * stays optional.
 *
 * Reason: these schemas were written against the 11.3.0 API documentation, not against a live
 * instance - the instance is only reachable over VPN. A required key this instance does not
 * send turns a working call into an MCP output-validation error, which is strictly worse than
 * a vaguer schema. `test/live-verify.mjs` is where the assumptions get checked; tighten these
 * only after that report is green.
 *
 * Note: tools that can return an empty body must NOT declare `returns` - a declared
 * outputSchema requires structuredContent, and an empty response violates it. On GitLab 11.3
 * the writes used here (create/update MR, notes, discussions, merge) all answer with a body,
 * so this mostly guards `gitlab_raw_api` against a DELETE.
 */

const anyRecord = z.record(z.string(), z.any());

/** Envelope: a few fixed keys, everything else allowed. */
const envelope = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();

/** GitLab mixes string and numeric ids for the same kind of object. */
const id = z.union([z.string(), z.number()]);

/**
 * Constructed by gitlabList - the only keys this client may require.
 * Declared first because every page envelope reuses it.
 */
const pagination = envelope({
  page: z.number(),
  perPage: z.number(),
  total: z.number().nullable().describe('total matches, may exceed the returned items'),
  totalPages: z.number().nullable(),
  nextPage: z.number().nullable().describe('non-null means more results exist: call again with page=nextPage'),
});

const userRef = envelope({
  id: z.number().optional(),
  username: z.string().optional(),
  name: z.string().optional(),
  state: z.string().optional(),
  web_url: z.string().optional(),
  avatar_url: z.string().nullable().optional(),
}).describe('user reference');

const positionShape = envelope({
  base_sha: z.string().describe('target-branch merge base'),
  start_sha: z.string(),
  head_sha: z.string().describe('HEAD of the source branch when the diff version was collected'),
  position_type: z.literal('text'),
  old_path: z.string(),
  new_path: z.string(),
  old_line: z.number().optional().describe('line number in the old file; absent for an added line'),
  new_line: z.number().optional().describe('line number in the new file; absent for a removed line'),
}).describe('diff position; a GitLab diff note is only valid with all of these');

const fileSummary = envelope({
  old_path: z.string().nullable(),
  new_path: z.string().nullable(),
  new_file: z.boolean(),
  deleted_file: z.boolean(),
  renamed_file: z.boolean(),
  additions: z.number().describe('count of added lines in this file'),
  deletions: z.number(),
  hunks: z.number().describe('number of diff hunks; 0 means the patch is empty'),
  patch: z.string().describe('unified diff, capped - see patchTruncated'),
  patchTruncated: z.boolean().describe('true when patch was cut short; the counts above still cover the whole file'),
}).describe('one changed file, summarised');

const note = envelope({
  id: z.number().optional(),
  body: z.string().optional(),
  author: userRef.optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  system: z.boolean().optional().describe('true for GitLab-generated notes (labels, pushes, state changes)'),
  resolvable: z.boolean().optional().describe('true when this note can be resolved - only diff notes usually are'),
  resolved: z.boolean().optional(),
  noteable_type: z.string().optional(),
  type: z.string().nullable().optional(),
  position: anyRecord.optional().describe('present on diff notes; carries new_path/new_line/old_line'),
}).describe('a note (comment) inside a discussion');

const project = envelope({
  id: z.number().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  path_with_namespace: z.string().optional().describe("full path, e.g. group/app - the value to pass as 'project'"),
  default_branch: z.string().nullable().optional(),
  web_url: z.string().optional(),
  visibility: z.string().optional(),
  archived: z.boolean().optional(),
  http_url_to_repo: z.string().optional(),
}).describe('GitLab project');

const branch = envelope({
  name: z.string().optional(),
  default: z.boolean().optional(),
  merged: z.boolean().optional(),
  protected: z.boolean().optional(),
  commit: anyRecord.optional(),
}).describe('repository branch');

const mergeRequest = envelope({
  id: z.number().optional(),
  iid: z.number().optional().describe('internal id - the number in !123'),
  project_id: z.number().optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  state: z.string().optional().describe('opened / closed / locked / merged'),
  source_branch: z.string().optional(),
  target_branch: z.string().optional(),
  work_in_progress: z.boolean().optional()
    .describe('11.3 marks a draft MR this way; the title carries a "WIP: " prefix. Verified present '
      + 'on every one of 100 merge requests on the live instance'),
  merge_status: z.string().optional()
    .describe("'can_be_merged' / 'cannot_be_merged' / 'unchecked'. A merged merge request on 11.3 "
      + 'still reports can_be_merged, so read state first - merge_status alone is not a green light'),
  sha: z.string().optional().describe('HEAD of the source branch'),
  merge_commit_sha: z.string().nullable().optional(),
  user_notes_count: z.number().optional(),
  changes_count: z.string().optional().describe('a string on 11.3, not a number'),
  has_conflicts: z.boolean().optional().describe('not sent by 11.3; compare merge_status instead'),
  assignee: userRef.nullable().optional(),
  author: userRef.optional(),
  labels: z.array(z.string()).optional(),
  milestone: anyRecord.nullable().optional(),
  web_url: z.string().optional(),
}).describe('merge request');

const discussion = envelope({
  id: z.string().optional(),
  individual_note: z.boolean().optional().describe('true for a plain comment with no thread'),
  notes: z.array(note).optional(),
  resolved: z.boolean().optional()
    .describe('derived by this client: true when every resolvable note in the discussion is resolved'),
}).describe('merge request discussion thread');

/** Page envelopes. `items` carries the real item schema so the model still sees it. */
const pageOf = (item: z.ZodTypeAny) => envelope({ items: z.array(item), pagination });

export const E = {
  pagination,
  project,
  branch,
  mergeRequest,
  discussion,
  user: userRef,
  note,
  position: positionShape,
  fileSummary,

  projectPage: pageOf(project),
  branchPage: pageOf(branch),
  mrPage: pageOf(mergeRequest),
  discussionPage: pageOf(discussion),
  /** A paginated list whose item shape is not worth pinning down (labels, users, pipelines). */
  anyPage: pageOf(envelope({})),

  changes: envelope({
    iid: id.optional(),
    web_url: z.string().optional(),
    source_branch: z.string().optional(),
    target_branch: z.string().optional(),
    sha: z.string().optional().describe('source-branch HEAD; pass this to gitlab_mr_merge to pin the merge'),
    merge_status: z.string().optional(),
    work_in_progress: z.boolean().optional(),
    files: z.array(fileSummary).describe('one entry per returned file; capped by maxPatchChars each'),
    stats: envelope({
      files: z.number().describe('total changed files in this merge request (after any path filter)'),
      shown: z.number().describe('files included in this response, capped by maxFiles'),
      omittedFiles: z.number().describe('files left out by maxFiles; ask again with path=<file> to see one'),
      additions: z.number().describe('added lines across the returned files only'),
      deletions: z.number().describe('removed lines across the returned files only'),
      truncatedFiles: z.number().describe('returned files whose patch was cut short by maxPatchChars'),
    }),
  }).describe('summarised merge request diff'),

  fileContent: envelope({
    path: z.string(),
    ref: z.string(),
    size: z.number().describe('characters returned, after truncation'),
    truncated: z.boolean(),
    content: z.string().optional(),
    dryRun: z.boolean().optional(),
    url: z.string().optional(),
  }).describe('repository file content'),

  version: envelope({
    id: z.number(),
    base_sha: z.string(),
    start_sha: z.string(),
    head_sha: z.string(),
  }).describe('merge request diff version, with the SHAs a comment position needs'),

  reviewComment: envelope({
    discussion_id: id.optional(),
    note_id: id.nullable().optional(),
    position: positionShape.optional(),
    resolved: z.boolean().optional(),
    web_url: z.string().optional(),
  }).describe('result of creating or replying to a diff comment'),

  rawResult: envelope({
    method: z.string(),
    path: z.string(),
    status: z.number().optional(),
    body: z.any(),
  }).describe('raw API result'),

  /** Use when the payload shape is not known: MCP needs an object at the root. */
  anyObject: envelope({}),
} as const;

export type EntityName = keyof typeof E;
export const ENTITY_NAMES = Object.keys(E) as EntityName[];
