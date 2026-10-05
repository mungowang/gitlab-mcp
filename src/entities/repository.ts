import { z } from 'zod';
import { gitlab, gitlabList, gitlabText, isDryRun, resolveUrl } from '../gitlab.ts';
import { defineTool } from '../tool.ts';
import { T, projectRef, fileRef, pageInput } from '../types.ts';
import { E } from '../entity-types.ts';

export const repository = {
  gitlab_branches_list: defineTool({
    readOnly: true, returns: E.branchPage,
    desc: 'List a project\'s branches. Useful before gitlab_mr_create to confirm the source branch '
      + 'exists and to find the target branch.',
    input: { project: T.project, search: T.search.optional(), ...pageInput },
    run: ({ project, search, page, perPage }) =>
      gitlabList('GET', `/projects/${projectRef(project)}/repository/branches`, {
        query: { search, page, per_page: perPage },
      }),
  }),

  gitlab_file_get: defineTool({
    readOnly: true, returns: E.fileContent,
    desc: 'Read one file from the repository at a ref. Defaults to the project default branch - pass '
      + 'ref=<the MR source_branch> to read the file as the merge request sees it. Output is capped, and '
      + 'a truncated read says so.',
    input: {
      project: T.project,
      path: T.filePath,
      ref: T.ref.optional().describe('branch, tag or commit SHA; defaults to the project default branch'),
      maxChars: z.number().int().positive().max(1_000_000).default(100_000)
        .describe('cap on returned characters; the file itself may be longer'),
    },
    run: async ({ project, path, ref, maxChars }) => {
      const base = `/projects/${projectRef(project)}/repository/files/${fileRef(path)}/raw`;
      let target = ref;
      if (!target) {
        const info: any = await gitlab('GET', `/projects/${projectRef(project)}`);
        target = info?.default_branch ?? 'HEAD';
      }
      if (isDryRun()) {
        return { path, ref: target, size: 0, truncated: false, dryRun: true, url: resolveUrl(base, { ref: target }) };
      }
      const { text } = await gitlabText(base, { query: { ref: target } });
      const truncated = text.length > maxChars;
      return {
        path,
        ref: target,
        size: truncated ? maxChars : text.length,
        truncated,
        content: truncated ? text.slice(0, maxChars) : text,
      };
    },
  }),
};
