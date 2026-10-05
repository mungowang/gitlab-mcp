import { z } from 'zod';
import { gitlab, gitlabList, compact } from '../gitlab.ts';
import { defineTool } from '../tool.ts';
import { T, projectRef, pageInput } from '../types.ts';
import { E } from '../entity-types.ts';
import { summarizeFile, resolveLine, findFiles, latestVersion, versionShas, buildPosition, type DiffFile } from '../diff.ts';

/**
 * Draft handling on 11.3.
 *
 * There is no `draft` parameter and no `reviewers` attribute on this version: a draft merge
 * request is one whose title carries a "WIP: " prefix, and GitLab reports it back as
 * `work_in_progress: true`. So `draft` is translated here rather than passed through - a
 * pass-through would either be ignored silently or rejected.
 */
const WIP = /^\s*WIP:/i;
export const withDraft = (title: string, draft: boolean): string =>
  draft ? (WIP.test(title) ? title : `WIP: ${title}`) : title.replace(WIP, '').trimStart();

const userId = (what: string) => z.number().int().nonnegative()
  .describe(`${what} numeric user id (find it with gitlab_users_search); 0 unassigns`);

const mrBase = (project: string | number, iid: number) => `/projects/${projectRef(project)}/merge_requests/${iid}`;

export const mergeRequest = {
  gitlab_mr_list: defineTool({
    readOnly: true, returns: E.mrPage,
    desc: 'List a project\'s merge requests. Defaults to state=opened because the raw API would return '
      + 'every state at once. This version has no reviewers or draft filter - read work_in_progress on '
      + 'each item instead.',
    input: {
      project: T.project,
      state: T.mrState.default('opened').describe("'all' for every state"),
      scope: T.mrScope.optional().describe('created_by_me / assigned_to_me / all; combined with author_id or assignee_id'),
      author_id: userId('filter: author').optional(),
      assignee_id: userId('filter: assignee').optional(),
      labels: T.labels.optional().describe('all listed labels must match'),
      source_branch: T.branch.optional(),
      target_branch: T.branch.optional(),
      search: T.search.optional().describe('matches title and description'),
      milestone: z.string().optional().describe('milestone title'),
      order_by: T.mrOrderBy.optional(),
      sort: T.sort.optional(),
      ...pageInput,
    },
    run: (a) => gitlabList('GET', `/projects/${projectRef(a.project)}/merge_requests`, {
      query: {
        state: a.state, scope: a.scope, author_id: a.author_id, assignee_id: a.assignee_id,
        labels: a.labels?.join(','), source_branch: a.source_branch, target_branch: a.target_branch,
        search: a.search, milestone: a.milestone, order_by: a.order_by, sort: a.sort,
        page: a.page, per_page: a.perPage,
      },
    }),
  }),

  gitlab_mr_get: defineTool({
    readOnly: true, returns: E.mergeRequest,
    desc: 'Get one merge request. Read state before anything else: only an opened merge request can be '
      + 'merged, and a merged one still reports merge_status can_be_merged. work_in_progress says whether '
      + 'it is a draft.',
    input: { project: T.project, iid: T.iid },
    run: ({ project, iid }) => gitlab('GET', mrBase(project, iid)),
  }),

  gitlab_mr_changes: defineTool({
    readOnly: true, returns: E.changes,
    desc: 'The merge request diff, summarised per file: status, added/removed line counts and a capped '
      + 'patch. Read this before commenting on a line, and to learn which paths and lines exist. Use '
      + 'path to pull one file\'s patch at a larger cap.',
    input: {
      project: T.project,
      iid: T.iid,
      path: T.filePath.optional().describe('return only this file'),
      maxPatchChars: z.number().int().positive().max(100_000).default(4_000)
        .describe('patch characters per file; a cut patch sets patchTruncated'),
      maxFiles: z.number().int().positive().max(200).default(30)
        .describe('files to include; the rest are counted in stats.omittedFiles'),
    },
    run: async ({ project, iid, path, maxPatchChars, maxFiles }) => {
      const mr: any = await gitlab('GET', `${mrBase(project, iid)}/changes`);
      const all: DiffFile[] = Array.isArray(mr?.changes) ? mr.changes : [];
      const selected = path ? findFiles(all, path) : all;
      const shown = selected.slice(0, maxFiles);
      const files = shown.map((f) => summarizeFile(f, maxPatchChars));
      return {
        iid: mr?.iid, web_url: mr?.web_url, source_branch: mr?.source_branch, target_branch: mr?.target_branch,
        sha: mr?.sha, merge_status: mr?.merge_status, work_in_progress: mr?.work_in_progress,
        files,
        stats: {
          files: selected.length,
          shown: files.length,
          omittedFiles: selected.length - files.length,
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0),
          truncatedFiles: files.filter((f) => f.patchTruncated).length,
        },
      };
    },
  }),

  gitlab_mr_create: defineTool({
    returns: E.mergeRequest,
    desc: 'Create a merge request from source_branch into target_branch. On 11.3 there is no reviewers '
      + 'attribute (assign instead) and no draft parameter: pass draft:true and the required "WIP: " '
      + 'title prefix is applied for you. Creating an MR whose branches already have an open one fails '
      + 'with 409 - update that one instead.',
    input: {
      project: T.project,
      source_branch: T.branch,
      target_branch: T.branch,
      title: z.string().min(1),
      description: z.string().optional().describe('GitLab Flavored Markdown'),
      draft: z.boolean().optional().describe('mark as work in progress ("WIP: " title prefix)'),
      assignee_id: userId('assignee').optional(),
      labels: T.labels.optional(),
      milestone_id: z.number().int().positive().optional().describe('global milestone id, not the project-scoped iid'),
      remove_source_branch: z.boolean().optional().describe('remove the source branch when this MR merges'),
      squash: z.boolean().optional().describe('squash commits when this MR merges'),
    },
    run: (a) => gitlab('POST', `/projects/${projectRef(a.project)}/merge_requests`, {
      body: compact({
        source_branch: a.source_branch,
        target_branch: a.target_branch,
        title: a.draft === undefined ? a.title : withDraft(a.title, a.draft),
        description: a.description,
        assignee_id: a.assignee_id,
        labels: a.labels?.join(','),
        milestone_id: a.milestone_id,
        remove_source_branch: a.remove_source_branch,
        squash: a.squash,
      }),
    }),
  }),

  gitlab_mr_update: defineTool({
    returns: E.mergeRequest,
    desc: 'Update a merge request. Pass draft to set or clear the "WIP: " prefix (when no title is given '
      + 'the current title is read first). labels:[] clears all labels and assignee_id:0 unassigns - '
      + 'omitting a field leaves it alone.',
    input: {
      project: T.project,
      iid: T.iid,
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      draft: z.boolean().optional().describe('set or clear the "WIP: " title prefix'),
      assignee_id: userId('assignee').optional(),
      labels: T.labels.optional().describe('replaces the whole label set; [] clears it'),
      milestone_id: z.number().int().nonnegative().optional().describe('0 unassigns'),
      target_branch: T.branch.optional(),
      state_event: T.stateEvent.optional().describe('close or reopen the merge request'),
      squash: z.boolean().optional(),
      remove_source_branch: z.boolean().optional(),
      discussion_locked: z.boolean().optional().describe('when locked, only project members can comment or resolve'),
    },
    run: async (a) => {
      const base = mrBase(a.project, a.iid);
      let title = a.title;
      if (a.draft !== undefined) {
        const current = title ?? (await gitlab<any>('GET', base))?.title;
        if (typeof current !== 'string' || current === '') {
          throw new Error(
            `cannot apply draft=${a.draft}: the merge request has no readable title and none was given. ` +
            `Pass a title explicitly.`,
          );
        }
        title = withDraft(current, a.draft);
      }
      return gitlab('PUT', base, {
        body: compact({
          title,
          description: a.description,
          assignee_id: a.assignee_id,
          labels: a.labels === undefined ? undefined : a.labels.join(','),
          milestone_id: a.milestone_id,
          target_branch: a.target_branch,
          state_event: a.state_event,
          squash: a.squash,
          remove_source_branch: a.remove_source_branch,
          discussion_locked: a.discussion_locked,
        }),
      });
    },
  }),

  gitlab_mr_comment: defineTool({
    returns: E.note,
    desc: 'Post a comment on the merge request itself. For a comment on a specific line of the diff, '
      + 'use gitlab_mr_comment_on_line so it appears in the changed line\'s thread.',
    input: { project: T.project, iid: T.iid, body: T.noteBody },
    run: ({ project, iid, body }) => gitlab('POST', `${mrBase(project, iid)}/notes`, { body: { body } }),
  }),

  gitlab_mr_merge: defineTool({
    returns: E.mergeRequest,
    desc: 'Merge a merge request. The merge request must be opened - merging a merged or closed one fails. '
      + 'It fails with 405 while it is not mergeable (conflicts, or a required pipeline still running) and '
      + 'with 409 when the source branch moved since you read it, so read the merge request first and pass '
      + 'its sha to pin the merge.',
    input: {
      project: T.project,
      iid: T.iid,
      sha: T.sha.optional().describe('source-branch HEAD as you read it; a mismatch is rejected rather than merging newer commits'),
      merge_when_pipeline_succeeds: z.boolean().optional().describe('schedule the merge instead of merging now'),
      should_remove_source_branch: z.boolean().optional(),
      merge_commit_message: z.string().optional(),
    },
    run: (a) => gitlab('PUT', `${mrBase(a.project, a.iid)}/merge`, {
      body: compact({
        sha: a.sha,
        merge_when_pipeline_succeeds: a.merge_when_pipeline_succeeds,
        should_remove_source_branch: a.should_remove_source_branch,
        merge_commit_message: a.merge_commit_message,
      }),
    }),
  }),

  gitlab_mr_pipelines: defineTool({
    readOnly: true, returns: E.anyPage,
    desc: 'List the pipelines recorded against this merge request. Read before merging: 11.3 refuses the '
      + 'merge while one is running or failed.',
    input: { project: T.project, iid: T.iid, ...pageInput },
    run: ({ project, iid, page, perPage }) =>
      gitlabList('GET', `${mrBase(project, iid)}/pipelines`, { query: { page, per_page: perPage } }),
  }),

  gitlab_mr_versions: defineTool({
    readOnly: true, returns: E.anyPage,
    desc: 'List the diff versions of a merge request, newest first as GitLab returns them. Only needed to '
      + 'debug comment positions - gitlab_mr_comment_on_line resolves them itself.',
    input: { project: T.project, iid: T.iid, ...pageInput },
    run: ({ project, iid, page, perPage }) =>
      gitlabList('GET', `${mrBase(project, iid)}/versions`, { query: { page, per_page: perPage } }),
  }),
};
