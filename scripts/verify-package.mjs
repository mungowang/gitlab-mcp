#!/usr/bin/env node
/**
 * Prove the package works the way a consumer receives it: pack it, install it into a throwaway
 * directory, then run both binaries and speak MCP to the server.
 *
 * This exists because the failure it catches is invisible from a checkout - the TypeScript sources
 * run perfectly there. The first packaging attempt shipped .ts files that npm consumers could not
 * execute at all (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and the only symptom was an
 * installed CLI that died on startup.
 *
 *   npm run verify:package            pack, install, exercise, clean up
 *   npm run verify:package -- --keep  leave the temp directory in place to poke at
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** For steps whose output a human needs to see when they fail. */
const runVisible = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
const step = (name, detail = '') => process.stdout.write(`[PASS] ${name}${detail ? ` - ${detail}` : ''}\n`);

const work = mkdtempSync(join(tmpdir(), 'gitlab-mcp-package-'));

try {
  // 1) Build, then pack with --ignore-scripts so that `prepack` cannot mix its own output into
  //    the --json stream this parses. The build is a separate step here purely to attribute a
  //    failure to the build rather than to the packing.
  runVisible(npm, ['run', 'build'], ROOT);
  const packed = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', work], ROOT));
  const info = packed[0];
  const paths = info.files.map((f) => f.path);
  const tarball = join(work, info.filename);

  for (const required of ['dist/index.js', 'dist/cli.js', 'bin/gitlab-server.mjs', 'bin/gitlab.mjs', 'tools.d/gitlab-extras.json', 'LICENSE', 'README.md']) {
    if (!paths.includes(required)) throw new Error(`${required} is missing from the tarball. Packed: ${paths.join(', ')}`);
  }
  if (paths.some((p) => p.startsWith('test/') || p.startsWith('node_modules/'))) {
    throw new Error('the tarball ships test/ or node_modules/');
  }
  step('tarball contains the runtime pieces and nothing private', `${info.filename}, ${info.files.length} files, ${(info.size / 1024).toFixed(1)} kB`);

  // The published code must be plain JavaScript: shipping .ts is unloadable from node_modules.
  const serverBundle = readFileSync(join(ROOT, 'dist/index.js'), 'utf8');
  if (!serverBundle.includes('McpServer') || /^\s*interface\s/m.test(serverBundle)) {
    throw new Error('dist/index.js does not look like the compiled server');
  }
  step('the shipped entry is compiled JavaScript', `${(serverBundle.length / 1024).toFixed(0)} kB dist/index.js`);

  // 2) Install it as a consumer would.
  run(npm, ['init', '-y'], work);
  execFileSync(npm, ['install', '--no-audit', '--no-fund', tarball], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  const installed = join(work, 'node_modules', '@mohou', 'gitlab-mcp');
  if (!existsSync(join(installed, 'tools.d', 'gitlab-extras.json'))) {
    throw new Error('tools.d did not survive installation - the server would start with no JSON tools');
  }
  step('installs cleanly and keeps its runtime data', '@mohou/gitlab-mcp in node_modules');

  // 3) The CLI binary, run exactly as `npx --package @mohou/gitlab-mcp mohou-gitlab` would.
  const cli = join(work, 'node_modules', '.bin', 'mohou-gitlab');
  const cliOut = run(cli, ['tools'], work);
  for (const expected of ['gitlab_mr_comment_on_line', 'gitlab_project_issues']) {
    if (!cliOut.includes(expected)) throw new Error(`the installed CLI does not list ${expected}`);
  }
  step('the installed CLI runs and lists both code- and JSON-declared tools', `${cliOut.split('\n').length - 1} lines of output`);

  // 4) The MCP server binary, over stdio, as an MCP client launches it.
  const server = spawn(process.execPath, [join(work, 'node_modules', '.bin', 'gitlab-mcp')], {
    cwd: work,
    // Deliberately unconfigured: it must still start and expose its tools.
    env: { ...process.env, GITLAB_BASE_URL: '', GITLAB_TOKEN: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d; });
  createInterface({ input: server.stdout }).on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const slot = pending.get(msg.id);
    if (slot) { pending.delete(msg.id); slot(msg); }
  });
  const request = (method, params) => new Promise((ok, fail) => {
    const id = nextId++;
    const timer = setTimeout(() => { if (pending.delete(id)) fail(new Error(`timeout: ${method}`)); }, 30_000);
    pending.set(id, (m) => { clearTimeout(timer); ok(m); });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-package', version: '0' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await request('tools/list', {})).result.tools.map((t) => t.name);
  server.kill();

  if (tools.length < 30) throw new Error(`only ${tools.length} tools are exposed`);
  for (const expected of ['gitlab_mr_merge', 'gitlab_project_issues']) {
    if (!tools.includes(expected)) throw new Error(`${expected} is not exposed by the installed server`);
  }
  step('the installed MCP server answers tools/list', `${tools.length} tools`);

  process.stdout.write(`\npackage verification passed\n`);
} finally {
  if (keep) process.stdout.write(`\nkept for inspection: ${work}\n`);
  else rmSync(work, { recursive: true, force: true });
}
