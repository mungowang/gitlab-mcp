# Plugin declarations (`tools.d/`)

Every `*.json` file **directly inside this directory** is loaded at startup and turned into
tools. That is the whole mechanism: extending coverage means adding JSON, not code.

`examples/` is **not** loaded (the loader only reads `*.json` in this directory, not
subdirectories). Copy a file out of it to enable it.

## Declaration reference

```jsonc
{
  "tools": {
    "gitlab_project_issues": {
      "desc": "List a project's issues",   // required
      "readOnly": true,          // optional; becomes the MCP readOnlyHint annotation
      "destructive": false,      // optional; becomes destructiveHint (use for deletes)
      "params": {                // required (may be empty); the tool's input schema
        "project": "project",    // value = a name from src/types.ts
        "state": "string",
        "perPage": "perPage"      // reuses the registry's description and bounds
      },
      "required": ["project"],        // optional; params that are not optional
      "returns": "anyPage",           // optional; an entity name from src/entity-types.ts
      "method": "GET",                // GET | POST | PUT | PATCH | DELETE
      "path": "/projects/{project}/issues",
      "query": {                      // optional
        "labels": "{labels}",         // "{x}" alone  -> the raw value, type preserved
        "per_page": "{perPage}"       // "a{x}b"      -> string interpolation, URL-escaped
      },
      "body": "{payload}"             // optional; same placeholder rules, deep for objects
    }
  }
}
```

## Path placeholders are encoded, query/body placeholders are not

A project path must reach the instance as **one encoded segment**: passing `group/app` to
`/projects/{project}/issues` produces `/projects/group%2Fapp/issues`, while passing `42`
produces `/projects/42/issues`. This is the single most common cause of a 404 against this
API, so the path is encoded for you. Query and body values keep their raw form, because
`{x}` there means "this typed value", not "this path segment".

## Return types

`returns` is the output-side mirror of `params`. When set, the tool gets an MCP `outputSchema`
and its result is also returned as `structuredContent`, so a JSON plugin is not second-class in
what the model can see.

Available names come from `src/entity-types.ts`:

```
pagination  project  branch  mergeRequest  discussion  user  note  position  fileSummary
projectPage  branchPage  mrPage  discussionPage  anyPage  changes  fileContent  version
reviewComment  rawResult  anyObject
```

Use **`anyPage`** for a list whose item shape is not worth pinning down, and **`anyObject`**
when the payload shape is unknown. MCP requires an object at the root of an output schema, so a
bare array can never be declared: wrap it in a page, or omit `returns`.

Omit `returns` entirely for an endpoint that can answer with an **empty body** (a `DELETE`, for
instance) - a declared output schema requires `structuredContent`, and an empty body violates it.

## Type names

`params` values come from the registry in `src/types.ts`. Available today:

```
project  iid  page  perPage  branch  ref  filePath  sha  labels  noteBody  line  side
mrState  mrScope  mrOrderBy  sort  stateEvent  search  httpMethod  restPath  query  body
string  number  boolean  object  array
```

Using a name that is not in that list fails at startup (it does not silently degrade to `any`).
To add one, extend `T` in `src/types.ts` - code and JSON share it. **No unions**: the registry
is also what the CLI derives its `--flags` from, and one name with two shapes has no sane flag
syntax.

## Validation performed at startup

The server refuses to start, naming the file and the offending key, when:

- `desc`, `method` or `path` is missing
- `method` is not one of the five verbs
- a `params` value is not a known type name
- a declared param is never referenced as `{name}` in `path`/`query`/`body`
- `required` lists something that is not in `params`
- the file itself is not valid JSON

## What cannot be expressed here

`text/plain` endpoints. This layer hands every response to `JSON.parse`, so a job trace or a raw
file cannot be declared as JSON - those need code (see `gitlab_file_get` in
`src/entities/repository.ts`, which uses `gitlabText`). Anything multi-step does too; see
`gitlab_mr_comment_on_line`, which reads a diff version before it writes.

## Precedence

JSON-declared tools are merged **after** the code-declared ones, so a JSON entry with the same
name overrides the built-in tool. That is deliberate: it lets a wrong or missing endpoint be
patched without touching code.
