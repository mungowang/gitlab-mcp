import type { ZodTypeAny, ZodRawShape } from 'zod';

/**
 * CLI flag parsing, derived from the same Zod shapes the MCP tools declare.
 *
 * This is what makes "the CLI and the MCP server share one core" real rather than aspirational:
 * the CLI does not carry a second list of flags, so a tool cannot gain a parameter the CLI does
 * not know about. The cost is that input types must stay flag-shaped - see the "no unions" rule
 * in src/types.ts.
 */

export type FlagKind = 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'json';

export type FlagSpec = {
  /** The schema key (camelCase), which is what the tool receives. */
  name: string;
  /** The command-line spelling: `maxPatchChars` and `source_branch` both read as dashes. */
  flag: string;
  kind: FlagKind;
  required: boolean;
  enumValues?: string[];
  itemKind?: FlagKind;
  itemEnumValues?: string[];
  description?: string;
  list: boolean;
};

/**
 * Schema key -> command-line spelling. Underscores become dashes (`source_branch` is the API
 * field name, `--source-branch` is what a person types) and camelCase gains dashes
 * (`maxPatchChars` -> `--max-patch-chars`).
 */
export const flagName = (name: string): string =>
  name.replace(/_/g, '-').replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/** What a typed flag name is compared as, so `--source_branch` and `--source-branch` both work. */
const normaliseFlag = (name: string): string => name.replace(/_/g, '-').toLowerCase();

type Unwrapped = { base: ZodTypeAny; optional: boolean; defaultValue?: unknown; hasDefault: boolean };

function unwrap(type: ZodTypeAny): Unwrapped {
  let cur: any = type;
  let optional = false;
  let hasDefault = false;
  let defaultValue: unknown;
  for (let guard = 0; guard < 10; guard++) {
    const name = cur?._def?.typeName;
    if (name === 'ZodOptional' || name === 'ZodNullable') { optional = true; cur = cur._def.innerType; continue; }
    if (name === 'ZodDefault') {
      const d = cur._def.defaultValue;
      defaultValue = typeof d === 'function' ? d() : d;
      hasDefault = true; optional = true; cur = cur._def.innerType; continue;
    }
    if (name === 'ZodEffects') { cur = cur._def.schema; continue; }
    break;
  }
  return { base: cur, optional, hasDefault, defaultValue };
}

function kindOf(type: ZodTypeAny): { kind: FlagKind; enumValues?: string[]; itemKind?: FlagKind; itemEnumValues?: string[] } {
  const name = (type as any)?._def?.typeName;
  switch (name) {
    case 'ZodString': return { kind: 'string' };
    case 'ZodNumber': return { kind: 'number' };
    case 'ZodBoolean': return { kind: 'boolean' };
    case 'ZodEnum': return { kind: 'enum', enumValues: [...((type as any)._def.values as string[])] };
    case 'ZodLiteral': return { kind: 'enum', enumValues: [String((type as any)._def.value)] };
    case 'ZodArray': {
      const inner = kindOf((type as any)._def.type);
      return { kind: 'array', itemKind: inner.kind, itemEnumValues: inner.enumValues };
    }
    case 'ZodRecord':
    case 'ZodObject':
    case 'ZodAny':
    case 'ZodUnknown':
      return { kind: 'json' };
    default:
      // Anything exotic (a union, a transform) has no flag syntax; asking for JSON is the
      // honest fallback, and zod still validates the parsed value before the call.
      return { kind: 'json' };
  }
}

export function specsFor(shape: ZodRawShape | undefined): FlagSpec[] {
  return Object.entries(shape ?? {}).map(([name, raw]) => {
    const { base, optional, description } = { ...unwrap(raw as ZodTypeAny), description: (raw as ZodTypeAny).description };
    const { kind, enumValues, itemKind, itemEnumValues } = kindOf(base);
    return { name, flag: flagName(name), kind, required: !optional, enumValues, itemKind, itemEnumValues, description, list: kind === 'array' };
  });
}

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

function parseScalar(spec: FlagSpec, kind: FlagKind, raw: string, enumValues?: string[]): unknown {
  switch (kind) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`--${spec.name} expects a number, got '${raw}'`);
      return n;
    }
    case 'boolean': {
      const v = raw.toLowerCase();
      if (TRUTHY.has(v)) return true;
      if (FALSY.has(v)) return false;
      throw new Error(`--${spec.name} expects true or false, got '${raw}'`);
    }
    case 'enum': {
      const values = enumValues ?? [];
      if (!values.includes(raw)) {
        throw new Error(`--${spec.name} must be one of ${values.join(' | ')}, got '${raw}'`);
      }
      return raw;
    }
    case 'json': {
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`--${spec.name} expects JSON, e.g. --${spec.name} '{"a":1}'. Got '${raw}'`);
      }
    }
    default:
      return raw;
  }
}

export type ParsedFlags = { args: Record<string, unknown>; errors: string[] };

/** Plain Levenshtein, used only to make an unknown flag's error useful. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Parse `--flag value` / `--flag=value` / `--no-flag` / bare `--flag` (booleans) against the specs.
 * Every problem is collected, so one run reports all of them instead of one per attempt.
 */
export function parseFlags(argv: string[], specs: FlagSpec[]): ParsedFlags {
  // Both spellings resolve: the dashed command-line form and the schema key as declared.
  const byName = new Map<string, FlagSpec>();
  for (const s of specs) {
    byName.set(s.flag, s);
    byName.set(normaliseFlag(s.flag), s);
    byName.set(s.name, s);
  }
  const args: Record<string, unknown> = {};
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      errors.push(`unexpected argument '${token}' - pass values after a flag, e.g. --project group/app`);
      continue;
    }
    const [rawName, inline] = token.replace(/^--?/, '').split(/=(.*)/s);
    const negated = token.startsWith('--no-');
    const name = negated ? rawName.slice(3) : rawName;
    const spec = byName.get(name);
    if (!spec) {
      const near = specs
        .map((s) => ({ s, d: editDistance(name, s.flag) }))
        .filter((c) => c.d <= 2)
        .sort((a, b) => a.d - b.d)[0];
      errors.push(`unknown flag --${name}${near ? ` - did you mean --${near.s.flag}?` : ''}`);
      continue;
    }
    if (spec.kind !== 'array' && seen.has(spec.name)) {
      errors.push(`--${spec.flag} was given more than once`);
      continue;
    }
    seen.add(spec.name);

    if (spec.kind === 'boolean' && (negated || inline === undefined)) {
      args[spec.name] = inline !== undefined ? parseScalar(spec, 'boolean', inline) : !negated;
      continue;
    }
    if (negated) {
      errors.push(`--no-${spec.flag} is only meaningful for a boolean flag`);
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next.length > 1 && !/^-\d/.test(next))) {
        errors.push(`--${spec.flag} needs a value`);
        continue;
      }
      value = next;
      i++;
    }

    try {
      if (spec.kind === 'array') {
        const parts = value.startsWith('[') ? JSON.parse(value) as unknown[] : value.split(',');
        const itemKind = spec.itemKind ?? 'string';
        const parsed = (Array.isArray(parts) ? parts : [parts]).map(
          (p) => parseScalar(spec, itemKind, String(p), spec.itemEnumValues),
        );
        args[spec.name] = [...((args[spec.name] as unknown[]) ?? []), ...parsed];
      } else {
        args[spec.name] = parseScalar(spec, spec.kind, value, spec.enumValues);
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  for (const spec of specs) {
    if (spec.required && args[spec.name] === undefined) errors.push(`--${spec.flag} is required`);
  }
  return { args, errors };
}

export function flagsHelp(specs: FlagSpec[]): string {
  if (specs.length === 0) return '  (no flags)\n';
  const width = Math.max(...specs.map((s) => s.flag.length + 2));
  return specs.map((s) => {
    const type = s.kind === 'enum' ? (s.enumValues ?? []).join('|')
      : s.kind === 'array' ? `list of ${s.itemKind === 'enum' ? (s.itemEnumValues ?? []).join('|') : s.itemKind}`
      : s.kind;
    const suffix = `${s.required ? '' : '(optional) '}${type}`;
    return `  --${s.flag.padEnd(width)} ${suffix}${s.description ? `\n      ${s.description}` : ''}`;
  }).join('\n') + '\n';
}
