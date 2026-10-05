#!/usr/bin/env node
/**
 * Print the tool contract exactly as a model sees it.
 *
 * This asks the MCP server itself over stdio rather than reading the source, so what it prints
 * is the real interface - input JSON Schema, output schema presence and annotations included.
 * No GitLab connection is needed or made.
 *
 *   npm run tools:describe                 every tool, name and flags
 *   npm run tools:describe -- mr_merge     only tools whose name contains mr_merge
 *   npm run tools:describe -- --json mr    full JSON Schemas
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const filter = argv.find((a) => !a.startsWith('--'));

const proc = spawn(process.execPath, [resolve(ROOT, 'bin/gitlab-server.mjs')], {
  cwd: ROOT,
  // Deliberately unset: this must work without a token, and the start-up warning is suppressed.
  env: { ...process.env, GITLAB_BASE_URL: '', GITLAB_TOKEN: '' },
  stdio: ['pipe', 'pipe', 'ignore'],
});

let nextId = 1;
const pending = new Map();
createInterface({ input: proc.stdout }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const slot = pending.get(msg.id);
  if (slot) { pending.delete(msg.id); slot(msg); }
});
const request = (method, params) => new Promise((ok) => {
  const id = nextId++;
  pending.set(id, ok);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dump-tools', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const { result } = await request('tools/list', {});
proc.kill();

let tools = result.tools;
if (filter) tools = tools.filter((t) => t.name.includes(filter));

if (asJson) {
  process.stdout.write(JSON.stringify(tools, null, 2) + '\n');
} else {
  for (const t of tools) {
    const props = t.inputSchema?.properties ?? {};
    const required = new Set(t.inputSchema?.required ?? []);
    const flags = Object.entries(props).map(([name, schema]) => {
      const type = schema.enum ? schema.enum.join('|') : Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
      return `${required.has(name) ? '' : '?'}${name}:${type}`;
    }).join(' ');
    const marks = [
      t.annotations?.readOnlyHint ? 'read-only' : null,
      t.annotations?.destructiveHint ? 'destructive' : null,
      t.outputSchema ? 'structured' : null,
    ].filter(Boolean).join(',');
    process.stdout.write(`${t.name}${marks ? ` [${marks}]` : ''}\n  ${flags || '(no flags)'}\n`);
  }
  process.stdout.write(`\n${tools.length} tool(s)\n`);
}
