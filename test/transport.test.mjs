import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseUrlProblem, tokenProblem, resolveUrl, explain, gitlabMessage, compact, clampPerPage,
} from '../src/gitlab.ts';

test('baseUrlProblem catches the ways a base URL is wrong', () => {
  assert.match(baseUrlProblem(''), /is empty/);
  assert.match(baseUrlProblem(undefined), /is empty/);
  assert.match(baseUrlProblem('http://gitlab.example.com/api/v4'), /drop the trailing \/api\/v4/);
  assert.match(baseUrlProblem('gitlab.example.com'), /must be an absolute URL/);
  assert.match(baseUrlProblem('${env:GITLAB_BASE_URL}'), /unresolved \$\{\.\.\.\} placeholder/);
  assert.equal(baseUrlProblem('http://gitlab.example.com'), null);
  assert.equal(baseUrlProblem('https://gitlab.example.com/'), null);
});

test('baseUrlProblem never echoes the value it was given', () => {
  // A host that injects the base from a secret store masks it; quoting it would be noise.
  const problem = baseUrlProblem('http://user:secret@gitlab.example.com/api/v4') ?? '';
  assert.equal(problem.includes('secret'), false);
});

test('tokenProblem explains the 11.3 scope situation', () => {
  assert.match(tokenProblem(''), /`api`/);
  assert.match(tokenProblem(''), /read_api/);
  assert.match(tokenProblem('${credential:GITLAB_TOKEN}'), /unresolved/);
  assert.equal(tokenProblem('glpat-abc'), null);
});

test('resolveUrl builds v4 paths and passes through explicit ones', () => {
  assert.match(resolveUrl('/projects/42'), /\/api\/v4\/projects\/42$/);
  assert.match(resolveUrl('projects/42'), /\/api\/v4\/projects\/42$/);
  assert.match(resolveUrl('/api/v4/projects/42'), /\/api\/v4\/projects\/42$/);
  assert.equal(resolveUrl('http://other.example.com/x'), 'http://other.example.com/x');
});

test('resolveUrl serialises query values and drops empty ones', () => {
  const url = resolveUrl('/x', { a: 'b c', n: 1, flag: true, skip: undefined, empty: '', list: ['x', 'y'] });
  assert.match(url, /a=b%20c/);
  assert.match(url, /n=1/);
  assert.match(url, /flag=true/);
  assert.equal(url.includes('skip'), false);
  assert.equal(url.includes('empty'), false);
  assert.match(url, /list=x&list=y/);
});

test('gitlabMessage flattens the three shapes GitLab uses', () => {
  assert.equal(gitlabMessage('{"message":"404 Project Not Found"}'), '404 Project Not Found');
  assert.equal(gitlabMessage('{"message":["a","b"]}'), 'a; b');
  assert.equal(gitlabMessage('{"message":{"source_branch":["can\'t be the same as target_branch"]}}'), "source_branch: can't be the same as target_branch");
  assert.equal(gitlabMessage('{"error":"invalid_token"}'), 'invalid_token');
  assert.equal(gitlabMessage('not json at all'), 'not json at all');
});

test('explain turns a 404 into the reason a 404 is so often wrong here', () => {
  const message = explain(404, '{"message":"404 Project Not Found"}', 'GET', '/projects/group%2Fapp');
  assert.match(message, /GitLab GET \/projects\/group%2Fapp -> 404/);
  assert.match(message, /answers 404 - not 403/);
  assert.match(message, /percent-encoded/);
  // A 404 is ambiguous between "wrong path" and "no access"; the message must say how to split them.
  assert.match(message, /gitlab_project_search/);
  // And it must name the trap that actually caused one: display name vs username.
  assert.match(message, /username, not their display name/);
});

test('explain covers the merge failures the model will actually hit', () => {
  const notMergeable = explain(405, '{"message":["Branch cannot be merged"]}', 'PUT', '/merge');
  assert.match(notMergeable, /not mergeable right now/);
  assert.match(notMergeable, /merge_status/);

  const already = explain(406, '{"message":["Method Not Allowed"]}', 'PUT', '/merge');
  assert.match(already, /already[\s\S]*merged/);

  const stale = explain(409, '{"message":["SHA mismatch"]}', 'PUT', '/merge');
  assert.match(stale, /source\s+branch head moved|already exists/);
});

test('explain names the position error and its remedy', () => {
  const message = explain(400, '{"message":"Note position is invalid"}', 'POST', '/discussions');
  assert.match(message, /diff note position is invalid/);
  assert.match(message, /gitlab_mr_changes/);
});

test('explain rejects the new-version field names that do not exist on 11.3', () => {
  const message = explain(400, '{"message":{"reviewer_ids":["is invalid"]}}', 'POST', '/merge_requests');
  assert.match(message, /newer parameters \(draft, reviewer_ids, approval rules\) do not exist/);
});

test('explain reports the 401 scope trap rather than a bare status code', () => {
  const message = explain(401, '{"message":"401 Unauthorized"}', 'GET', '/user');
  assert.match(message, /'api' scope/);
  assert.match(message, /12\.10/);
});

test('compact drops undefined keys only', () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: null, d: '', e: false }), { a: 1, c: null, d: '', e: false });
});

test('clampPerPage bounds the page size GitLab accepts', () => {
  assert.equal(clampPerPage(undefined), 50);
  assert.equal(clampPerPage(0), 50);
  assert.equal(clampPerPage('10'), 10);
  assert.equal(clampPerPage(5000), 100);
});
