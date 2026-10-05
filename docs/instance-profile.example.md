# Instance profile (example)

Copy this file to `instance-profile.md` and fill it in. That name is gitignored: it holds
**instance data**, which does not belong in the repository, while this example holds only the
shape of it.

Why bother: almost every "wrong" answer this tool could give is really a question about the
instance - which project path, which numeric user id, which labels actually exist. Writing the
answers down once keeps them out of prompts.

## Instance

- Base URL:
- Version (`gitlab_server_version`):
- Reachability: VPN required? which one?
- TLS: plain HTTP or self-signed?

## Credential

- Token owner (account, not a person's own account):
- Scope: `api` (the only usable scope on 11.3 - `read_api` does not exist)
- Where the token is stored:
- Expiry / rotation plan:

## Projects usually worked on

| Path | Default branch | Notes |
| --- | --- | --- |
|  |  |  |

## People (numeric ids, for `assignee_id`)

| Name | Username | id |
| --- | --- | --- |
|  |  |  |

`gitlab_users_search` gives these; §11.3 never accepts a username where an id is expected.

## Labels in use

- Review-related:
- Priority-related:

## Conventions

- Branch naming:
- Target branch for most changes:
- Draft convention: `WIP: ` prefix (11.3 has no draft parameter)
- How review state is recorded: diff comments resolved on this instance (there is no approve API
  on CE 11.3)
- Anything the merge bot/CI requires before `gitlab_mr_merge` will succeed:
