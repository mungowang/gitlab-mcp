# Changelog

## 1.0.0

First version, targeting GitLab CE 11.3.0.

- MCP server over stdio (`bin/gitlab-server.mjs`) and a CLI (`bin/gitlab.mjs`) sharing one tool
  registry, so a tool and its subcommand are always added together.
- Merge-request workflow: list, get, diff summary, create, update, comment, merge, pipelines.
- Diff review: `gitlab_mr_comment_on_line` resolves the diff-version SHAs and both line numbers
  itself, and refuses a line that is not in the diff by naming the lines that are.
  `gitlab_mr_discussions`, `gitlab_mr_reply`, `gitlab_mr_resolve`.
- 11.3 translations: `draft` ⇄ the `WIP: ` title prefix, `squash` on create/update rather than on
  merge, and error messages for the versions of this API that reject newer field names.
- `tools.d/` JSON declarations for endpoints that need no logic (issues, members, pipelines, jobs,
  commits, tags, group projects).
- Offline test suite (`npm test`) against a mock 11.3 instance, plus `npm run verify:live` for the
  assumptions only a real instance can confirm.
