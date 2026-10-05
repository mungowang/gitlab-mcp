#!/usr/bin/env node
/**
 * Live verification against the real instance - the only place the assumptions this codebase
 * makes about GitLab CE 11.3.0 can actually be checked. Everything else runs against
 * test/mock-gitlab.mjs, which by construction encodes the same assumptions.
 *
 *   GITLAB_BASE_URL=http://gitlab.example.com GITLAB_TOKEN=... npm run verify:live -- --project group/app
 *   ... -- --project group/app --iid 7            also read a real merge request's diff
 *   ... -- --project group/app --iid 7 --write    additionally create and delete a diff comment
 *
 * Read-only unless --write is given. In write mode the only mutation is one diff note, which is
 * deleted again (11.3 has DELETE for a discussion note); nothing else is touched.
 *
 * If the project does not resolve, this searches for candidates instead of reporting the same
 * 404 once per check: a 404 leaves two questions open - is the path wrong, or can this token not
 * see the project - and a search answers both.
 */
import { gitlab, gitlabList, baseUrlProblem, tokenProblem } from '../src/gitlab.ts';
import { parseDiff, latestVersion, versionShas, buildPosition } from '../src/diff.ts';
import { projectRef } from '../src/types.ts';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const write = argv.includes('--write');
const project = flag('project');
const iid = flag('iid') ? Number(flag('iid')) : undefined;

const results = [];
const record = (status, name, detail = '') => {
  results.push({ status, name, detail });
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  process.stdout.write(`[${mark}] ${name}${detail ? ` - ${detail}` : ''}\n`);
};

const check = async (name, fn) => {
  try {
    record('PASS', name, (await fn()) ?? '');
    return true;
  } catch (err) {
    record('FAIL', name, err.message);
    return false;
  }
};

const skip = (name, why) => record('SKIP', name, why);

process.stdout.write(`live verification against ${process.env.GITLAB_BASE_URL ?? '(no base URL)'}\n`);
process.stdout.write(`mode: ${write ? 'WRITE (creates and deletes one diff comment)' : 'read-only'}\n\n`);

const baseProblem = baseUrlProblem();
const tokenProblemText = tokenProblem();
if (baseProblem || tokenProblemText) {
  record('FAIL', 'connection settings', baseProblem ?? tokenProblemText);
  process.exit(1);
}

let version = null;
await check('GET /version answers (proves the token works over PRIVATE-TOKEN)', async () => {
  version = await gitlab('GET', '/version');
  return `version ${version.version} (revision ${version.revision ?? '?'}), enterprise=${version.enterprise}`;
});

if (version && !String(version.version).startsWith('11.3')) {
  record('FAIL', 'instance is the version this client targets', `expected 11.3.x, got ${version.version}`);
}

await check('GET /user answers', async () => {
  const me = await gitlab('GET', '/user');
  return `${me.username} (id ${me.id})`;
});

/** A 404 on a project is ambiguous, so ask the two questions it leaves open. */
async function investigateProject(project) {
  const parts = String(project).split('/');
  const namespace = parts[0];
  const name = parts[parts.length - 1];
  process.stdout.write(`\n  '${project}' did not resolve. Searching for what this token can see:\n`);

  try {
    const found = await gitlabList('GET', '/projects', { query: { search: name, per_page: 20 } });
    if (found.items.length === 0) {
      process.stdout.write(`  projects matching '${name}': none visible to this token\n`);
    } else {
      process.stdout.write(`  projects matching '${name}' (${found.pagination.total ?? found.items.length}):\n`);
      for (const p of found.items) {
        process.stdout.write(`    ${p.path_with_namespace}  id=${p.id}  ${p.visibility ?? ''}\n`);
      }
    }
  } catch (err) {
    process.stdout.write(`  search for '${name}' failed: ${err.message}\n`);
  }

  try {
    const users = await gitlabList('GET', '/users', { query: { search: namespace, per_page: 20 } });
    if (users.items.length > 0) {
      process.stdout.write(`  users matching '${namespace}': ${users.items.map((u) => u.username).join(', ')}\n`);
    }
  } catch {
    // Diagnostics only: never let this hide the original failure.
  }

  process.stdout.write(
    `  -> if a candidate above is the right project, re-run with --project <that path> (or its id).\n`
    + `  -> if nothing is listed, this token cannot see the project: GitLab answers 404, not 403.\n`,
  );
}

let ref = project ? projectRef(project) : null;
let projectReady = false;

if (!project) {
  skip('project checks', 'pass --project <id-or-path> to run them');
} else {
  projectReady = await check('project resolves, and a path is percent-encoded for us', async () => {
    const p = await gitlab('GET', `/projects/${ref}`);
    // Switch to the numeric id: the rest of the run then cannot be confused by a rename.
    ref = String(p.id ?? ref);
    return `${p.path_with_namespace} (id ${p.id}, default branch ${p.default_branch})`;
  });

  if (!projectReady) {
    await investigateProject(project);
    skip('the remaining project checks', 'the project path did not resolve - use a candidate from above');
  }
}

if (projectReady) {
  await check('GET /projects/:id/merge_requests returns an array with pagination headers', async () => {
    const page = await gitlabList('GET', `/projects/${ref}/merge_requests`, { query: { state: 'all', per_page: 5 } });
    return `${page.items.length} item(s), total=${page.pagination.total}, nextPage=${page.pagination.nextPage}`;
  });

  await check('MR objects carry work_in_progress (the 11.3 draft flag)', async () => {
    const page = await gitlabList('GET', `/projects/${ref}/merge_requests`, { query: { state: 'all', per_page: 100 } });
    if (page.items.length === 0) return 'no merge requests to inspect';
    const missing = page.items.filter((m) => !('work_in_progress' in m));
    if (missing.length) throw new Error(`${missing.length} MR(s) have no work_in_progress field`);
    const wip = page.items.filter((m) => m.work_in_progress).length;
    return `${page.items.length} checked, ${wip} marked work_in_progress`;
  });
}

if (projectReady && !iid) {
  skip('merge request checks', 'pass --iid <n> to run them');
} else if (projectReady) {
  const base = `/projects/${ref}/merge_requests/${iid}`;
  let shas = null;
  let diffs = [];

  await check('GET /merge_requests/:iid answers, with merge_status', async () => {
    const mr = await gitlab('GET', base);
    return `"${mr.title}" ${mr.state}/${mr.merge_status}`;
  });

  await check('GET /changes returns the diff files', async () => {
    const mr = await gitlab('GET', `${base}/changes`);
    const files = Array.isArray(mr.changes) ? mr.changes : [];
    if (files.length === 0) throw new Error('the changes array is empty or absent');
    const withDiff = files.filter((f) => f.diff).length;
    return `${files.length} file(s), ${withDiff} with a textual diff`;
  });

  await check('GET /versions exists and names its SHAs *_commit_sha', async () => {
    const versions = await gitlab('GET', `${base}/versions`);
    if (!Array.isArray(versions) || versions.length === 0) throw new Error('no diff versions returned');
    const newest = latestVersion(versions);
    shas = versionShas(newest);            // throws if the field names differ
    return `${versions.length} version(s); newest id ${shas.id}, head ${shas.head_sha.slice(0, 8)}`;
  });

  await check('a diff version carries diffs that parse, and a real line resolves', async () => {
    if (!shas) throw new Error('no diff version was read');
    const version = await gitlab('GET', `${base}/versions/${shas.id}`);
    diffs = Array.isArray(version.diffs) ? version.diffs : [];
    if (diffs.length === 0) throw new Error('the diff version has no diffs[]');
    const parsed = diffs.map((f) => ({ path: f.new_path ?? f.old_path, ...parseDiff(f.diff ?? '') }));
    const withLines = parsed.filter((p) => p.ranges.new.length > 0 || p.ranges.old.length > 0);
    if (withLines.length === 0) throw new Error('no commentable line was found in any file');
    return `${diffs.length} file(s), ${withLines.length} with commentable lines`;
  });

  await check('GET /discussions returns threads (resolvable notes included)', async () => {
    const page = await gitlabList('GET', `${base}/discussions`, { query: { per_page: 20 } });
    const notes = page.items.flatMap((d) => d.notes ?? []);
    const resolvable = notes.filter((n) => n.resolvable);
    // Not fatal: a merge request can genuinely have no diff comments yet.
    return `${page.items.length} thread(s), ${resolvable.length} resolvable note(s)`;
  });

  if (!write) {
    skip('diff note write path', 'pass --write to create and delete one diff comment');
  } else {
    const line = (() => {
      for (const file of diffs) {
        const parsed = parseDiff(file.diff ?? '');
        const target = parsed.lines.get(`new:${parsed.ranges.new[0]?.from}`) ?? [...parsed.lines.values()][0];
        const path = file.new_path ?? file.old_path;
        if (target && path) return { file, target, path };
      }
      return null;
    })();

    if (!line || !shas) {
      skip('diff note write path', 'no commentable line was found');
    } else {
      let created = null;
      await check('POST a diff note with a nested position object (the assumption most likely to be wrong)', async () => {
        const position = buildPosition(line.file, line.target, shas);
        created = await gitlab('POST', `${base}/discussions`, {
          body: { body: 'verify:live probe - this note is deleted again immediately', position },
        });
        const note = (created.notes ?? [])[0];
        if (!note) throw new Error('the created discussion came back without notes');
        return `discussion ${created.id}, note ${note.id}, position accepted`;
      });

      await check('the note is really on the diff', async () => {
        if (!created) throw new Error('no discussion was created');
        const page = await gitlabList('GET', `${base}/discussions`, { query: { per_page: 100 } });
        const found = page.items.find((d) => String(d.id) === String(created.id));
        if (!found) throw new Error('the created discussion is not in the list');
        const note = (found.notes ?? [])[0];
        if (!note?.position) throw new Error('the note has no position, so it is not a diff note');
        return `new_path ${note.position.new_path}, new_line ${note.position.new_line}`;
      });

      await check('resolve and unresolve a thread', async () => {
        if (!created) throw new Error('no discussion was created');
        await gitlab('PUT', `${base}/discussions/${created.id}`, { query: { resolved: true } });
        const back = await gitlab('PUT', `${base}/discussions/${created.id}`, { query: { resolved: false } });
        const note = (back.notes ?? [])[0];
        return `resolved toggled (now ${note?.resolved})`;
      });

      await check('cleanup: the probe note is deleted', async () => {
        if (!created) throw new Error('no discussion was created');
        const noteId = (created.notes ?? [])[0]?.id;
        if (!noteId) throw new Error('cannot delete a note without its id');
        await gitlab('DELETE', `${base}/discussions/${created.id}/notes/${noteId}`);
        return `deleted note ${noteId}`;
      });
    }
  }
}

// Draft handling is the other version-specific translation; it needs a scratch MR to test and
// is therefore left to a manual run rather than automated against someone's real project.
skip(
  'draft = "WIP: " title prefix',
  'create an MR with the web UI titled "WIP: x", confirm gitlab_mr_get reports work_in_progress=true, then check gitlab_mr_update --draft false clears it',
);

const failed = results.filter((r) => r.status === 'FAIL');
process.stdout.write(`\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped\n`);
if (failed.length) process.stdout.write(`\nNot verified: ${failed.map((f) => f.name).join('; ')}\n`);
process.exit(failed.length ? 1 : 0);
