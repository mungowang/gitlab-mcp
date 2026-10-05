import type { ZodRawShape, ZodTypeAny } from 'zod';

// The single abstraction. Adding a tool means adding one of these objects.
// Both front ends consume this same map: src/index.ts registers them as MCP tools, and
// src/cli.ts calls them by name from the shell. That is what keeps the CLI and the MCP
// server from drifting apart.
export type Tool<I = any, R = unknown> = {
  desc: string;
  input?: ZodRawShape;
  /**
   * Return type (an entity envelope). When declared it becomes the MCP outputSchema
   * and the SDK validates structuredContent against it.
   * Do NOT declare it on tools that can return an empty body - a declared output schema
   * requires structuredContent, and an empty response violates it.
   */
  returns?: ZodTypeAny;
  /** Read-only. Exposed as the MCP readOnlyHint annotation so clients can auto-approve. */
  readOnly?: boolean;
  /** Destructive operation (deletes). Exposed as destructiveHint. */
  destructive?: boolean;
  run: (args: I) => Promise<R>;
};
export const defineTool = <I, R>(t: Tool<I, R>): Tool<I, R> => t;

/** Text shown to the model: strings verbatim, empty responses as a readable word, else JSON. */
export function renderResult(out: unknown): string {
  if (typeof out === 'string') return out;
  if (out === undefined || out === null) return 'ok';
  return JSON.stringify(out, null, 2);
}

export function registerAll(
  server: any,
  groups: Record<string, Tool>[],
  opts: { readOnly?: boolean } = {},
) {
  const merged: Record<string, Tool> = Object.assign({}, ...groups); // later wins, so JSON can override code defaults
  for (const [name, t] of Object.entries(merged)) {
    if (opts.readOnly && !t.readOnly) continue;
    server.registerTool(
      name,
      {
        description: t.desc,
        inputSchema: t.input ?? {},
        ...(t.returns ? { outputSchema: t.returns } : {}),
        annotations: { readOnlyHint: !!t.readOnly, ...(t.destructive ? { destructiveHint: true } : {}) },
      },
      async (args: any) => {
        try {
          const out = await t.run(args ?? {});
          const text = renderResult(out);
          if (!t.returns) return { content: [{ type: 'text', text }] };
          // A declared outputSchema requires structuredContent (enforced by the SDK).
          if (typeof out !== 'object' || out === null || Array.isArray(out)) {
            throw new Error(
              `${name} declares \`returns\` but produced an empty or non-object result. ` +
              `MCP output schemas must be objects at the root, and API calls that answer 204 ` +
              `have no body to validate - remove the \`returns\` declaration from this tool. ` +
              `This is an implementation error, not a call error.`,
            );
          }
          return { content: [{ type: 'text', text }], structuredContent: out as Record<string, unknown> };
        } catch (e: any) {
          return { content: [{ type: 'text', text: e?.message ?? String(e) }], isError: true };
        }
      },
    );
  }
}

/** The merged registry, shared by the MCP server and the CLI. */
export function mergeTools(groups: Record<string, Tool>[]): Record<string, Tool> {
  return Object.assign({}, ...groups);
}
