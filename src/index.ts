import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { allTools } from './registry.ts';
import { registerAll } from './tool.ts';
import { baseUrlProblem, tokenProblem } from './gitlab.ts';

const tools = allTools();
const names = Object.keys(tools);
const readOnly = process.env.GITLAB_READ_ONLY === 'true';
const server = new McpServer({ name: 'gitlab-server', version: '1.0.0' });

registerAll(server, [tools], { readOnly });

/**
 * Connection problems used to surface only as `fetch failed` deep inside the first call.
 * Say them up front, and say them without quoting the value (a host may inject it from a
 * secret store and mask it).
 */
const problems = [baseUrlProblem(), tokenProblem()].filter((p): p is string => p !== null);
for (const problem of problems) process.stderr.write(`[gitlab-server] WARN ${problem}\n`);

const enabled = readOnly ? names.filter((n) => tools[n].readOnly) : names;
process.stderr.write(
  `[gitlab-server] started; ${enabled.length}/${names.length} tools` +
  `${readOnly ? ' (READ-ONLY: write tools not registered)' : ''}` +
  `${problems.length ? '; CONFIGURATION UNUSABLE (see WARN above)' : ''}\n`,
);

await server.connect(new StdioServerTransport());
