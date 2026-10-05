import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, fixtures } from './mock-gitlab.mjs';
import { startServer, isReadOnly } from './harness.mjs';

const { TOKEN, HEAD_SHA, BASE_SHA, START_SHA } = fixtures;

let mock;
let server;

/** Where the request log stood - pass it to `since()` to assert on the calls a test caused. */
const mark = () => mock.log.length;
const since = (m) => mock.log.slice(m);
const last = () => mock.log[mock.log.length - 1];

before(async () => {
  mock = await startMock(18091);
  server = await startServer({ GITLAB_BASE_URL: mock.url, GITLAB_TOKEN: TOKEN });
});

after(async () => {
  server?.stop();
  mock?.server.close();
});

const ok = async (name, args) => {
  const res = await server.callTool(name, args);
  assert.equal(res.ok, true, `${name} failed: ${res.text}`);
  return res;
};

const json = async (name, args) => JSON.parse((await ok(name, args)).text);

test('the tool list covers the merge-request workflow and marks read-only tools', async () => {
  const tools = await server.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    'gitlab_whoami', 'gitlab_server_version', 'gitlab_raw_api',
    'gitlab_project_get', 'gitlab_project_search', 'gitlab_labels_list', 'gitlab_users_search',
    'gitlab_branches_list', 'gitlab_file_get',
    'gitlab_mr_list', 'gitlab_mr_get', 'gitlab_mr_changes', 'gitlab_mr_create', 'gitlab_mr_update',
    'gitlab_mr_comment', 'gitlab_mr_merge', 'gitlab_mr_pipelines', 'gitlab_mr_versions',
    'gitlab_mr_discussions', 'gitlab_mr_comment_on_line', 'gitlab_mr_reply', 'gitlab_mr_resolve',
    // from tools.d/ - proof the JSON layer is wired in
    'gitlab_project_issues', 'gitlab_pipeline_jobs', 'gitlab_group_projects',
  ]) {
    assert.ok(names.includes(expected), `${expected} is not registered`);
  }

  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const ro of ['gitlab_mr_get', 'gitlab_mr_changes', 'gitlab_whoami', 'gitlab_file_get']) {
    assert.equal(isReadOnly(byName[ro]), true, `${ro} should be read-only`);
  }
  for (const rw of ['gitlab_mr_create', 'gitlab_mr_merge', 'gitlab_mr_comment_on_line', 'gitlab_raw_api']) {
    assert.equal(isReadOnly(byName[rw]), false, `${rw} should not be read-only`);
  }
});

test('every tool declares an input schema and a description', async () => {
  for (const t of await server.listTools()) {
    assert.ok(t.description && t.description.length > 10, `${t.name} has no description`);
    assert.equal(typeof t.inputSchema, 'object', `${t.name} has no input schema`);
  }
});

test('whoami and version work and prove the token', async () => {
  assert.equal((await json('gitlab_whoami')).username, 'alice');
  assert.equal((await json('gitlab_server_version')).version, '11.3.0');
});

test('a project path is percent-encoded on the wire', async () => {
  const m = mark();
  const project = await json('gitlab_project_get', { project: 'group/app' });
  assert.equal(project.path_with_namespace, 'group/app');
  assert.match(last().url, /^\/api\/v4\/projects\/group%2Fapp$/);

  await ok('gitlab_project_get', { project: '42' });
  assert.match(last().url, /^\/api\/v4\/projects\/42$/);
  assert.equal(since(m).length, 2);
});

test('mr_list defaults to opened and reports pagination explicitly', async () => {
  const m = mark();
  const first = await json('gitlab_mr_list', { project: 'group/app' });
  assert.equal(first.items.length, 2);
  assert.equal(first.pagination.total, 2);
  assert.equal(first.pagination.nextPage, null);
  assert.match(since(m)[0].url, /state=opened/);

  const paged = await json('gitlab_mr_list', { project: 'group/app', perPage: 2 });
  assert.equal(paged.items.length, 2);
  assert.equal(paged.pagination.nextPage, 2, 'nextPage must be surfaced so the model knows to continue');
  assert.equal(paged.pagination.totalPages, 2);
  assert.equal(paged.items[1].work_in_progress, true, 'the WIP flag must survive to the model');
});

test('mr_list passes filters through and joins labels', async () => {
  const m = mark();
  await ok('gitlab_mr_list', { project: '42', labels: ['review', 'urgent'], assignee_id: 2, state: 'all' });
  const url = since(m)[0].url;
  assert.match(url, /labels=review%2Curgent/);
  assert.match(url, /assignee_id=2/);
  assert.match(url, /state=all/);
});

test('mr_changes summarises files, counts lines and caps the patch', async () => {
  const changes = await json('gitlab_mr_changes', { project: 'group/app', iid: 7 });
  assert.equal(changes.iid, 7);
  assert.equal(changes.sha, HEAD_SHA);
  assert.equal(changes.stats.files, 3);
  assert.equal(changes.stats.shown, 3);
  assert.equal(changes.stats.omittedFiles, 0);
  assert.equal(changes.stats.additions, 3); // 2 in src/app.ts + 1 in README.md
  const app = changes.files.find((f) => f.new_path === 'src/app.ts');
  assert.equal(app.additions, 2);
  assert.equal(app.hunks, 1);
  assert.equal(app.patchTruncated, false);
  const png = changes.files.find((f) => f.new_path === 'logo.png');
  assert.equal(png.hunks, 0, 'a binary file has no hunks');
});

test('mr_changes bounds the response with maxFiles and maxPatchChars', async () => {
  const few = await json('gitlab_mr_changes', { project: 'group/app', iid: 7, maxFiles: 1 });
  assert.equal(few.stats.files, 3);
  assert.equal(few.stats.shown, 1);
  assert.equal(few.stats.omittedFiles, 2);
  assert.equal(few.stats.additions, 2, 'counts describe the returned files only, and say so');

  const cut = await json('gitlab_mr_changes', { project: 'group/app', iid: 7, path: 'src/app.ts', maxPatchChars: 24 });
  assert.equal(cut.stats.files, 1);
  assert.equal(cut.files[0].patchTruncated, true);
  assert.equal(cut.files[0].additions, 2);
});

test('mr_changes with a wrong path names the files that do exist', async () => {
  const res = await server.callTool('gitlab_mr_changes', { project: 'group/app', iid: 7, path: 'src/nope.ts' });
  assert.equal(res.ok, false);
  assert.match(res.text, /no changed file at path 'src\/nope\.ts'/);
  assert.match(res.text, /src\/app\.ts/);
});

test('mr_discussions derives resolved and hides system notes by default', async () => {
  const page = await json('gitlab_mr_discussions', { project: 'group/app', iid: 7 });
  assert.equal(page.items.length, 2, 'the system-only thread is dropped');
  assert.equal(page.items[0].id, 'disc-1');
  assert.equal(page.items[0].resolved, false);
  assert.equal(page.items[1].resolved, true);
  assert.equal(page.pagination.total, null, 'raw counts are GitLab\'s, not this page\'s');

  const withSystem = await json('gitlab_mr_discussions', { project: 'group/app', iid: 7, includeSystem: true });
  assert.equal(withSystem.items.length, 3);

  const unresolved = await json('gitlab_mr_discussions', { project: 'group/app', iid: 7, onlyUnresolved: true });
  assert.equal(unresolved.items.length, 1);
  assert.equal(unresolved.items[0].id, 'disc-1');
});

test('long comment bodies are truncated with a marker rather than silently', async () => {
  const page = await json('gitlab_mr_discussions', { project: 'group/app', iid: 7, maxBodyChars: 10 });
  assert.match(page.items[0].notes[0].body, /^this branc\n… \[truncated: 26 characters total\]$/);
});

test('commenting on an added line needs no SHAs from the caller and no old_line', async () => {
  const m = mark();
  const result = await json('gitlab_mr_comment_on_line', {
    project: 'group/app', iid: 7, path: 'src/app.ts', line: 13, body: 'this branch is unreachable',
  });
  assert.match(result.discussion_id, /^disc-new-\d+$/);
  assert.equal(typeof result.note_id, 'number');
  // The *_commit_sha -> *_sha mapping happened on the SHAs the client fetched itself.
  assert.equal(result.position.base_sha, BASE_SHA);
  assert.equal(result.position.start_sha, START_SHA);
  assert.equal(result.position.head_sha, HEAD_SHA);
  assert.equal(result.position.new_line, 13);
  assert.equal(result.position.old_line, undefined, 'an added line has no old-side number');
  assert.equal(result.position.position_type, 'text');

  const calls = since(m);
  assert.match(calls[0].url, /\/merge_requests\/7\/versions$/);
  assert.match(calls[1].url, /\/versions\/110$/, 'the newest diff version must be the one used');
  assert.match(calls[2].url, /\/merge_requests\/7\/discussions$/);
  const sent = JSON.parse(calls[2].body);
  assert.equal(sent.position.new_line, 13);
  assert.equal(sent.position.base_sha, BASE_SHA);
  assert.equal(sent.body, 'this branch is unreachable');
});

test('commenting on a context line sends both line numbers', async () => {
  const result = await json('gitlab_mr_comment_on_line', {
    project: 'group/app', iid: 7, path: 'README.md', line: 3, body: 'nit',
  });
  assert.equal(result.position.old_line, 2);
  assert.equal(result.position.new_line, 3);
  assert.equal(result.position.new_path, 'README.md');
});

test('commenting on the old side is possible too', async () => {
  const result = await json('gitlab_mr_comment_on_line', {
    project: 'group/app', iid: 7, path: 'src/app.ts', line: 12, side: 'old', body: 'why was this removed?',
  });
  assert.equal(result.position.old_line, 12);
  assert.equal(result.position.new_line, 12);
});

test('a line that is not in the diff is refused locally, with the lines that work', async () => {
  const m = mark();
  const res = await server.callTool('gitlab_mr_comment_on_line', {
    project: 'group/app', iid: 7, path: 'src/app.ts', line: 99, body: 'x',
  });
  assert.equal(res.ok, false);
  assert.match(res.text, /commentable new-side lines: 10-18/);
  assert.equal(since(m).some((c) => c.method === 'POST'), false, 'nothing may be written when the position is wrong');
});

test('a line on the wrong side is refused with that side\'s ranges', async () => {
  const res = await server.callTool('gitlab_mr_comment_on_line', {
    project: 'group/app', iid: 7, path: 'src/app.ts', line: 17, side: 'old', body: 'x',
  });
  assert.equal(res.ok, false);
  assert.match(res.text, /commentable old-side lines: 10-16/);
});

test('reply and resolve target an existing thread', async () => {
  const m = mark();
  const reply = await json('gitlab_mr_reply', { project: 'group/app', iid: 7, discussion_id: 'disc-1', body: 'good catch, fixed' });
  assert.equal(typeof reply.note_id, 'number');
  assert.match(since(m)[0].url, /\/discussions\/disc-1\/notes$/);

  const resolved = await json('gitlab_mr_resolve', { project: 'group/app', iid: 7, discussion_id: 'disc-1' });
  assert.equal(resolved.resolved, true);
  assert.match(last().url, /resolved=true/);
});

test('an invalid position that reaches GitLab is explained, not just reported', async () => {
  // Bypasses the local check on purpose: this is the 400 the local logic exists to prevent,
  // and it must still be actionable if a diff version drifts under us.
  const res = await server.callTool('gitlab_raw_api', {
    method: 'POST',
    path: '/projects/42/merge_requests/7/discussions',
    body: { body: 'x', position: { base_sha: BASE_SHA, new_path: 'src/app.ts', new_line: 99 } },
  });
  assert.equal(res.ok, false);
  assert.match(res.text, /Note position is invalid/);
});

test('mr_create applies the 11.3 draft convention instead of a draft parameter', async () => {
  const m = mark();
  const created = await json('gitlab_mr_create', {
    project: 'group/app', source_branch: 'feature/x', target_branch: 'master',
    title: 'Add a thing', draft: true, labels: ['review'], description: 'body',
  });
  const sent = JSON.parse(since(m)[0].body);
  assert.equal(sent.title, 'WIP: Add a thing');
  assert.equal(created.work_in_progress, true);
  assert.equal(sent.labels, 'review');
  assert.equal(sent.source_branch, 'feature/x');
  assert.equal('assignee_id' in sent, false, 'unset fields must not be sent at all');
  assert.equal('draft' in sent, false, '11.3 would reject an unknown draft parameter');
});

test('mr_create does not double an existing WIP prefix', async () => {
  const m = mark();
  await ok('gitlab_mr_create', {
    project: 'group/app', source_branch: 'feature/y', target_branch: 'master', title: 'WIP: already', draft: true,
  });
  assert.equal(JSON.parse(since(m)[0].body).title, 'WIP: already');
});

test('a 409 for an existing merge request points at the fix', async () => {
  const res = await server.callTool('gitlab_mr_create', {
    project: 'group/app', source_branch: 'dup', target_branch: 'master', title: 'again',
  });
  assert.equal(res.ok, false);
  assert.match(res.text, /already open merge request already exists|already exists/);
  assert.match(res.text, /gitlab_mr_update/);
});

test('a nested validation error body is flattened into readable text', async () => {
  const res = await server.callTool('gitlab_mr_create', {
    project: 'group/app', source_branch: 'same', target_branch: 'same', title: 'x',
  });
  assert.equal(res.ok, false);
  assert.match(res.text, /source_branch: can't be the same as target_branch/);
});

test('mr_update reads the current title before clearing the WIP prefix', async () => {
  const m = mark();
  const updated = await json('gitlab_mr_update', { project: 'group/app', iid: 8, draft: false });
  const calls = since(m);
  assert.equal(calls.length, 2, 'one read to learn the title, one write');
  assert.equal(calls[0].method, 'GET');
  assert.equal(JSON.parse(calls[1].body).title, 'second');
  assert.equal(updated.work_in_progress, false);
});

test('mr_update sends an empty label list as an explicit clear', async () => {
  const m = mark();
  await ok('gitlab_mr_update', { project: 'group/app', iid: 7, labels: [] });
  const sent = JSON.parse(since(m)[0].body);
  assert.equal(sent.labels, '');
  assert.equal('title' in sent, false);
});

test('mr_comment posts on the merge request itself', async () => {
  const note = await json('gitlab_mr_comment', { project: 'group/app', iid: 7, body: 'lgtm' });
  assert.equal(note.id, 31);
});

test('merge failures are translated into what to check next', async () => {
  const conflicts = await server.callTool('gitlab_mr_merge', { project: 'group/app', iid: 8 });
  assert.equal(conflicts.ok, false);
  assert.match(conflicts.text, /not mergeable right now/);
  assert.match(conflicts.text, /merge_status/);

  const stale = await server.callTool('gitlab_mr_merge', { project: 'group/app', iid: 7, sha: 'deadbeef' });
  assert.equal(stale.ok, false);
  assert.match(stale.text, /conflict/);

  const merged = await json('gitlab_mr_merge', { project: 'group/app', iid: 7, sha: HEAD_SHA });
  assert.equal(merged.state, 'merged');
});

test('mr_pipelines shows what the merge gate is waiting on', async () => {
  const page = await json('gitlab_mr_pipelines', { project: 'group/app', iid: 7 });
  assert.equal(page.items[0].status, 'success');
  assert.equal(page.items[0].id, 900);
});

test('file_get defaults the ref to the default branch and returns the content', async () => {
  const m = mark();
  const file = await json('gitlab_file_get', { project: 'group/app', path: 'src/app.ts' });
  const calls = since(m);
  assert.match(calls[0].url, /^\/api\/v4\/projects\/group%2Fapp$/);
  assert.match(calls[1].url, /repository\/files\/src%2Fapp\.ts\/raw\?ref=master$/);
  assert.match(file.content, /guard\(\);/);
  assert.equal(file.truncated, false);
});

test('file_get honours an explicit ref and reports truncation', async () => {
  const file = await json('gitlab_file_get', { project: 'group/app', path: 'src/app.ts', ref: 'feature/login', maxChars: 12 });
  assert.equal(file.ref, 'feature/login');
  assert.equal(file.truncated, true);
  assert.equal(file.content.length, 12);
});

test('raw_api reaches endpoints with no dedicated tool and reports the 404 remedy', async () => {
  const version = await json('gitlab_raw_api', { method: 'GET', path: '/version' });
  assert.equal(version.body.version, '11.3.0');

  const missing = await server.callTool('gitlab_raw_api', { method: 'GET', path: '/does/not/exist' });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /404/);
  assert.match(missing.text, /percent-encoded/);
});

test('the JSON-declared plugin tools encode the project path and pass query parameters', async () => {
  const m = mark();
  const issues = await json('gitlab_project_issues', { project: 'group/app', state: 'opened', perPage: 5 });
  assert.equal(issues.items[0].iid, 3);
  const url = since(m)[0].url;
  assert.match(url, /^\/api\/v4\/projects\/group%2Fapp\/issues\?/);
  assert.match(url, /state=opened/);
  assert.match(url, /per_page=5/);

  const jobs = await json('gitlab_pipeline_jobs', { project: '42', pipelineId: 900 });
  assert.equal(jobs.items[0].name, 'test');
});

test('a misconfigured server warns at startup but still serves the tools', async () => {
  const bare = await startServer({ GITLAB_BASE_URL: '', GITLAB_TOKEN: '' });
  try {
    const stderr = bare.stderr();
    assert.match(stderr, /WARN GITLAB_BASE_URL is empty/);
    assert.match(stderr, /WARN GITLAB_TOKEN is empty/);
    assert.ok((await bare.listTools()).length > 20);
    const res = await bare.callTool('gitlab_whoami');
    assert.equal(res.ok, false);
    assert.match(res.text, /GITLAB_BASE_URL is empty/);
  } finally {
    bare.stop();
  }
});

test('GITLAB_READ_ONLY unregisters the write tools', async () => {
  const ro = await startServer({ GITLAB_BASE_URL: mock.url, GITLAB_TOKEN: TOKEN, GITLAB_READ_ONLY: 'true' });
  try {
    const names = (await ro.listTools()).map((t) => t.name);
    assert.ok(names.includes('gitlab_mr_get'));
    assert.equal(names.includes('gitlab_mr_create'), false);
    assert.equal(names.includes('gitlab_mr_comment_on_line'), false);
    assert.equal(names.includes('gitlab_raw_api'), false, 'the escape hatch can write, so it is a write tool');
    assert.match(ro.stderr(), /READ-ONLY/);
  } finally {
    ro.stop();
  }
});
