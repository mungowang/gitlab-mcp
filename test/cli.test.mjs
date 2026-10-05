import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-gitlab.mjs';
import { runCli } from './harness.mjs';

let mock;
let env;

before(async () => {
  mock = await startMock(18092);
  env = { GITLAB_BASE_URL: mock.url, GITLAB_TOKEN: 'test-token' };
});

after(() => mock?.server.close());

const parse = (out) => JSON.parse(out);

test('no arguments prints usage and the tool list', async () => {
  const { code, stdout } = await runCli([], env);
  assert.equal(code, 0);
  assert.match(stdout, /Usage/);
  assert.match(stdout, /mr_comment_on_line/);
});

test('tools lists names with a read-only marker', async () => {
  const { code, stdout } = await runCli(['tools'], env);
  assert.equal(code, 0);
  assert.match(stdout, /ro\s+gitlab_mr_get/);
  assert.match(stdout, /^\s+gitlab_mr_create/m);
});

test('tools --json emits flags, including enum values', async () => {
  const { code, stdout } = await runCli(['tools', '--json'], env);
  assert.equal(code, 0);
  const tools = parse(stdout);
  const merge = tools.gitlab_mr_merge;
  assert.equal(merge.readOnly, false);
  assert.ok(merge.flags.some((f) => f.name === 'merge_when_pipeline_succeeds' && f.kind === 'boolean'));
  const list = tools.gitlab_mr_list.flags.find((f) => f.name === 'state');
  assert.equal(list.kind, 'enum');
  assert.deepEqual(list.enumValues, ['opened', 'closed', 'locked', 'merged', 'all']);
  assert.equal(list.required, false, 'state has a default, so it is not required');
});

test('describe shows a tool\'s purpose and its flags', async () => {
  const { code, stdout } = await runCli(['describe', 'mr_merge'], env);
  assert.equal(code, 0);
  assert.match(stdout, /gitlab_mr_merge/);
  assert.match(stdout, /--merge-when-pipeline-succeeds/);
  assert.match(stdout, /--sha/);
});

test('both the dashed and the schema spelling of a flag are accepted', async () => {
  const dashed = await runCli(['mr_create', '--project', 'group/app', '--source-branch', 'a', '--target-branch', 'b', '--title', 'T', '--dry-run'], env);
  assert.equal(dashed.code, 0);
  assert.equal(parse(dashed.stdout).body.source_branch, 'a');

  const schema = await runCli(['mr_create', '--project', 'group/app', '--source_branch', 'a', '--target_branch', 'b', '--title', 'T', '--dry-run'], env);
  assert.equal(schema.code, 0);
  assert.equal(parse(schema.stdout).body.source_branch, 'a');
});

test('a tool runs by its short name and prints JSON', async () => {
  const { code, stdout } = await runCli(['whoami'], env);
  assert.equal(code, 0);
  assert.equal(parse(stdout).username, 'alice');
});

test('--project is filtered through the zod schema, not just the flag parser', async () => {
  const { code, stdout } = await runCli(['mr_list', '--project', 'group/app', '--per-page', '2'], env);
  assert.equal(code, 0);
  assert.equal(parse(stdout).pagination.nextPage, 2);
});

test('the explicit call form behaves identically', async () => {
  const { code, stdout } = await runCli(['call', 'mr_get', '--project', '42', '--iid', '7'], env);
  assert.equal(code, 0);
  assert.equal(parse(stdout).title, 'Add login guard');
});

test('flags fill in the whole review path, defaults included', async () => {
  const { code, stdout } = await runCli([
    'mr_comment_on_line', '--project', 'group/app', '--iid', '7',
    '--path', 'src/app.ts', '--line', '13', '--body', 'this branch is unreachable',
  ], env);
  assert.equal(code, 0);
  const result = parse(stdout);
  assert.match(result.discussion_id, /^disc-new-\d+$/);
  assert.equal(result.position.new_line, 13);
  assert.equal(result.position.position_type, 'text');
});

test('comma-separated list flags become arrays', async () => {
  const m = mock.log.length;
  const { code } = await runCli(['mr_list', '--project', 'group/app', '--labels', 'review,urgent'], env);
  assert.equal(code, 0);
  assert.match(mock.log[m].url, /labels=review%2Curgent/);
});

test('a wrong line number fails with the lines that would work', async () => {
  const { code, stderr } = await runCli([
    'mr_comment_on_line', '--project', 'group/app', '--iid', '7',
    '--path', 'src/app.ts', '--line', '99', '--body', 'x',
  ], env);
  assert.equal(code, 1);
  assert.match(stderr, /commentable new-side lines: 10-18/);
});

test('unknown tools and flags exit 2 with a usable message', async () => {
  const unknownTool = await runCli(['mr_destroy'], env);
  assert.equal(unknownTool.code, 2);
  assert.match(unknownTool.stderr, /unknown tool 'mr_destroy'/);

  const unknownFlag = await runCli(['mr_list', '--project', 'group/app', '--sttae', 'opened'], env);
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.stderr, /unknown flag --sttae/);
  assert.match(unknownFlag.stderr, /did you mean --state/);
});

test('missing required flags, bad enums, bad numbers and repeated flags are all caught', async () => {
  const missing = await runCli(['mr_get', '--iid', '7'], env);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--project is required/);

  const badEnum = await runCli(['mr_list', '--project', 'group/app', '--state', 'nope'], env);
  assert.equal(badEnum.code, 2);
  assert.match(badEnum.stderr, /must be one of opened \| closed \| locked \| merged \| all/);

  const badNumber = await runCli(['mr_get', '--project', 'group/app', '--iid', 'seven'], env);
  assert.equal(badNumber.code, 2);
  assert.match(badNumber.stderr, /--iid expects a number/);

  const twice = await runCli(['mr_get', '--project', 'a', '--project', 'b', '--iid', '7'], env);
  assert.equal(twice.code, 2);
  assert.match(twice.stderr, /--project was given more than once/);
});

test('a schema rule the flag parser does not model is still enforced', async () => {
  // iid is a positive integer: --iid 0 parses as a number and must then be rejected by zod.
  const { code, stderr } = await runCli(['mr_get', '--project', 'group/app', '--iid', '0'], env);
  assert.equal(code, 2);
  assert.match(stderr, /iid: (Number must be greater than 0|Too small)/);
});

test('boolean flags accept --flag and --no-flag', async () => {
  // Asserted on the presence of system notes rather than on a thread count: earlier tests in this
  // file create comments, and the mock keeps them (as the instance would).
  const hasSystem = (out) => parse(out).items.flatMap((d) => d.notes).some((n) => n.system);

  const on = await runCli(['mr_discussions', '--project', 'group/app', '--iid', '7', '--include-system'], env);
  assert.equal(on.code, 0);
  assert.equal(hasSystem(on.stdout), true, 'system notes are kept when asked for');

  const off = await runCli(['mr_discussions', '--project', 'group/app', '--iid', '7', '--no-include-system'], env);
  assert.equal(off.code, 0);
  assert.equal(hasSystem(off.stdout), false, 'system notes stay hidden');

  const explicit = await runCli(['mr_discussions', '--project', 'group/app', '--iid', '7', '--include-system=true'], env);
  assert.equal(explicit.code, 0);
  assert.equal(hasSystem(explicit.stdout), true);
});

test('--dry-run describes the request without sending it', async () => {
  const before = mock.log.filter((c) => c.method === 'POST').length;
  const { code, stdout, stderr } = await runCli([
    'mr_create', '--project', 'group/app', '--source-branch', 'feature/x',
    '--target-branch', 'master', '--title', 'T', '--draft', '--dry-run',
  ], env);
  assert.equal(code, 0);
  const out = parse(stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.method, 'POST');
  assert.match(out.url, /\/merge_requests$/);
  assert.equal(out.body.title, 'WIP: T');
  assert.match(stderr, /dry run/);
  assert.equal(mock.log.filter((c) => c.method === 'POST').length, before, 'nothing may be sent');
});

test('GITLAB_READ_ONLY refuses write tools', async () => {
  const { code, stderr } = await runCli(['mr_create', '--project', 'group/app', '--source-branch', 'x', '--target-branch', 'master', '--title', 'T'],
    { ...env, GITLAB_READ_ONLY: 'true' });
  assert.equal(code, 2);
  assert.match(stderr, /GITLAB_READ_ONLY=true/);

  const read = await runCli(['mr_get', '--project', '42', '--iid', '7'], { ...env, GITLAB_READ_ONLY: 'true' });
  assert.equal(read.code, 0);
});

test('a bad base URL is reported before anything is sent', async () => {
  const { code, stderr } = await runCli(['whoami'], { GITLAB_BASE_URL: 'gitlab.example.com', GITLAB_TOKEN: 't' });
  assert.equal(code, 1);
  assert.match(stderr, /must be an absolute URL/);
});

test('--host and --token override the environment', async () => {
  const { code, stdout } = await runCli(['whoami', '--host', mock.url, '--token', 'test-token'], {});
  assert.equal(code, 0);
  assert.equal(parse(stdout).username, 'alice');
});
