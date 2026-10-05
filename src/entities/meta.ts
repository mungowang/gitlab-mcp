import { gitlab } from '../gitlab.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';

/** Path normalisation shared by every tool: a leading slash is optional. */
export const apiPath = (path: string): string => (path.startsWith('/') ? path : '/' + path);

export const meta = {
  gitlab_whoami: defineTool({
    readOnly: true, returns: E.user,
    desc: 'Get the authenticated user. Call this first: it is the cheapest way to prove the token and '
      + 'base URL work before any write.',
    input: {},
    run: () => gitlab('GET', '/user'),
  }),

  gitlab_server_version: defineTool({
    readOnly: true, returns: E.anyObject,
    desc: 'Get the GitLab version answering this token (GET /version). Confirms which version the '
      + 'instance is on, which matters because most public documentation describes newer releases.',
    input: {},
    run: () => gitlab('GET', '/version'),
  }),

  gitlab_raw_api: defineTool({
    returns: E.rawResult,
    desc: 'Call any API v4 endpoint directly - the escape hatch for endpoints with no dedicated tool '
      + '(issues, labels, pipelines, snippets, members). Prefer a dedicated tool when one exists: this '
      + 'one does no validation, so a wrong path or field is exactly what the instance receives.',
    input: {
      method: T.httpMethod,
      path: T.restPath,
      query: T.query.optional(),
      body: T.body.optional(),
    },
    run: async ({ method, path, query, body }) => {
      const full = apiPath(path);
      const result = await gitlab(method, full, { query, body });
      return { method, path: full, body: result ?? null };
    },
  }),
};
