import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export type CandidateContextFile = {
  path: string;
  title: string;
  sourceHash: string;
  bytes: number;
  kind: 'markdown' | 'mdx' | 'mdc';
};

export type ContextInventory = {
  branch: string;
  ref: string;
  headSha?: string;
  /** true when the best-effort `git fetch origin <branch>` at inventory time succeeded */
  fetchOk: boolean;
  candidates: CandidateContextFile[];
  diagnostics: Array<Record<string, unknown>>;
};

const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;
const DEFAULT_IGNORES = [
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '.next/',
  '.turbo/',
  '.claude/worktrees/',
  '.claude/mcp-servers/node_modules/',
];

export function contextInventoryConfig(): Record<string, unknown> {
  return {
    source: 'git-default-branch-ref',
    ignores: DEFAULT_IGNORES,
    maxContextFileBytes: MAX_CONTEXT_FILE_BYTES,
  };
}

export function resolveDefaultBranchName(repo: Record<string, unknown>): string {
  const detected = isRecord(repo.detected) ? repo.detected : {};
  const raw = firstString(detected.defaultBranch, repo.defaultBranch, repo.branch) ?? 'main';
  return isSafeBranchName(raw) ? raw : 'main';
}

export async function collectDefaultBranchContextFiles(
  repoPath: string,
  defaultBranch: string,
): Promise<ContextInventory> {
  const diagnostics: Array<Record<string, unknown>> = [];
  let fetchOk = false;
  await gitOutput(repoPath, ['fetch', '--quiet', '--prune', 'origin', defaultBranch])
    .then(() => { fetchOk = true; })
    .catch((err) => {
      diagnostics.push({
        code: 'default_branch_fetch_failed',
        severity: 'warn',
        branch: defaultBranch,
        message: `Could not fetch origin/${defaultBranch}; using the freshest locally available ref.`,
        detail: (err as Error).message,
      });
    });

  const resolved = await resolveContextRef(repoPath, defaultBranch, diagnostics);
  const paths = (await gitBuffer(repoPath, ['ls-tree', '-r', '-z', '--name-only', resolved.ref]))
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((path) => /\.(md|mdx|mdc)$/i.test(path))
    .filter((path) => !isIgnoredContextPath(path))
    .sort((a, b) => a.localeCompare(b));

  const candidates: CandidateContextFile[] = [];
  for (const path of paths) {
    const bytes = Number(await gitOutput(repoPath, ['cat-file', '-s', `${resolved.ref}:${path}`]).catch(() => '0'));
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_CONTEXT_FILE_BYTES) continue;
    const content = (await gitBuffer(repoPath, ['show', `${resolved.ref}:${path}`]).catch(() => Buffer.alloc(0))).toString('utf8');
    if (!content.trim()) continue;
    candidates.push({
      path,
      title: markdownTitle(content) ?? path,
      sourceHash: sha256(content),
      bytes,
      kind: path.toLowerCase().endsWith('.mdx') ? 'mdx' : path.toLowerCase().endsWith('.mdc') ? 'mdc' : 'markdown',
    });
  }

  return {
    branch: defaultBranch,
    ref: resolved.ref,
    headSha: resolved.headSha,
    fetchOk,
    candidates,
    diagnostics,
  };
}

/**
 * Best-effort `git rev-parse --verify <ref>^{commit}` — returns the resolved
 * commit SHA, or `undefined` if the ref is unknown or the command fails.
 */
export async function revParse(repoPath: string, ref: string): Promise<string | undefined> {
  return gitOutput(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]).catch(() => undefined);
}

/**
 * Best-effort `git fetch --quiet --prune origin <branch>` — never throws.
 * Shared git plumbing for callers (e.g. the setup service) that only need a
 * fire-and-forget branch fetch without inventory diagnostics.
 */
export async function fetchBranch(repoPath: string, branch: string): Promise<void> {
  await gitOutput(repoPath, ['fetch', '--quiet', '--prune', 'origin', branch]).catch(() => undefined);
}

async function resolveContextRef(
  repoPath: string,
  defaultBranch: string,
  diagnostics: Array<Record<string, unknown>>,
): Promise<{ ref: string; headSha?: string }> {
  const refs = [`origin/${defaultBranch}`, defaultBranch, 'HEAD'];
  for (const ref of refs) {
    const headSha = await gitOutput(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]).catch(() => undefined);
    if (headSha) {
      if (ref !== `origin/${defaultBranch}`) {
        diagnostics.push({
          code: 'default_branch_ref_fallback',
          severity: 'warn',
          branch: defaultBranch,
          ref,
          message: `Using ${ref} for context curation because origin/${defaultBranch} was unavailable.`,
        });
      }
      return { ref, headSha };
    }
  }
  throw new Error(`Cannot resolve a git ref for default branch "${defaultBranch}"`);
}

function isIgnoredContextPath(path: string): boolean {
  return DEFAULT_IGNORES.some((ignored) => path.startsWith(ignored) || path.includes(`/${ignored}`));
}

function markdownTitle(content: string): string | undefined {
  for (const line of content.split('\n').slice(0, 80)) {
    const match = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

export function isSafeBranchName(value: string): boolean {
  return Boolean(value)
    && !/[\s\0~^:?*[\\]/.test(value)
    && !value.includes('..')
    && !value.includes('@{')
    && !value.startsWith('-')
    && !value.endsWith('.');
}

/**
 * Validate and normalise a caller-supplied branch/ref, falling back to the repo's
 * default branch when the requested value is absent or fails safety checks.
 *
 * Accepts bare branch names (`main`, `feature/foo`,
 * `context/knowledge-docs-curation-branch-tfsvp1`) and strips a leading
 * `origin/` prefix so callers may pass either form.
 */
export function resolveRequestedBranch(requested: string | undefined, defaultBranch: string): string {
  if (!requested) return defaultBranch;
  // Strip optional remote prefix — `origin/foo` → `foo`
  const normalized = requested.startsWith('origin/') ? requested.slice('origin/'.length) : requested;
  return isSafeBranchName(normalized) ? normalized : defaultBranch;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await gitBuffer(cwd, args)).toString('utf8').trim();
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd });
    const stdout: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => stdout.push(c));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.on('close', (code) => code === 0 ? resolve(Buffer.concat(stdout)) : reject(new Error(stderr.trim() || `git exited ${code}`)));
    proc.on('error', reject);
  });
}
