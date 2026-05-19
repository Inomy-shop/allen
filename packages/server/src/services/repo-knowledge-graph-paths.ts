import { spawn } from 'node:child_process';
import { dirname, isAbsolute, normalize, relative } from 'node:path';
import type { Db } from 'mongodb';
import type { RepoContextProvider } from './repo-context-engine.js';
import { firstString } from './repo-knowledge-graph-utils.js';

export async function resolveRepoFromPath(db: Db, pathHint: string | undefined): Promise<Record<string, unknown> | null> {
  if (!pathHint) return null;
  const { ObjectId } = await import('mongodb');
  const direct = await db.collection('repos').findOne({ path: pathHint });
  if (direct) return direct;

  let current = pathHint;
  for (let i = 0; i < 10; i++) {
    const ws = await db.collection('workspaces').findOne({ worktreePath: current }).catch(() => null);
    if (ws?.repoId) {
      const repo = await db.collection('repos').findOne({ _id: new ObjectId(ws.repoId as string) });
      if (repo) return repo;
    }
    const repo = await db.collection('repos').findOne({ path: current });
    if (repo) return repo;
    const parent = dirname(current);
    if (!parent || parent === current || parent === '/') break;
    current = parent;
  }
  return null;
}

export function collectCurrentFiles(state: Record<string, unknown>, prompt?: string): string[] {
  const values: unknown[] = [
    state.changed_files,
    state.changedFiles,
    state.files,
    state.file_paths,
    state.filePaths,
    state.target_files,
    state.targetFiles,
  ];
  const files = new Set<string>();
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) addRepoPathIfLikely(files, String(item ?? ''));
    } else if (typeof value === 'string') {
      for (const item of value.split(/[\s,]+/)) addRepoPathIfLikely(files, item);
    }
  }
  for (const match of String(prompt ?? '').matchAll(/(?:^|[\s"`'(:])([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g)) {
    addRepoPathIfLikely(files, match[1]);
  }
  return Array.from(files).slice(0, 50);
}

function addRepoPathIfLikely(files: Set<string>, value: string): void {
  const trimmed = value.trim().replace(/^["'`]+|["'`,.:;]+$/g, '');
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('..') || !trimmed.includes('/')) return;
  files.add(trimmed);
}

export function normalizeRepoContextProvider(provider?: RepoContextProvider): RepoContextProvider {
  return provider === 'claude' || provider === 'codex' ? provider : 'unknown';
}

export function isInstructionCandidatePath(path: string): boolean {
  const p = path.toLowerCase();
  return p === 'agents.md'
    || p === 'agent.md'
    || p === 'claude.md'
    || p === '.allen.md'
    || p === '.claude/claude.md'
    || p === '.claude/instructions.md'
    || p === '.claude/index.md'
    || p.startsWith('.claude/rules/')
    || p.startsWith('.cursor/rules/')
    || p.startsWith('.codex/')
    || p.startsWith('.agents/');
}

export function isSkillCandidatePath(path: string): boolean {
  const p = path.toLowerCase();
  return /(^|\/)(skills?)\/[^/]+\/skill\.md$/.test(p)
    || p.startsWith('.claude/skills/')
    || p.startsWith('.allen/skills/')
    || p.startsWith('.codex/skills/');
}

export function isModuleRuleCandidatePath(path: string): boolean {
  const p = path.toLowerCase();
  return p.includes('/rules/modules/') || p.startsWith('.claude/rules/modules/') || p.startsWith('.cursor/rules/modules/');
}

export function isProductionKnowledgeCandidatePath(path: string): boolean {
  const p = path.toLowerCase();
  return p.includes('/knowledge/')
    || p.includes('/runbook')
    || p.includes('/runbooks/')
    || p.includes('/production')
    || p.includes('/incident')
    || p.includes('/deployment')
    || p.includes('/operations')
    || p.includes('/migration')
    || p.includes('/data-contract');
}

export function isDocsRunbookCandidatePath(path: string): boolean {
  const p = path.toLowerCase();
  return (p.startsWith('docs/') || p.includes('/docs/') || p.includes('/runbook') || p.includes('/runbooks/'))
    && (p.endsWith('.md') || p.endsWith('.mdx'));
}

export function sourceModuleDir(path: string): string | undefined {
  const parts = path.split('/');
  if (parts[0] === 'src' && parts.length >= 2) return `src/${parts[1]}`;
  if (parts[0] === 'packages' && parts.length >= 2) return `packages/${parts[1]}`;
  if (parts[0] && !parts[0].startsWith('.') && parts.length >= 2 && ['src', 'lib', 'app', 'server', 'ui'].includes(parts[1])) return parts[0];
  return undefined;
}

export function hasMeaningfulRepoPath(pathValue: string | undefined): boolean {
  if (!pathValue) return false;
  const normalized = pathValue.replace(/\/+$/, '');
  return normalized !== '/tmp'
    && normalized !== '/tmp/allen'
    && normalized !== '/var/tmp'
    && normalized !== '/private/tmp';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeRepoRelativePath(pathValue: string): string {
  const normalized = normalize(pathValue.replace(/\\/g, '/'));
  if (!normalized || normalized === '.') return '';
  if (isAbsolute(normalized) || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error('Path must be repo-relative');
  }
  return normalized;
}

export function isPathInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function isGitTracked(repoPath: string, relativePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: repoPath });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

export async function gitLsFiles(repoPath: string): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['ls-files'], { cwd: repoPath });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.on('close', () => resolve(out.split('\n').map((line) => line.trim()).filter(Boolean).sort()));
    proc.on('error', () => resolve([]));
  });
}

export async function gitHeadSha(repoPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.on('close', () => resolve(out.trim() || undefined));
    proc.on('error', () => resolve(undefined));
  });
}
