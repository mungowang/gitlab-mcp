/**
 * Transport: one function for any path. Auth, timeout, retry and error translation
 * all live here so tool implementations stay one-liners.
 *
 * Targeting GitLab CE 11.3.0 specifically: the API is v4 (v4 exists since 9.0, so it is
 * complete enough), but nothing newer may be assumed. See README "What 11.3.0 does not have".
 */

// Self-hosted instances often use self-signed certificates. The intranet instance this was
// written for is plain HTTP, but a TLS instance must not need a code change.
if (process.env.GITLAB_TLS_REJECT_UNAUTHORIZED === 'false' || process.env.GITLAB_SSL_VERIFY === 'false') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.env.GITLAB_TLS_REJECT_UNAUTHORIZED = 'false';
  process.stderr.write('[gitlab-server] WARN TLS verification disabled (GITLAB_TLS_REJECT_UNAUTHORIZED/GITLAB_SSL_VERIFY=false)\n');
}

const BASE = (process.env.GITLAB_BASE_URL ?? '').replace(/\/+$/, '');
const API = `${BASE}/api/v4`;
const TOKEN = (process.env.GITLAB_TOKEN ?? '').trim();

const TIMEOUT_MS = Number(process.env.GITLAB_TIMEOUT_MS ?? 30_000);
const MAX_RETRIES = Number(process.env.GITLAB_MAX_RETRIES ?? 2);
const RETRY_STATUS = new Set([429, 502, 503, 504]);

export const isDryRun = () => process.env.GITLAB_DRY_RUN === 'true';

/**
 * Why GITLAB_BASE_URL cannot be used, or null when it looks usable.
 *
 * A bad base used to surface as `fetch failed` or `Failed to parse URL from ...`, which says
 * nothing about the cause. A host that injects the base from a secret store can pass the
 * reference through unresolved, and that looks exactly like a typo.
 *
 * The value itself is never echoed: such a host treats the base URL as a credential and masks
 * it in logs, so quoting it would only produce `[redacted]`-style noise.
 */
export function baseUrlProblem(raw: string | undefined = process.env.GITLAB_BASE_URL): string | null {
  const value = (raw ?? '').trim();
  if (value === '') {
    return 'GITLAB_BASE_URL is empty. Set it to the instance root, e.g. http://gitlab.example.com';
  }
  if (value.includes('${')) {
    return 'GITLAB_BASE_URL still contains an unresolved ${...} placeholder. The client passed the '
      + 'reference through instead of resolving it to a value - check how the server is launched '
      + '(a `${env:NAME}` / `${credential:NAME}` reference must be resolved before spawn)';
  }
  if (!/^https?:\/\//i.test(value)) {
    return 'GITLAB_BASE_URL must be an absolute URL starting with http:// or https:// '
      + '(a bare host is not enough, and it is not an /api/v4 path)';
  }
  if (/\/api\/v4\/?$/i.test(value)) {
    return 'GITLAB_BASE_URL must be the instance root, not the API root - drop the trailing /api/v4 '
      + '(this client appends it)';
  }
  try {
    new URL(value);
  } catch {
    return 'GITLAB_BASE_URL is not a parseable URL (check for stray spaces or quotes)';
  }
  return null;
}

/** Same reasoning as baseUrlProblem, for the credential. */
export function tokenProblem(raw: string | undefined = process.env.GITLAB_TOKEN): string | null {
  const value = (raw ?? '').trim();
  if (value === '') {
    return 'GITLAB_TOKEN is empty. Create a personal access token on the instance '
      + '(User Settings -> Access Tokens). On 11.3 the only scope that can read the API is '
      + '`api`, which is also write access - `read_api` does not exist before 12.10, so a '
      + 'read-only token is not an option here. Use a dedicated account, not your own.';
  }
  if (value.includes('${')) {
    return 'GITLAB_TOKEN still contains an unresolved ${...} placeholder. The client passed the '
      + 'reference through instead of resolving it to a value - resolve it before spawn.';
  }
  return null;
}

/** Header name GitLab expects; 11.3 supports both this and a `private_token` query parameter. */
const authHeaders = (): Record<string, string> => (TOKEN ? { 'PRIVATE-TOKEN': TOKEN } : {});

export function resolveUrl(path: string, query?: Record<string, unknown>): string {
  // Absolute URLs and explicit /api/v4 paths pass through; anything else is a short path.
  const full = /^https?:\/\//i.test(path) ? path
    : path.startsWith('/api/v4') ? BASE + path
    : `${API}${path.startsWith('/') ? path : '/' + path}`;
  const qs = query ? buildQuery(query) : '';
  return full + qs;
}

function buildQuery(query: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/**
 * GitLab puts the useful sentence in `message`, as a string, an array, or a hash of arrays.
 * A bare status code tells the model nothing, so this always gets flattened into the text.
 */
export function gitlabMessage(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.slice(0, 400);
  }
  const flatten = (v: unknown): string =>
    typeof v === 'string' ? v
    : Array.isArray(v) ? v.map(flatten).join('; ')
    : v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${flatten(x)}`).join('; ')
    : JSON.stringify(v);
  const obj = parsed as Record<string, unknown>;
  if (obj && typeof obj === 'object') {
    if ('message' in obj) return flatten(obj.message);
    if ('error' in obj) return flatten(obj.error);
    if ('error_description' in obj) return flatten(obj.error_description);
  }
  return body.slice(0, 400);
}

/** Translate a GitLab response into an actionable message. */
export function explain(status: number, body: string, method: string, path: string): string {
  const head = `GitLab ${method} ${path} -> ${status}`;
  const msg = gitlabMessage(body);
  const b = body.slice(0, 400);

  if (status === 401) {
    return `${head}: authentication failed (${msg}). Check GITLAB_TOKEN. A personal access token on `
      + `GitLab 11.3 needs the 'api' scope - 'read_api' does not exist before 12.10, so a read-only `
      + `token is not an option. An expired or revoked token also answers 401.`;
  }
  if (status === 403) {
    return `${head}: permission denied (${msg}). This account cannot perform that action: it may not `
      + `be a member of the project with a high enough role, the branch may be protected, or the `
      + `project may be archived.`;
  }
  if (status === 404) {
    return `${head}: not found (${msg}). GitLab answers 404 - not 403 - for a project this token `
      + `cannot see, and a project given as a path must be percent-encoded (group%2Fapp; this client `
      + `does that for you). So a 404 means: wrong project path or id, wrong iid, or no access. `
      + `To tell those apart, search for the path this token can actually see: `
      + `gitlab_project_search with the project name (GET /projects?search=<name>). `
      + `If the namespace is a person, it is their username, not their display name `
      + `(a user whose display name is "Jane Doe" can have the username "jane").`;
  }
  if (status === 405) {
    return `${head}: the action is not allowed in the current state (${msg}). For a merge this means `
      + `the MR is not mergeable right now: the source and target branches conflict, a required `
      + `pipeline has not passed, or the MR is closed/not open. Re-read the MR's 'merge_status' and `
      + `'state' (gitlab_mr_get) before retrying.`;
  }
  if (status === 406) {
    return `${head}: not acceptable (${msg}). For a merge this usually means the MR was already `
      + `merged, or its source branch no longer exists. Re-read the MR (gitlab_mr_get) - its 'state' `
      + `will say 'merged'.`;
  }
  if (status === 409) {
    return `${head}: conflict (${msg}). Either another open merge request already exists for these `
      + `branches (update that one with gitlab_mr_update instead of creating a second), or the source `
      + `branch head moved since the MR was read (pass the current sha to gitlab_mr_merge).`;
  }
  if (status === 400 || status === 422) {
    if (/position is invalid/i.test(msg)) {
      return `${head}: the diff note position is invalid (${msg}). The line does not exist in the `
        + `current diff, or the diff-version SHAs are stale because the MR gained commits. Call `
        + `gitlab_mr_changes to see the current diff, then retry with a line it lists.`;
    }
    if (/already exists/i.test(msg) && /merge request/i.test(msg)) {
      return `${head}: ${msg}. An MR for these branches is already open - update it with `
        + `gitlab_mr_update rather than creating a second one.`;
    }
    return `${head}: request rejected (${msg}). Check the field names against GitLab 11.3's API - `
      + `newer parameters (draft, reviewer_ids, approval rules) do not exist on this version.`;
  }
  if (status === 429) return `${head}: rate limited, still failing after retries (${msg}).`;
  if (status >= 500) return `${head}: GitLab server error (${msg}).`;
  return `${head}: ${msg || b}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(res: Response | undefined, attempt: number): number {
  const ra = res?.headers.get('retry-after');
  const secs = ra ? Number(ra) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 10_000);
  return Math.min(500 * 2 ** attempt, 4_000);
}

export type Page = {
  page: number;
  perPage: number;
  total: number | null;
  totalPages: number | null;
  nextPage: number | null;
};
export type Paged<T> = { items: T[]; pagination: Page };

type RequestOptions = {
  query?: Record<string, unknown>;
  body?: unknown;
  accept?: string;
  /** Raw body as-is (used by the escape hatch with a pre-serialized payload). */
  rawBody?: string;
};

async function request(method: string, path: string, opts: RequestOptions = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const url = resolveUrl(path, opts.query);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...authHeaders(),
          Accept: opts.accept ?? 'application/json',
          ...((opts.body !== undefined || opts.rawBody !== undefined) ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Network error / timeout: retryable.
      lastErr = err;
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(undefined, attempt)); continue; }
      const why = (err as Error)?.name === 'TimeoutError'
        ? `request did not return within ${TIMEOUT_MS}ms (tune GITLAB_TIMEOUT_MS)`
        : `network error: ${(err as Error)?.message ?? String(err)}`
          + (/fetch failed/i.test((err as Error)?.message ?? '') ? ' - is the VPN connected and the host reachable?' : '');
      throw new Error(`GitLab ${method} ${path}: ${why}`);
    }

    const text = await res.text();
    if (res.ok) return { status: res.status, headers: res.headers, text };

    if (RETRY_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(res, attempt));
      continue;
    }
    throw new Error(explain(res.status, text, method, path));
  }
  throw new Error(`GitLab ${method} ${path}: retries exhausted (${String(lastErr)})`);
}

/** Sanity-check the connection settings, but never for a dry run - that must work without a token. */
function preflight(method: string, path: string): void {
  const base = baseUrlProblem();
  if (base !== null) throw new Error(`GitLab ${method} ${path}: ${base}`);
  const token = tokenProblem();
  if (token !== null) throw new Error(`GitLab ${method} ${path}: ${token}`);
}

export async function gitlab<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  if (isDryRun()) {
    return { dryRun: true, method, url: resolveUrl(path, opts.query), ...(opts.body !== undefined ? { body: opts.body } : {}) } as T;
  }
  preflight(method, path);
  const { text } = await request(method, path, opts);
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * List helper: bounded output plus an explicit statement of what was left out.
 * `items` and `pagination` are the only two keys this client constructs itself, which is why
 * they are the only two an output schema may require.
 */
export async function gitlabList<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<Paged<T>> {
  const perPage = clampPerPage(opts.query?.per_page);
  const page = Number(opts.query?.page ?? 1) || 1;
  const query = { ...opts.query, page, per_page: perPage };

  if (isDryRun()) {
    return {
      items: [],
      pagination: { page, perPage, total: 0, totalPages: 0, nextPage: null },
      ...({ dryRun: true, method, url: resolveUrl(path, query) } as object),
    } as Paged<T>;
  }
  preflight(method, path);
  const { headers, text } = await request(method, path, { ...opts, query });
  const parsed = text ? JSON.parse(text) : [];
  if (!Array.isArray(parsed)) {
    throw new Error(
      `GitLab ${method} ${path}: expected a JSON array, got ${parsed === null ? 'null' : typeof parsed}. ` +
      `This endpoint does not exist on GitLab 11.3, or it needs different parameters.`,
    );
  }
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    items: parsed as T[],
    pagination: {
      page: num('x-page') ?? page,
      perPage: num('x-per-page') ?? perPage,
      total: num('x-total'),
      totalPages: num('x-total-pages'),
      nextPage: num('x-next-page'),
    },
  };
}

/** Plain-text endpoint (raw file content, job trace). Never JSON-parsed. */
export async function gitlabText(path: string, opts: RequestOptions = {}): Promise<{ text: string; contentType: string; status: number }> {
  if (isDryRun()) return { text: '', contentType: 'text/plain', status: 0 };
  preflight('GET', path);
  const { headers, text, status } = await request('GET', path, { ...opts, accept: opts.accept ?? 'text/plain' });
  return { text, contentType: headers.get('content-type') ?? '', status };
}

export function clampPerPage(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 100);
}

/**
 * Drop undefined values, so a request body carries exactly what the caller asked for.
 * This matters on 11.3: sending `labels: null` clears labels, but sending `labels: ""` is a
 * different instruction again, and an accidental key is a silent state change.
 */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
