import { z } from 'zod';
import { gitlab, gitlabList } from '../gitlab.ts';
import { defineTool } from '../tool.ts';
import { T, projectRef, pageInput } from '../types.ts';
import { E } from '../entity-types.ts';
import { resolveLine, buildPosition, latestVersion, versionShas, type DiffFile } from '../diff.ts';

/**
 * Merge request discussions: read threads, comment on a diff line, reply, resolve.
 *
 * This is what "review" means on GitLab CE 11.3: there is no approve API on this edition
 * (`merge_request_approvals` does not exist in the CE 11.3 tree), so review state is carried
 * by diff comments and by resolving threads.
 */

const mrBase = (project: string | number, iid: number) => `/projects/${projectRef(project)}/merge_requests/${iid}`;

const capBody = (body: unknown, max: number): unknown => {
  if (typeof body !== 'string' || body.length <= max) return body;
  return `${body.slice(0, max)}\n… [truncated: ${body.length} characters total]`;
};

/**
 * Normalise a discussion for the model:
 * - `resolved` is derived (11.3 resolves *notes*, not discussions - there is no field for it);
 * - system notes (labels, pushes, "changed the description") are dropped unless asked for,
 *   because they bury the actual review comments;
 * - long bodies are cut with an explicit marker.
 */
export function summarizeDiscussion(
  d: any,
  opts: { includeSystem: boolean; maxBodyChars: number },
): { id?: string; individual_note?: boolean; resolved?: boolean; notes: any[] } {
  const raw: any[] = Array.isArray(d?.notes) ? d.notes : [];
  const resolvable = raw.filter((n) => n?.resolvable);
  return {
    id: d?.id,
    individual_note: d?.individual_note,
    resolved: resolvable.length > 0 ? resolvable.every((n) => !!n.resolved) : undefined,
    notes: raw
      .filter((n) => opts.includeSystem || !n?.system)
      .map((n) => ({ ...n, body: capBody(n.body, opts.maxBodyChars) })),
  };
}

export const discussion = {
  gitlab_mr_discussions: defineTool({
    readOnly: true, returns: E.discussionPage,
    desc: 'List the discussion threads of a merge request, with each diff comment\'s file and line. '
      + 'System notes are filtered out by default and `resolved` is derived from the thread\'s notes, so '
      + 'the returned page can be shorter than pagination.total (which is GitLab\'s raw count).',
    input: {
      project: T.project,
      iid: T.iid,
      includeSystem: z.boolean().default(false).describe('keep GitLab-generated notes (label, push, state changes)'),
      onlyUnresolved: z.boolean().default(false)
        .describe('keep only threads that have resolvable notes and none of them resolved'),
      maxBodyChars: z.number().int().positive().max(100_000).default(4_000).describe('per comment; longer text is marked as truncated'),
      ...pageInput,
    },
    run: async ({ project, iid, includeSystem, onlyUnresolved, maxBodyChars, page, perPage }) => {
      const result = await gitlabList<any>('GET', `${mrBase(project, iid)}/discussions`, {
        query: { page, per_page: perPage },
      });
      const items = result.items
        .map((d) => summarizeDiscussion(d, { includeSystem, maxBodyChars }))
        .filter((d) => d.notes.length > 0)
        .filter((d) => !onlyUnresolved || d.resolved === false);
      return { ...result, items };
    },
  }),

  gitlab_mr_comment_on_line: defineTool({
    returns: E.reviewComment,
    desc: 'Comment on one line of the merge request diff, as a normal review comment. Give the path exactly '
      + 'as gitlab_mr_changes reports it and the line number in that side of the file. The required '
      + 'base/start/head SHAs and the old-side line number are resolved from the merge request\'s latest '
      + 'diff version, so a stale SHA or a line that is not in the diff is reported instead of being sent. '
      + 'The result carries discussion_id - pass it to gitlab_mr_reply to continue the thread.',
    input: {
      project: T.project,
      iid: T.iid,
      path: T.filePath,
      line: T.line,
      side: T.side.default('new'),
      body: T.noteBody,
    },
    run: async ({ project, iid, path, line, side, body }) => {
      const base = mrBase(project, iid);
      // The SHAs a position needs live on the *diff version*, under `*_commit_sha`; the entry point
      // is the version list, so this is two reads before the write.
      const versions = await gitlab<any[]>('GET', `${base}/versions`);
      const shas = versionShas(latestVersion(versions));
      const version: any = await gitlab('GET', `${base}/versions/${shas.id}`);
      const diffs: DiffFile[] = Array.isArray(version?.diffs) ? version.diffs : [];
      if (diffs.length === 0) {
        throw new Error(
          `diff version ${shas.id} of merge request !${iid} returned no files, so no line can be ` +
          `positioned. Call gitlab_mr_changes to check whether the merge request has a diff at all.`,
        );
      }
      const { file, target } = resolveLine(diffs, path, side, line);
      const position = buildPosition(file, target, shas);
      // Nested JSON for `position` is what the Rails params parsing expects; the docs write it as
      // `position[base_sha]` because their examples are curl form posts.
      const created: any = await gitlab('POST', `${base}/discussions`, { body: { body, position } });
      return {
        discussion_id: created?.id,
        note_id: Array.isArray(created?.notes) ? created.notes[0]?.id ?? null : null,
        position,
        resolved: false,
      };
    },
  }),

  gitlab_mr_reply: defineTool({
    returns: E.reviewComment,
    desc: 'Reply inside an existing discussion thread. Use it to answer a review comment instead of starting '
      + 'a second thread on the same line.',
    input: {
      project: T.project,
      iid: T.iid,
      discussion_id: z.string().min(1).describe('from gitlab_mr_discussions or a previous comment_on_line result'),
      body: T.noteBody,
    },
    run: async ({ project, iid, discussion_id, body }) => {
      const created: any = await gitlab('POST', `${mrBase(project, iid)}/discussions/${discussion_id}/notes`, {
        body: { body },
      });
      return { discussion_id, note_id: created?.id ?? null };
    },
  }),

  gitlab_mr_resolve: defineTool({
    returns: E.discussion,
    desc: 'Resolve or unresolve a discussion thread. This is how review state is recorded on CE 11.3, '
      + 'which has no approve API. Reply to the thread first if the resolution needs an explanation.',
    input: {
      project: T.project,
      iid: T.iid,
      discussion_id: z.string().min(1),
      resolved: z.boolean().default(true),
    },
    run: async ({ project, iid, discussion_id, resolved }) => {
      const updated: any = await gitlab('PUT', `${mrBase(project, iid)}/discussions/${discussion_id}`, {
        query: { resolved },
      });
      return summarizeDiscussion(updated, { includeSystem: true, maxBodyChars: 100_000 });
    },
  }),
};
