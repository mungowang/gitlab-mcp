# @mohou/gitlab-mcp

An MCP server **and** a CLI for a self-hosted **GitLab CE 11.3.0** instance, built around the
merge-request workflow: create, read the diff, comment on a line, reply, resolve, merge.

Two front ends, one core. The CLI has no tool list of its own - its subcommands and flags are
derived from the same Zod schemas the MCP tools declare, so the two cannot drift.

## Why this exists instead of `glab` or an existing MCP server

GitLab 11.3.0 was released in September 2018. Every maintained tool has moved on:

| Tool | Why it does not work here |
| --- | --- |
| `glab` (official CLI) | Officially supports GitLab **16.0+**; 15.x and earlier are explicitly unsupported |
| GitLab's official MCP server | Requires GitLab **18.3+** (`/api/v4/mcp` and OAuth dynamic client registration) |
| Community GitLab MCP servers | Written against the current API and GraphQL; against 11.3 they 404 or silently misbehave |

The REST API **v4** does exist on 11.3 and is complete enough for review work. What it lacks is
everything newer, and this client is written against the 11.3 API documentation rather than
against today's docs - see [What 11.3 does not have](#what-113-does-not-have).

## Requirements

- Node.js **22.6+** (the sources are TypeScript, run directly by Node's type stripping - there is
  no build step)
- A GitLab personal access token with the **`api`** scope

## Install

```bash
# as a dependency of something else
npm install @mohou/gitlab-mcp

# the MCP client launches the server through npx, so nothing must be installed first:
npx -y @mohou/gitlab-mcp

# the CLI, without installing anything globally:
npx -y --package @mohou/gitlab-mcp mohou-gitlab tools
```

The package ships two binaries: **`gitlab-mcp`** (the MCP server, named to match the package so
that `npx @mohou/gitlab-mcp` finds it) and **`mohou-gitlab`** (the CLI).

From a source checkout - there is no build step, Node runs the TypeScript directly:

```bash
cd gitlab-mcp
npm install
npm test          # 89 offline tests against a mock GitLab 11.3
```

## Configure

| Variable | Meaning |
| --- | --- |
| `GITLAB_BASE_URL` | instance root, e.g. `http://gitlab.example.com` (not `/api/v4`) |
| `GITLAB_TOKEN` | personal access token, sent as the `PRIVATE-TOKEN` header |
| `GITLAB_READ_ONLY` | `true` registers only read-only tools, and the CLI refuses write subcommands |
| `GITLAB_TIMEOUT_MS` | request timeout, default `30000` |
| `GITLAB_MAX_RETRIES` | retries for 429/502/503/504, default `2` |
| `GITLAB_TLS_REJECT_UNAUTHORIZED` | `false` for a self-signed certificate |

The token must be treated as a **write** credential: `read_api` does not exist before GitLab
12.10, so `api` is the narrowest scope that can read the API at all. Use a dedicated account,
not a personal one.

### Registering the MCP server

Any MCP client works; the server speaks stdio.

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@mohou/gitlab-mcp"],
      "env": {
        "GITLAB_BASE_URL": "http://gitlab.example.com",
        "GITLAB_TOKEN": "glpat-xxxxxxxxxxxx"
      }
    }
  }
}
```

From a source checkout, point `command` at `node` and `args` at the absolute path to
`bin/gitlab-server.mjs` instead.

In this harness (`dsh`), register it with the mini-app MCP tool instead of editing a file:

```
mini_app_mcp_add id=gitlab command=node args=["/path/gitlab-mcp/bin/gitlab-server.mjs"] env={GITLAB_BASE_URL:..., GITLAB_TOKEN:...}
```

Two things to know about that path:

- `${credential:NAME}` / `${env:NAME}` placeholders are resolved for the one-off check but **not**
  for the live MCP client until the host restarts. Pass literal values, or register the row and
  restart once, then verify with `mini_app_mcp_list`.
- The harness reaches the host over VPN. If the VPN is down, the first call fails with
  `network error: fetch failed - is the VPN connected and the host reachable?`.

## CLI

```bash
export GITLAB_BASE_URL=http://gitlab.example.com
export GITLAB_TOKEN=glpat-xxxx

# installed: `mohou-gitlab ...`   |   without installing: `npx -y --package @mohou/gitlab-mcp mohou-gitlab ...`
node bin/gitlab.mjs tools                       # every tool, read-only ones marked
node bin/gitlab.mjs describe mr_comment_on_line # purpose and flags
node bin/gitlab.mjs whoami                      # proves base URL + token
node bin/gitlab.mjs mr_list --project group/app --state opened --per-page 10
node bin/gitlab.mjs mr_changes --project group/app --iid 12 --max-patch-chars 2000
node bin/gitlab.mjs mr_comment_on_line --project group/app --iid 12 \
    --path src/app.ts --line 42 --body "this branch is unreachable"
node bin/gitlab.mjs raw_api --method GET --path /projects/group%2Fapp/merge_requests
```

- Tool names may be given in full or without the `gitlab_` prefix (`mr_list` = `gitlab_mr_list`).
- Flags are dashed and accept the schema spelling too: `--source-branch` and `--source_branch` are
  the same flag. `--no-include-system` sets a boolean false.
- Output is JSON on stdout, diagnostics on stderr. Exit codes: `0` ok, `1` the call failed,
  `2` bad usage.
- `--host`, `--token`, `--token-file` override the environment for one call (the token is removed
  from `argv`, so it does not appear in `ps`); `--dry-run` prints the request instead of sending it.

## A review, end to end

```
gitlab_mr_list      {project, state:"opened"}                  # which MR
gitlab_mr_get       {project, iid}                             # state, merge_status, work_in_progress
gitlab_mr_changes   {project, iid, maxPatchChars:4000}          # files, counts, capped patches
gitlab_mr_discussions {project, iid, onlyUnresolved:true}       # what is still open
gitlab_mr_comment_on_line {project, iid, path, line, side, body}
gitlab_mr_reply     {project, iid, discussion_id, body}
gitlab_mr_resolve   {project, iid, discussion_id}
gitlab_mr_pipelines {project, iid}                             # the merge gate
gitlab_mr_merge     {project, iid, sha}                        # sha pins the source HEAD
```

`gitlab_mr_comment_on_line` is the tool that earns its keep. GitLab does not accept "file +
line": a diff note needs the merge request's base/start/head SHAs **and** the old-side line
number. This tool reads the newest diff version, reconstructs the hunk numbering, fills both line
numbers in, and refuses locally when the line is not in the diff - naming the ranges that would
have worked:

```
cannot place a comment at src/app.ts:99 (new side). src/app.ts: no commentable new-side line 99
(commentable new-side lines: 10-18). Lines that exist in the diff can be commented on;
use gitlab_mr_changes to see the diff.
```

## Tools

Core tools (code, `src/entities/`):

| Tool | R/W | Purpose |
| --- | --- | --- |
| `gitlab_whoami` | ro | the authenticated user - the cheapest way to prove the token |
| `gitlab_server_version` | ro | which GitLab version is answering |
| `gitlab_project_get` / `gitlab_project_search` | ro | resolve a project path or id |
| `gitlab_labels_list` / `gitlab_users_search` | ro | label names, and the numeric user ids this API takes |
| `gitlab_branches_list` / `gitlab_file_get` | ro | branches; one file at a ref, capped |
| `gitlab_mr_list` / `gitlab_mr_get` | ro | find and read merge requests |
| `gitlab_mr_changes` | ro | per-file diff summary with capped patches |
| `gitlab_mr_discussions` | ro | threads, with each diff comment's file and line |
| `gitlab_mr_pipelines` / `gitlab_mr_versions` | ro | the merge gate; diff versions (debugging) |
| `gitlab_mr_create` / `gitlab_mr_update` | rw | create and edit, including the draft translation |
| `gitlab_mr_comment` | rw | a comment on the merge request itself |
| `gitlab_mr_comment_on_line` | rw | a diff comment on one line |
| `gitlab_mr_reply` / `gitlab_mr_resolve` | rw | continue a thread; resolve it |
| `gitlab_mr_merge` | rw | merge, with the failure modes explained |
| `gitlab_raw_api` | rw | any endpoint - the escape hatch |

Declared extras (`tools.d/gitlab-extras.json`, read-only, no code): issues, members, project
pipelines, pipeline jobs, commits, tags, group projects. See
[`tools.d/README.md`](tools.d/README.md) for the declaration DSL and how to add more.

`npm run tools:describe -- <filter>` prints the contract as the model sees it, asked of the
server itself over stdio.

## What 11.3 does not have

Every entry here is a trap a tool written against current documentation would fall into.

| Missing | Consequence here |
| --- | --- |
| **Merge request approvals API** | There is no approve endpoint on CE 11.3 (`doc/api/merge_request_approvals.md` does not exist in the 11.3 tree). Review state is carried by diff comments and by resolving threads. |
| **`reviewers` attribute** | Assignment is the only way to route a merge request; `gitlab_mr_list` has no reviewer filter. |
| **`draft` parameter** | A draft merge request is one whose **title starts with `WIP: `**, reported back as `work_in_progress: true`. `gitlab_mr_create`/`gitlab_mr_update` take `draft` and translate it. |
| **`read_api` scope** | Tokens are all-or-nothing write credentials. |
| **Global code search** | `/search` has no `blobs` scope at the top level; code search is per project. |
| **Keyset pagination** | Offset pagination only; every list tool reports `pagination.nextPage`. |
| **`squash` on merge** | Squash is set on the merge request when it is created or updated, not at merge time. |
| **`rules`/`workflow`/`needs` in CI** | 12.x features. CI config for this instance must use `only`/`except`. |
| **`/projects/:id/users`** (unverified) | Not used here; user lookup goes through the global `/users` endpoint. |
| **GraphQL** | Experimental at best on 11.0+; this client is REST v4 only. |

Two error messages exist purely because of this table: a `400` mentioning `reviewer_ids`,
`draft` or approval rules, and a `401` explaining the scope situation.

## Reading the right documentation

Do not read today's API docs when changing this code. Read the version-matched ones from the
source tag that produced the instance:

```
https://gitlab.com/gitlab-org/gitlab-foss/-/raw/v11.3.0/doc/api/merge_requests.md
https://gitlab.com/gitlab-org/gitlab-foss/-/raw/v11.3.0/doc/api/discussions.md
```

That is where the parameters in this client were checked, including the detail that a diff
version reports `head_commit_sha` / `base_commit_sha` / `start_commit_sha` while a comment
position wants `head_sha` / `base_sha` / `start_sha`.

## Verification

`npm test` runs against `test/mock-gitlab.mjs`, which is faithful to the 11.3 **shapes** (the
`*_commit_sha` naming, hunk numbering, the 405/406/409 merge failures, nested validation errors)
rather than to GitLab's behaviour. It cannot tell you that the real instance accepts a nested
`position` object, because it was written from the same reading of the docs.

For that, run the live check once the VPN is up:

```bash
GITLAB_BASE_URL=http://gitlab.example.com GITLAB_TOKEN=... \
  npm run verify:live -- --project <group/app> --iid <mr>          # read-only
GITLAB_BASE_URL=... GITLAB_TOKEN=... \
  npm run verify:live -- --project <group/app> --iid <mr> --write  # + create/delete a diff note
```

It reports PASS/FAIL/SKIP per assumption and exits non-zero on any failure. In `--write` mode the
only mutation is one probe comment, which it deletes again.

## Extending

- **A new endpoint with no logic** - add a declaration to `tools.d/*.json`. No code, no restart of
  anything but the server.
- **A new endpoint with logic, or a non-JSON response** - add a tool in `src/entities/`. Text
  endpoints (job traces, raw files) cannot be expressed in the JSON layer, because that layer
  parses every response as JSON.
- Both front ends pick it up automatically: the MCP tool and the CLI subcommand appear together.

Layout: `src/gitlab.ts` (transport, pagination, error translation) - `src/diff.ts` (unified diff →
position) - `src/entities/` (tools) - `src/jsonTools.ts` (the declaration DSL) - `src/cli.ts` +
`src/args.ts` (CLI) - `src/index.ts` (MCP server).

## Maintainer: publishing

Prerequisites, in order:

1. **Node 22.6+** locally, and `npm test` green (`prepublishOnly` enforces it).
2. **`npm login`** (or `NPM_TOKEN` in the environment) for the account that may publish.
3. **The `@mohou` scope must exist and you must be able to publish to it.** A scoped name is not
   optional: npm rejects `mohou/gitlab-mcp`, so the package is `@mohou/gitlab-mcp`. If `@mohou` is
   not yet an npm organization, create it on npmjs.com and add yourself as an owner - or, for an
   internal registry, map the scope instead:
   ```ini
   # .npmrc (safe to commit - no token in it)
   @mohou:registry=https://your-internal-registry/
   ```
   That `.npmrc` also decides where `npm publish` goes, so set it before publishing.
4. **`publishConfig.access = "public"`** is already set in `package.json`; without it a scoped
   package publishes as restricted and fails on a free plan.

Then:

```bash
npm test                      # 89 offline tests
npm run pack:check            # the file list that would ship - verify tools.d/ is in it
npm version patch             # or minor/major; updates package.json + git tag
npm publish                   # prepublishOnly re-runs the tests
```

Notes specific to this package:

- **`tools.d/` must ship.** The server loads `tools.d/*.json` at startup from the package root;
  if that directory were ever dropped from `files`, every JSON-declared tool would disappear and
  startup would fail. `npm run pack:check` is the guard.
- **The shipped code is TypeScript, run by Node's type stripping.** That is why `engines` requires
  Node 22.6+ and why there is no build output. Do not "fix" this by adding a build step without
  also changing `bin/*.mjs` and the `files` list.
- **No provenance attestation.** `npm publish --provenance` needs a public source repository on a
  supported CI provider; this repository is self-hosted, so provenance is not available.
- `prepublishOnly` runs the offline suite only. The live checks
  (`npm run verify:live`) need VPN access and a token, so they are not part of publishing.
