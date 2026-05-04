/**
 * Claude Agents Importer
 *
 * Parses Claude Code sub-agent definitions from a registered repo's
 * `.claude/agents/*.md` files. Each file is a Markdown document with a YAML
 * frontmatter block:
 *
 *     ---
 *     name: my-agent
 *     description: one-line summary
 *     tools: [Read, Write, Bash]
 *     model: sonnet
 *     ---
 *
 *     You are an agent that ...
 *
 * This file is the pure parser + resolver. It never writes to the database —
 * see `agent.routes.ts` for the import/preview endpoints that call into it.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import type { Db, ObjectId } from 'mongodb';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ParsedClaudeAgent {
  /** Agent slug from frontmatter `name`. Required. */
  name: string;
  /** Human-readable description from frontmatter. */
  description: string;
  /** Tool names from frontmatter. Empty array if omitted. */
  tools: string[];
  /** Model hint from frontmatter (e.g. "sonnet", "opus"). */
  model: string;
  /** Markdown body (the system prompt). */
  system: string;
  /** Relative path inside the repo, e.g. ".claude/agents/my-agent.md". */
  sourceFile: string;
  /** SHA-256 of the file contents at parse time. */
  sourceSha: string;
}

export interface ParseError {
  file: string;
  error: string;
}

export interface ScanResult {
  parsed: ParsedClaudeAgent[];
  errors: ParseError[];
}

/**
 * Per-agent verdict from the resolver. `create` means the row will be inserted.
 * Anything else is a skip with a machine-readable reason the UI can display.
 */
export type ImportVerdict =
  | { kind: 'create'; agent: ParsedClaudeAgent }
  | { kind: 'skip:name-collision'; agent: ParsedClaudeAgent; existingAgent: string }
  | { kind: 'skip:already-imported'; agent: ParsedClaudeAgent; existingAgent: string }
  | { kind: 'skip:parse-error'; file: string; error: string };

// ── Parser ───────────────────────────────────────────────────────────────────

const FRONTMATTER_DELIMITER = /^---\s*$/m;

/**
 * Sentinel thrown for `.md` files that clearly aren't agent definitions —
 * they have no YAML frontmatter at all. The caller catches this and skips
 * the file silently instead of reporting a parse error, so repos can keep
 * notes / README / docs inside `.claude/agents/**` without polluting the
 * import preview.
 */
class NotAnAgentFile extends Error {}

/**
 * Split a Markdown file into YAML frontmatter and body.
 * Returns { frontmatter: object, body: string }. Throws `NotAnAgentFile` for
 * files without a leading `---` block (silent skip). Throws a regular Error
 * for files that LOOK like agents but are malformed (reported to the UI).
 */
function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  // Tolerate a UTF-8 BOM at the start of the file.
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  // No frontmatter at all → not an agent file. Silent skip.
  if (!content.startsWith('---')) {
    throw new NotAnAgentFile('no frontmatter');
  }
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throw new NotAnAgentFile('no frontmatter');
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new Error('Unclosed YAML frontmatter (no closing `---` line)');
  }
  const yamlText = lines.slice(1, closeIdx).join('\n');
  const body = lines.slice(closeIdx + 1).join('\n').trim();
  const data = yaml.load(yamlText);
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Frontmatter must be a YAML object');
  }
  return { data: data as Record<string, unknown>, body };
}

/**
 * Parse one `.claude/agents/*.md` file into a ParsedClaudeAgent.
 * Throws with a human-readable message on any validation failure.
 */
function parseClaudeAgentFile(content: string, relPath: string): ParsedClaudeAgent {
  const { data, body } = parseFrontmatter(content);

  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) throw new Error('Frontmatter `name` is required');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Frontmatter \`name\` must be a lowercase slug (got "${name}")`);
  }

  const description = typeof data.description === 'string' ? data.description.trim() : '';

  // tools: accept array of strings, comma-separated string, or missing
  let tools: string[] = [];
  if (Array.isArray(data.tools)) {
    tools = data.tools.filter((t): t is string => typeof t === 'string');
  } else if (typeof data.tools === 'string') {
    tools = data.tools.split(',').map(s => s.trim()).filter(Boolean);
  }

  const model = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : 'sonnet';

  if (!body) throw new Error('Agent file has no body (system prompt is empty)');

  const sourceSha = createHash('sha256').update(content).digest('hex');

  return { name, description, tools, model, system: body, sourceFile: relPath, sourceSha };
}

/**
 * Depth-first walker that yields absolute paths of every `.md` file under
 * `root`, to any depth. Skips hidden directories (anything starting with
 * `.`) other than the root itself, so `.git`, `.cache`, and similar are
 * ignored without an explicit allow list. Broken symlinks and permission
 * errors on individual entries are swallowed — the rest of the walk
 * continues.
 */
function walkMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as ReturnType<typeof readdirSync>;
    } catch {
      continue;
    }
    for (const e of entries as unknown as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>) {
      // Skip hidden directories (except the caller-provided root, which
      // is typically `.claude/agents/` itself).
      if (e.name.startsWith('.') && dir !== root) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(abs);
      }
    }
  }
  return out;
}

/**
 * Scan a registered repo's `.claude/agents/` tree for Claude agent
 * definitions. Recursive — `.md` files at any depth are considered, so
 * repos that organize agents into subfolders (per-team, per-stage, etc.)
 * are fully supported.
 *
 * Returns both the successfully parsed agents and a list of per-file parse
 * errors so the UI can show partial results with inline error messages.
 * Files without YAML frontmatter are silently skipped — they are treated
 * as "not an agent file" (e.g. README.md, scratch notes) rather than as
 * errors. Files that HAVE frontmatter but fail validation DO surface as
 * errors so the operator can fix them.
 *
 * Throws only on hard I/O failures at the top-level directory.
 */
export function scanRepoForClaudeAgents(repoPath: string): ScanResult {
  const agentsDir = join(repoPath, '.claude', 'agents');
  if (!existsSync(agentsDir)) {
    return { parsed: [], errors: [] };
  }

  const stat = statSync(agentsDir);
  if (!stat.isDirectory()) {
    return { parsed: [], errors: [{ file: '.claude/agents', error: 'Not a directory' }] };
  }

  const parsed: ParsedClaudeAgent[] = [];
  const errors: ParseError[] = [];

  for (const absPath of walkMarkdownFiles(agentsDir)) {
    // sourceFile is always the path relative to the repo root, forward-
    // slashed on every platform so it reads consistently in the UI and
    // in the DB. Two agents with the same filename in different
    // subfolders get distinct sourceFile values and therefore distinct
    // "already-imported" keys.
    const relPath = relative(repoPath, absPath).split(sep).join('/');
    try {
      const content = readFileSync(absPath, 'utf-8');
      parsed.push(parseClaudeAgentFile(content, relPath));
    } catch (err) {
      if (err instanceof NotAnAgentFile) continue; // silent skip
      errors.push({ file: relPath, error: (err as Error).message });
    }
  }

  return { parsed, errors };
}

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Decide the verdict for each parsed agent given the current DB state.
 * Pure function — no writes. Called by both the preview and commit endpoints
 * so they always agree on what would happen.
 *
 * Refuse logic:
 *   - name collision (any existing agent shares this slug) → skip:name-collision
 *   - already imported (existing agent has matching sourceRepoId + sourceFile) → skip:already-imported
 *   - otherwise → create
 *
 * "Already imported" is a collision too under the locked D6 decision: re-sync
 * is an explicit per-agent action, not an implicit side effect of bulk import.
 */
export async function resolveImportActions(
  db: Db,
  repoId: ObjectId,
  scan: ScanResult,
): Promise<ImportVerdict[]> {
  const verdicts: ImportVerdict[] = [];

  // Surface parse errors first so the UI can render them inline.
  for (const err of scan.errors) {
    verdicts.push({ kind: 'skip:parse-error', file: err.file, error: err.error });
  }

  if (scan.parsed.length === 0) return verdicts;

  // Load every row that could collide in one query.
  const names = scan.parsed.map(a => a.name);
  const existing = await db.collection('agents').find(
    { $or: [{ name: { $in: names } }, { sourceRepoId: repoId }] },
    { projection: { name: 1, sourceRepoId: 1, sourceFile: 1 } },
  ).toArray();

  const byName = new Map<string, Record<string, unknown>>();
  const bySource = new Map<string, Record<string, unknown>>(); // key: `${sourceRepoId}:${sourceFile}`
  for (const row of existing) {
    byName.set(row.name as string, row);
    if (row.sourceRepoId && row.sourceFile) {
      bySource.set(`${String(row.sourceRepoId)}:${row.sourceFile}`, row);
    }
  }

  for (const agent of scan.parsed) {
    // already-imported check first — if the same repo+file already exists,
    // it's a re-import attempt, not a true name collision.
    const sourceKey = `${String(repoId)}:${agent.sourceFile}`;
    const imported = bySource.get(sourceKey);
    if (imported) {
      verdicts.push({
        kind: 'skip:already-imported',
        agent,
        existingAgent: imported.name as string,
      });
      continue;
    }

    const clash = byName.get(agent.name);
    if (clash) {
      verdicts.push({
        kind: 'skip:name-collision',
        agent,
        existingAgent: clash.name as string,
      });
      continue;
    }

    verdicts.push({ kind: 'create', agent });
  }

  return verdicts;
}
