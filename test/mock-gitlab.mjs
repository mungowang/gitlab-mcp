// Offline mock GitLab 11.3. The goal is to be faithful to the real *status codes and response
// shapes*, not to simulate GitLab - especially the shapes this client's diff-position logic
// depends on (`versions[].*_commit_sha` vs the `*_sha` a position needs, `changes[].diff` hunk
// numbering) and the error bodies of the merge endpoints. A mock that drifts from the real
// thing would hide exactly the bugs the tests exist to catch.
import http from 'node:http';

const TOKEN = 'test-token';
const PROJECT_PATH = 'group/app';
const BASE_URL = 'http://gitlab.example.com';

const HEAD_SHA = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';
const BASE_SHA = '1122334455667788990011223344556677889900';
const START_SHA = '9988776655443322110099887766554433221100';

// src/app.ts: 7 old-side lines from 10, 9 new-side lines from 10, two added lines (13, 14).
const APP_DIFF = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,7 +10,9 @@ export function main() {',
  '   const a = 1;',
  '   const b = 2;',
  '   const c = 3;',
  '+  guard();',
  '+  check();',
  '   const d = 4;',
  '   const e = 5;',
  '   return a + b + c + d + e;',
  ' }',
  '',
].join('\n');

// README.md: one added line in the middle, so the two sides disagree after it.
const README_DIFF = [
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,2 +1,3 @@',
  ' # App',
  '+New line',
  ' Done',
  '',
].join('\n');

const CHANGES = [
  { old_path: 'src/app.ts', new_path: 'src/app.ts', a_mode: '100644', b_mode: '100644', diff: APP_DIFF, new_file: false, renamed_file: false, deleted_file: false },
  { old_path: 'README.md', new_path: 'README.md', a_mode: '100644', b_mode: '100644', diff: README_DIFF, new_file: false, renamed_file: false, deleted_file: false },
  { old_path: 'logo.png', new_path: 'logo.png', a_mode: null, b_mode: null, diff: '', new_file: false, renamed_file: false, deleted_file: false },
];

const mr = (over = {}) => ({
  id: 101, iid: 7, project_id: 42, title: 'Add login guard', description: 'Closes #3',
  state: 'opened', source_branch: 'feature/login', target_branch: 'master',
  work_in_progress: false, merge_status: 'can_be_merged', sha: HEAD_SHA,
  changes_count: '2', user_notes_count: 2, discussion_locked: false,
  assignee: null, author: { id: 1, username: 'alice', name: 'Alice' },
  labels: ['review'], milestone: null,
  web_url: `${BASE_URL}/${PROJECT_PATH}/merge_requests/7`,
  ...over,
});

const MR_WIP = mr({ iid: 8, title: 'WIP: second', work_in_progress: true });

const PROJECT = {
  id: 42, name: 'App', path: 'app', path_with_namespace: PROJECT_PATH,
  default_branch: 'master', visibility: 'private', archived: false,
  web_url: `${BASE_URL}/${PROJECT_PATH}`, http_url_to_repo: `${BASE_URL}/${PROJECT_PATH}.git`,
};

const NOTE_UNRESOLVED = {
  id: 11, body: 'this branch is unreachable', author: { id: 2, username: 'bob', name: 'Bob' },
  created_at: '2026-01-02T03:04:05.000Z', system: false, resolvable: true, resolved: false,
  noteable_type: 'MergeRequest', type: 'DiffNote',
  position: { base_sha: BASE_SHA, start_sha: START_SHA, head_sha: HEAD_SHA, position_type: 'text', old_path: 'src/app.ts', new_path: 'src/app.ts', new_line: 13 },
};

const j = (res, body, code = 200) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};
const text = (res, body, contentType = 'text/plain') => {
  res.statusCode = 200;
  res.setHeader('content-type', contentType);
  res.end(body);
};

export function startMock(port = 18090) {
  const log = [];
  // Writes must actually change what a later read returns. A mock where POST has no effect is
  // how a broken "the note is really on the diff" check stays green.
  const discussions = [
    { id: 'disc-1', individual_note: false, notes: [NOTE_UNRESOLVED] },
    { id: 'disc-2', individual_note: true, notes: [{ id: 12, body: 'added 1 commit', system: true, resolvable: false }] },
    { id: 'disc-3', individual_note: false, notes: [{ id: 13, body: 'fixed', resolvable: true, resolved: true, position: { new_path: 'src/app.ts', new_line: 14 } }] },
  ];
  let nextNoteId = 21;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, token: req.headers['private-token'] ?? null, body: raw };
      log.push(entry);
      if (req.headers['private-token'] !== TOKEN) return j(res, { message: '401 Unauthorized' }, 401);

      const [path, qs] = req.url.split('?');
      const q = new URLSearchParams(qs ?? '');
      const M = req.method;
      // Accept both the numeric id and the percent-encoded path, exactly as GitLab does.
      const proj = '(?:42|group%2Fapp)';
      const body = raw ? JSON.parse(raw) : {};

      // -- meta ---------------------------------------------------------------
      if (M === 'GET' && path === '/api/v4/version') return j(res, { version: '11.3.0', revision: '17bd59a' });
      if (M === 'GET' && path === '/api/v4/user') return j(res, { id: 1, username: 'alice', name: 'Alice', state: 'active' });
      if (M === 'GET' && path === '/api/v4/users') return j(res, [{ id: 2, username: 'bob', name: 'Bob' }]);

      // -- projects -----------------------------------------------------------
      if (M === 'GET' && path === '/api/v4/projects') {
        res.setHeader('x-total', '1');
        res.setHeader('x-page', '1');
        res.setHeader('x-per-page', '50');
        return j(res, [PROJECT]);
      }
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/labels$`).test(path)) return j(res, [{ id: 1, name: 'review', color: '#ff0000' }]);
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/members$`).test(path)) return j(res, [{ id: 2, username: 'bob', name: 'Bob', access_level: 30 }]);
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/issues$`).test(path)) return j(res, [{ id: 3, iid: 3, title: 'Login fails', state: 'opened' }]);
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/issues/3$`).test(path)) return j(res, { id: 3, iid: 3, title: 'Login fails', state: 'opened' });
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/repository/branches$`).test(path)) {
        return j(res, [
          { name: 'master', default: true, merged: false, protected: true, commit: { id: BASE_SHA } },
          { name: 'feature/login', default: false, merged: false, protected: false, commit: { id: HEAD_SHA } },
        ]);
      }
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/repository/tags$`).test(path)) return j(res, [{ name: 'v1.0.0' }]);
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/repository/commits$`).test(path)) return j(res, [{ id: HEAD_SHA, title: 'Add guard' }]);
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/repository/files/.+/raw$`).test(path)) {
        return text(res, 'export function main() {\n  guard();\n}\n');
      }
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/pipelines$`).test(path)) return j(res, [{ id: 900, status: 'success', ref: 'feature/login' }]);
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/pipelines/900/jobs$`).test(path)) return j(res, [{ id: 901, name: 'test', status: 'success', stage: 'test' }]);
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}$`).test(path)) return j(res, PROJECT);
      if (M === 'GET' && /^\/api\/v4\/groups\/.+\/projects$/.test(path)) return j(res, [PROJECT]);

      // -- merge requests -----------------------------------------------------
      const mrPath = new RegExp(`^/api/v4/projects/${proj}/merge_requests/(\\d+)(/.*)?$`).exec(path);
      if (M === 'GET' && new RegExp(`^/api/v4/projects/${proj}/merge_requests$`).test(path)) {
        const perPage = Number(q.get('per_page') ?? 20);
        const isFirst = (q.get('page') ?? '1') === '1';
        if (perPage < 3) {
          res.setHeader('x-total', '3');
          res.setHeader('x-total-pages', '2');
          res.setHeader('x-page', isFirst ? '1' : '2');
          res.setHeader('x-per-page', String(perPage));
          if (isFirst) res.setHeader('x-next-page', '2');
          return j(res, [mr(), MR_WIP].slice(0, perPage));
        }
        res.setHeader('x-page', '1');
        res.setHeader('x-per-page', String(perPage));
        res.setHeader('x-total', '2');
        return j(res, [mr(), MR_WIP]);
      }
      if (M === 'POST' && new RegExp(`^/api/v4/projects/${proj}/merge_requests$`).test(path)) {
        if (body.source_branch === 'dup') {
          return j(res, { message: ['Another open merge request already exists for this source branch: !7'] }, 409);
        }
        if (body.source_branch === body.target_branch) {
          return j(res, { message: { source_branch: ['can\'t be the same as target_branch'] } }, 400);
        }
        return j(res, mr({
          iid: 12, title: body.title, description: body.description ?? null,
          source_branch: body.source_branch, target_branch: body.target_branch,
          work_in_progress: /^WIP:/i.test(body.title ?? ''),
          labels: body.labels ? String(body.labels).split(',') : [],
          assignee: body.assignee_id ? { id: body.assignee_id, username: 'bob' } : null,
          merge_status: 'cannot_be_merged',
        }), 201);
      }

      if (mrPath) {
        const iid = Number(mrPath[1]);
        const sub = mrPath[2] ?? '';
        if (M === 'GET' && sub === '') return j(res, iid === 8 ? mr({ iid: 8, title: 'WIP: second', work_in_progress: true }) : mr({ iid }));
        if (M === 'GET' && sub === '/changes') return j(res, { ...mr({ iid }), changes: CHANGES });
        if (M === 'GET' && sub === '/versions') {
          return j(res, [
            { id: 110, head_commit_sha: HEAD_SHA, base_commit_sha: BASE_SHA, start_commit_sha: START_SHA, created_at: '2026-01-02T00:00:00.000Z', merge_request_id: 101, state: 'collected', real_size: '3' },
            { id: 108, head_commit_sha: 'ffeeddccbbaa99887766554433221100ffeeddcc', base_commit_sha: BASE_SHA, start_commit_sha: START_SHA, created_at: '2026-01-01T00:00:00.000Z', merge_request_id: 101, state: 'collected', real_size: '1' },
          ]);
        }
        if (M === 'GET' && sub === '/versions/110') {
          return j(res, { id: 110, head_commit_sha: HEAD_SHA, base_commit_sha: BASE_SHA, start_commit_sha: START_SHA, diffs: CHANGES });
        }
        if (M === 'GET' && sub === '/versions/108') {
          return j(res, { id: 108, head_commit_sha: 'ffeeddccbbaa99887766554433221100ffeeddcc', base_commit_sha: BASE_SHA, start_commit_sha: START_SHA, diffs: [CHANGES[0]] });
        }
        if (M === 'GET' && sub === '/pipelines') return j(res, [{ id: 900, status: 'success', ref: 'feature/login', sha: HEAD_SHA }]);
        if (M === 'GET' && sub === '/discussions') return j(res, discussions);
        if (M === 'POST' && sub === '/discussions') {
          const pos = body.position ?? {};
          // The naive failure this client is built to avoid: a position the instance rejects.
          if (!pos.base_sha || !pos.new_path || (pos.new_line === undefined && pos.old_line === undefined)) {
            return j(res, { message: 'Note position is invalid' }, 400);
          }
          if (pos.new_line === 99 || pos.old_line === 99) return j(res, { message: 'Note position is invalid' }, 400);
          const created = {
            id: `disc-new-${nextNoteId}`, individual_note: false,
            notes: [{ id: nextNoteId++, body: body.body, resolvable: true, resolved: false, position: pos, type: 'DiffNote' }],
          };
          discussions.push(created);
          return j(res, created, 201);
        }
        if (M === 'POST' && /^\/discussions\/[^/]+\/notes$/.test(sub)) {
          const id = sub.split('/')[2];
          const thread = discussions.find((d) => d.id === id);
          const note = { id: nextNoteId++, body: body.body, resolvable: true, resolved: false };
          thread?.notes.push(note);
          return j(res, note, 201);
        }
        if (M === 'PUT' && /^\/discussions\/[^/]+$/.test(sub)) {
          const resolved = q.get('resolved') === 'true';
          const id = sub.split('/')[2];
          const thread = discussions.find((d) => d.id === id);
          if (!thread) return j(res, { message: '404 Discussion Not Found' }, 404);
          for (const note of thread.notes) if (note.resolvable) note.resolved = resolved;
          return j(res, thread);
        }
        if (M === 'DELETE' && /^\/discussions\/[^/]+\/notes\/\d+$/.test(sub)) {
          const [, , id, , noteId] = sub.split('/');
          const thread = discussions.find((d) => d.id === id);
          if (!thread) return j(res, { message: '404 Discussion Not Found' }, 404);
          thread.notes = thread.notes.filter((n) => String(n.id) !== noteId);
          res.statusCode = 204;
          return res.end();
        }
        if (M === 'POST' && sub === '/notes') return j(res, { id: 31, body: body.body, author: { id: 1, username: 'alice' } }, 201);
        if (M === 'PUT' && sub === '/merge') {
          if (iid === 8) return j(res, { message: ['Branch cannot be merged'] }, 405);
          if (iid === 9) return j(res, { message: ['Method Not Allowed'] }, 406);
          if (body.sha && body.sha !== HEAD_SHA) return j(res, { message: ['SHA mismatch'] }, 409);
          return j(res, mr({ iid, state: 'merged', merge_commit_sha: 'cafebabe' }));
        }
        if (M === 'PUT' && sub === '') {
          return j(res, mr({ iid, ...(body.title !== undefined ? { title: body.title, work_in_progress: /^WIP:/i.test(body.title) } : {}), ...(body.state_event === 'close' ? { state: 'closed' } : {}) }));
        }
      }

      j(res, { message: `404 Not Found: ${M} ${path}` }, 404);
    });
  });
  return new Promise((ok) => server.listen(port, () => ok({ server, log, port, url: `http://127.0.0.1:${port}` })));
}

export const fixtures = { TOKEN, PROJECT, PROJECT_PATH, HEAD_SHA, BASE_SHA, START_SHA, CHANGES, APP_DIFF, README_DIFF };

if (import.meta.url === `file://${process.argv[1]}`) startMock().then((m) => console.log(`[mock] ${m.url}`));
