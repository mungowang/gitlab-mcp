#!/usr/bin/env node
/**
 * Build the published artefact.
 *
 * Development needs no build: Node runs the TypeScript sources directly and every test does that.
 * Consumers cannot, because Node refuses type stripping for anything under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the package ships this bundle instead and the
 * bin entries prefer dist/ over src/.
 *
 * Dependencies stay external - they are declared in package.json and resolved by npm, not inlined.
 */
import { build } from 'esbuild';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ENTRIES = [
  ['src/index.ts', 'dist/index.js'], // the MCP server
  ['src/cli.ts', 'dist/cli.js'],     // the CLI
];

rmSync(resolve(ROOT, 'dist'), { recursive: true, force: true });
mkdirSync(resolve(ROOT, 'dist'), { recursive: true });

for (const [entry, outfile] of ENTRIES) {
  await build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    sourcemap: false,
    logLevel: 'warning',
  });
  process.stderr.write(`built ${outfile}\n`);
}

// The server reads tools.d/*.json from the package root at startup. The build does not ship them,
// but a build that reports success while that directory is missing would be a lie.
for (const needed of ['tools.d/gitlab-extras.json']) {
  if (!existsSync(resolve(ROOT, needed))) throw new Error(`missing runtime data file: ${needed}`);
}
