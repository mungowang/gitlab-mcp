import { z } from 'zod';

/**
 * Named input-type registry, shared by code and JSON declarations.
 * Holds only *shape* and *usage* knowledge. Concrete project paths, branch names and
 * label names are instance data and must never live here.
 * Every `.describe()` ends up in the JSON Schema the model sees, so writing a hint once
 * makes every tool that reuses the type inherit it.
 *
 * Design rule: **no unions**. `src/cli.ts` derives its flag parser from these schemas, and
 * one name with two accepted shapes has no sane `--flag` syntax. A project is therefore a
 * string that may hold either an id or a path (see `projectRef`), not a union of the two.
 */
export const T = {
  project: z.string().min(1)
    .describe("project id ('42') or full path ('group/subgroup/app'); a path is URL-encoded for you"),
  iid: z.number().int().positive()
    .describe('project-scoped internal id - the number in !123 for a merge request or #123 for an issue, not the global id'),
  page: z.number().int().positive().describe('1-based page number; see pagination.nextPage in the result'),
  perPage: z.number().int().positive().max(100).describe('items per page, max 100 (GitLab default is 20)'),
  branch: z.string().min(1).describe('branch name, e.g. feature/login'),
  ref: z.string().min(1).describe('branch name, tag or commit SHA'),
  filePath: z.string().min(1).describe("repository-relative file path, e.g. 'src/app.ts' (no leading slash)"),
  sha: z.string().describe('40-character commit SHA'),
  labels: z.array(z.string()).describe('label names; a label that does not exist yet is created by GitLab when the caller has permission'),
  noteBody: z.string().min(1).describe('comment text (GitLab Flavored Markdown)'),
  line: z.number().int().positive().describe('1-based line number in the file'),
  side: z.enum(['new', 'old'])
    .describe("'new' = the file after the change (added and unchanged lines), 'old' = the file before it (removed and unchanged lines)"),
  mrState: z.enum(['opened', 'closed', 'locked', 'merged', 'all']),
  mrScope: z.enum(['created_by_me', 'assigned_to_me', 'all']),
  mrOrderBy: z.enum(['created_at', 'updated_at']),
  sort: z.enum(['asc', 'desc']),
  stateEvent: z.enum(['close', 'reopen']),
  search: z.string().describe('substring search'),
  // Raw escape hatch.
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  restPath: z.string().describe("API path below /api/v4, e.g. '/projects/42/merge_requests' (leading / optional)"),
  query: z.record(z.string(), z.any()).describe('query string parameters; values are stringified'),
  body: z.record(z.string(), z.any()).describe('JSON request body'),
  // Primitive names usable from JSON declarations.
  string: z.string(), number: z.number(), boolean: z.boolean(),
  object: z.record(z.string(), z.any()), array: z.array(z.any()),
} as const;

export type TypeName = keyof typeof T;
export const TYPE_NAMES = Object.keys(T) as TypeName[];

/** Unknown names are not silently downgraded to z.any(); jsonTools fails loudly at startup. */
export function resolveType(name: string): z.ZodTypeAny {
  return T[name as TypeName];
}

/**
 * A project reference as it must appear inside a URL path.
 * GitLab wants a numeric id verbatim and a full path percent-encoded: `group/app` -> `group%2Fapp`.
 * Not encoding it is the single most common cause of a 404 against this API.
 */
export function projectRef(project: string | number): string {
  const value = String(project).trim();
  return /^\d+$/.test(value) ? value : encodeURIComponent(value);
}

/** Repository file paths travel as one encoded path segment. */
export const fileRef = (path: string): string => encodeURIComponent(path.replace(/^\/+/, ''));

/** Standard `{page, perPage}` input pair, spread into a tool's `input`. */
export const pageInput = { page: T.page.optional(), perPage: T.perPage.optional() };
