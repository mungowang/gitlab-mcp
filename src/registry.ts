import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mergeTools, type Tool } from './tool.ts';
import { entities } from './entities/index.ts';
import { toolsFromJson } from './jsonTools.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TOOLS_DIR = resolve(ROOT, 'tools.d');

/**
 * tools.d/*.json - plugin declarations. Core entities live in src/entities/, plugins here.
 * Loaded by both front ends (MCP server and CLI), so the two can never disagree about which
 * tools exist.
 */
export function loadJsonTools(dir: string = TOOLS_DIR): Record<string, Tool> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    throw new Error(`cannot read the plugin directory ${dir}: ${(err as Error).message}`);
  }
  return Object.assign({}, ...files.map((f) => {
    const file = resolve(dir, f);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`cannot read plugin declaration ${file}: ${(err as Error).message}`);
    }
    let parsed: { tools?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`plugin declaration ${file} is not valid JSON: ${(err as Error).message}`);
    }
    return toolsFromJson(parsed.tools ?? {}, `tools.d/${f}`);
  }));
}

/** Code-declared entities first, JSON declarations last so they win on a name clash. */
export function allTools(): Record<string, Tool> {
  return mergeTools([...entities, loadJsonTools()]);
}
