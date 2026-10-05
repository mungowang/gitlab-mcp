#!/usr/bin/env node
// Plain-JS entry point (see bin/gitlab-server.mjs for why) plus the one job that must happen
// before anything else loads: connection flags are read here, because the transport module
// snapshots the environment at import time.
const [major, minor] = process.versions.node.split('.').map(Number);
const MIN_MAJOR = 22, MIN_MINOR = 6;

if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
  process.stderr.write(
    `[gitlab] Node >= ${MIN_MAJOR}.${MIN_MINOR} is required (native TypeScript type stripping), ` +
    `but this is ${process.version}. No build step is needed - just upgrade Node.\n`,
  );
  process.exit(1);
}

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);

/** Remove `--name value` from argv and return the value, so it is not re-parsed as a tool arg. */
const take = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`[gitlab] ${name} needs a value\n`);
    process.exit(2);
  }
  argv.splice(i, 2);
  return value;
};

// Removing these from argv matters beyond parsing: a token left in argv shows up in `ps`.
const host = take('--host') ?? take('--base-url');
const token = take('--token');
const tokenFile = take('--token-file');

if (host !== undefined) process.env.GITLAB_BASE_URL = host;
if (token !== undefined) process.env.GITLAB_TOKEN = token;
if (tokenFile !== undefined) {
  try {
    process.env.GITLAB_TOKEN = readFileSync(tokenFile, 'utf8').trim();
  } catch (err) {
    process.stderr.write(`[gitlab] cannot read --token-file ${tokenFile}: ${err.message}\n`);
    process.exit(2);
  }
}

// Ask the transport to describe the request instead of sending it. Read-only tools still
// run, so this is a way to see what a project path resolves to without touching the instance.
if (argv.includes('--dry-run')) {
  process.env.GITLAB_DRY_RUN = 'true';
  argv.splice(argv.indexOf('--dry-run'), 1);
}

process.argv = [process.argv[0], process.argv[1], ...argv];
await import('../src/cli.ts');
