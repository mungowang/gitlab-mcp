import { z } from 'zod';
import { allTools } from './registry.ts';
import { renderResult, type Tool } from './tool.ts';
import { specsFor, parseFlags, flagsHelp } from './args.ts';
import { isDryRun } from './gitlab.ts';

/**
 * CLI front end. It owns no API knowledge at all: every subcommand is a tool from the same
 * registry the MCP server exposes, with flags derived from that tool's schema. Adding a tool
 * therefore adds a subcommand, and the two front ends cannot drift.
 *
 * Connection flags (--host, --token, --token-file, --dry-run) are handled in bin/gitlab.mjs,
 * because the transport reads the environment when it is first imported.
 */

const USAGE = `
gitlab - GitLab 11.3 command line (same tools as the MCP server)

Usage
  gitlab <tool> [--flag value ...]
  gitlab call <tool> [--flag value ...]     (the explicit form; identical behaviour)
  gitlab tools [--json]                     list the available tools
  gitlab describe <tool>                    one tool's purpose and flags

Connection
  GITLAB_BASE_URL   instance root, e.g. http://gitlab.example.com   (required)
  GITLAB_TOKEN      personal access token with the 'api' scope       (required)
  GITLAB_READ_ONLY  'true' refuses every tool that is not read-only
  GITLAB_TIMEOUT_MS request timeout, default 30000
  GITLAB_MAX_RETRIES retries for 429/502/503/504, default 2

  --host <url>      override GITLAB_BASE_URL for this call
  --token <token>   override GITLAB_TOKEN for this call
  --token-file <f>  read the token from a file (keeps it out of the shell history)
  --dry-run         print the request that would be sent; sends nothing

Output is JSON on stdout; diagnostics go to stderr. Exit codes: 0 ok, 1 call failed, 2 bad usage.

Examples
  gitlab whoami
  gitlab mr_list --project group/app --state opened --per-page 10
  gitlab mr_changes --project group/app --iid 12 --max-patch-chars 2000
  gitlab mr_comment_on_line --project group/app --iid 12 --path src/app.ts --line 42 --body "this branch is unreachable"
  gitlab raw_api --method GET --path /projects/group%2Fapp/merge_requests
`.trimStart();

function fail(message: string, code = 1): never {
  process.stderr.write(`gitlab: ${message}\n`);
  process.exit(code);
}

/** Tool names may be given in full or without the shared prefix, if that stays unambiguous. */
function resolveTool(tools: Record<string, Tool>, name: string): string {
  if (tools[name]) return name;
  const matches = [...new Set(Object.keys(tools).filter((k) => k.replace(/^gitlab_/, '') === name))];
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail(`unknown tool '${name}'. Run 'gitlab tools' for the list.`, 2);
  fail(`'${name}' matches ${matches.join(', ')} - use the full name.`, 2);
}

const firstLine = (text: string): string => text.split('\n')[0];

function describeTool(name: string, tool: Tool): string {
  const specs = specsFor(tool.input);
  return [
    `${name}${tool.readOnly ? '  [read-only]' : ''}${tool.destructive ? '  [destructive]' : ''}`,
    tool.desc,
    '',
    'Flags:',
    flagsHelp(specs).trimEnd(),
  ].join('\n') + '\n';
}

async function main(): Promise<void> {
  let tools: Record<string, Tool>;
  try {
    tools = allTools();
  } catch (err) {
    fail((err as Error).message);
  }

  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    process.stdout.write(`\nTools (${Object.keys(tools).length}):\n`);
    process.stdout.write(listTools(tools));
    return;
  }

  if (cmd === 'tools') {
    if (!argv.includes('--json')) {
      process.stdout.write(listTools(tools));
      return;
    }
    // Built explicitly rather than serialising the tool objects: those hold Zod schemas, whose
    // JSON form is an implementation detail of zod and not an interface anyone should parse.
    const summary = Object.fromEntries(Object.entries(tools).map(([n, t]) => [n, {
      readOnly: !!t.readOnly,
      destructive: !!t.destructive,
      desc: t.desc,
      flags: specsFor(t.input),
    }]));
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  if (cmd === 'describe') {
    const target = argv[1];
    if (!target) fail('describe needs a tool name, e.g. gitlab describe mr_merge', 2);
    const name = resolveTool(tools, target);
    process.stdout.write(describeTool(name, tools[name]));
    return;
  }

  const explicit = cmd === 'call';
  if (explicit && !argv[1]) fail('call needs a tool name', 2);
  const name = resolveTool(tools, explicit ? argv[1] : cmd);
  const tool = tools[name];
  const rest = explicit ? argv.slice(2) : argv.slice(1);
  const specs = specsFor(tool.input);

  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(describeTool(name, tool));
    return;
  }

  if (process.env.GITLAB_READ_ONLY === 'true' && !tool.readOnly) {
    fail(`${name} is a write tool and GITLAB_READ_ONLY=true`, 2);
  }

  const { args, errors } = parseFlags(rest, specs);
  if (errors.length) {
    fail(`${name}: ${errors.join('; ')}\n\nFlags:\n${flagsHelp(specs)}`, 2);
  }

  // The schema stays authoritative: this is where defaults are applied and where a rule the
  // flag parser does not model (a regex, a bound, a refinement) is enforced.
  const parsed = z.object(tool.input ?? {}).safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`)
      .join('; ');
    fail(`${name}: ${detail}`, 2);
  }

  if (isDryRun()) process.stderr.write('gitlab: dry run - no request was sent\n');
  const out = await tool.run(parsed.data);
  process.stdout.write(renderResult(out) + '\n');
}

function listTools(tools: Record<string, Tool>): string {
  const names = Object.keys(tools).sort();
  const width = Math.max(...names.map((n) => n.length));
  return names
    .map((n) => `${tools[n].readOnly ? 'ro' : '  '}  ${n.padEnd(width)}  ${firstLine(tools[n].desc)}`)
    .join('\n') + '\n';
}

main().catch((err) => fail(err?.message ?? String(err)));
