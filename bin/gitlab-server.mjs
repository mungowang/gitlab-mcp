#!/usr/bin/env node
// Plain-JS entry point so an unsupported Node version fails with a readable message
// instead of a syntax error from the TypeScript sources.
//
// It loads dist/index.js when it exists (what npm ships) and falls back to the TypeScript
// source (what a checkout has). The fallback exists because Node refuses to strip types for
// anything under node_modules - ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING - so the sources
// work in a checkout but never in an installed package. That is the whole reason the published
// package is built even though development needs no build step.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const [major, minor] = process.versions.node.split('.').map(Number);
const MIN_MAJOR = 22, MIN_MINOR = 6;

if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
  process.stderr.write(
    `[gitlab-server] Node >= ${MIN_MAJOR}.${MIN_MINOR} is required (native TypeScript type stripping), ` +
    `but this is ${process.version}. No build step is needed - just upgrade Node.\n`,
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const built = resolve(here, '../dist/index.js');
const source = resolve(here, '../src/index.ts');

if (existsSync(built)) {
  await import(built);
} else if (existsSync(source)) {
  await import(source);
} else {
  process.stderr.write('[gitlab-server] found neither dist/index.js nor src/index.ts - run `npm run build`\n');
  process.exit(1);
}
