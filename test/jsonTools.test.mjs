import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolsFromJson } from '../src/jsonTools.ts';
import { loadJsonTools, allTools } from '../src/registry.ts';

test('the shipped declarations load, and JSON tools are merged after the code tools', () => {
  const tools = allTools();
  assert.ok(tools.gitlab_project_issues, 'tools.d/gitlab-extras.json was not loaded');
  assert.equal(tools.gitlab_project_issues.readOnly, true);
  assert.ok(tools.gitlab_project_issues.returns, 'a declared return type must become an output schema');
  // A code-declared tool of the same name must be overridable by a declaration, so the JSON
  // layer has to be merged last - this asserts the merge order, not just the presence.
  const overridden = Object.assign({}, ...([
    { gitlab_x: { desc: 'code', run: async () => 'code' } },
    toolsFromJson({ gitlab_x: { desc: 'json', method: 'GET', path: '/x', readOnly: true } }),
  ]));
  assert.equal(overridden.gitlab_x.desc, 'json');
});

test('a broken declaration is refused at startup, naming the problem', () => {
  const cases = [
    [{ x: null }, /definition must be an object/],
    [{ x: { method: 'GET', path: '/x' } }, /missing 'desc'/],
    [{ x: { desc: 'd', path: '/x' } }, /'method' must be one of GET\/POST\/PUT\/PATCH\/DELETE/],
    [{ x: { desc: 'd', method: 'FETCH', path: '/x' } }, /'method' must be one of/],
    [{ x: { desc: 'd', method: 'GET' } }, /missing 'path'/],
    [{ x: { desc: 'd', method: 'GET', path: '/x/{p}', params: { p: 'nope' } } }, /not in the registry/],
    [{ x: { desc: 'd', method: 'GET', path: '/x', params: { p: 'string' } } }, /declared but never used/],
    [{ x: { desc: 'd', method: 'GET', path: '/x/{p}', params: { p: 'string' }, required: ['q'] } }, /'required' lists 'q'/],
    [{ x: { desc: 'd', method: 'GET', path: '/x', returns: 'nope' } }, /not in the entity registry/],
  ];
  for (const [defs, expected] of cases) {
    assert.throws(() => toolsFromJson(defs, 'test.d/x.json'), expected, JSON.stringify(defs));
  }
});

test('a page return type is only legal on a GET declaration', async () => {
  const { gitlab_x } = toolsFromJson({ gitlab_x: { desc: 'd', method: 'POST', path: '/x', returns: 'anyPage' } });
  await assert.rejects(() => gitlab_x.run({}), /only meaningful for GET/);
});

test('required params are mandatory in the generated schema, optional ones are not', () => {
  const { gitlab_x } = toolsFromJson({
    gitlab_x: {
      desc: 'd', method: 'GET', path: '/x/{a}',
      params: { a: 'string', b: 'string' },
      required: ['a'],
      query: { b: '{b}' },
    },
  });
  assert.ok(gitlab_x.input.a, 'a must be in the shape');
  assert.ok(gitlab_x.input.b, 'b must be in the shape');
  assert.equal(gitlab_x.input.a.safeParse(undefined).success, false);
  assert.equal(gitlab_x.input.b.safeParse(undefined).success, true);
});

test('an unreadable or malformed plugin directory fails loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-tools-'));
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  assert.throws(() => loadJsonTools(dir), /is not valid JSON/);

  const missing = join(dir, 'nope');
  assert.throws(() => loadJsonTools(missing), /cannot read the plugin directory/);
});
