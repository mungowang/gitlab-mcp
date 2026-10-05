import { gitlab, gitlabList } from '../gitlab.ts';
import { defineTool } from '../tool.ts';
import { T, projectRef, pageInput } from '../types.ts';
import { E } from '../entity-types.ts';

export const project = {
  gitlab_project_get: defineTool({
    readOnly: true, returns: E.project,
    desc: 'Get a project by id or path. Use it to turn a project name into the path the other tools '
      + 'take, and to read default_branch.',
    input: { project: T.project },
    run: ({ project }) => gitlab('GET', `/projects/${projectRef(project)}`),
  }),

  gitlab_project_search: defineTool({
    readOnly: true, returns: E.projectPage,
    desc: 'Search projects visible to this token by name. Use it when the exact project path is unknown.',
    input: { search: T.search, ...pageInput },
    run: ({ search, page, perPage }) =>
      gitlabList('GET', '/projects', { query: { search, page, per_page: perPage, order_by: 'last_activity_at' } }),
  }),

  gitlab_labels_list: defineTool({
    readOnly: true, returns: E.anyPage,
    desc: 'List a project\'s labels. Check here before setting labels: 11.3 creates an unknown label '
      + 'silently when the account may, and rejects it when the account may not.',
    input: { project: T.project, search: T.search.optional(), ...pageInput },
    run: ({ project, search, page, perPage }) =>
      gitlabList('GET', `/projects/${projectRef(project)}/labels`, { query: { search, page, per_page: perPage } }),
  }),

  gitlab_users_search: defineTool({
    readOnly: true, returns: E.anyPage,
    desc: 'Find users by name or username. Needed because 11.3 assigns and filters by numeric user id '
      + 'and never by username.',
    input: { search: T.search, ...pageInput },
    run: ({ search, page, perPage }) =>
      gitlabList('GET', '/users', { query: { search, page, per_page: perPage } }),
  }),
};
