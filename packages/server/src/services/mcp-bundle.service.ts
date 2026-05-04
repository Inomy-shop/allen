/**
 * MCP Bundle Service
 *
 * Handles uploaded MCP server bundles (zip files). Extraction, validation,
 * npm install, entry point detection, and orphan cleanup.
 *
 * Storage layout:
 *   mcp-servers/<bundleId>/
 *     bundle/             ← extracted zip contents
 *     meta.json           ← BundleMeta
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Db } from 'mongodb';
import AdmZip from 'adm-zip';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Root dir for all uploaded MCP bundles. Outside git tracking. */
export const MCP_BUNDLES_DIR =
  process.env.MCP_BUNDLES_DIR ?? resolve(__dirname, '..', '..', '..', '..', 'mcp-servers');

/** Absolute path cap: 500MB extracted. Protects against zip bombs. */
const MAX_EXTRACTED_SIZE = 500 * 1024 * 1024;
/** Max file count in a bundle. */
const MAX_FILE_COUNT = 10_000;
/** npm install timeout (ms). */
const NPM_INSTALL_TIMEOUT = 5 * 60 * 1000;
/** Age after which an unlinked bundle is deleted by cleanup cron. */
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

export interface BundleMeta {
  bundleId: string;
  originalName: string;
  uploadedAt: string;         // ISO date
  entry: string;              // relative to bundle/ dir
  candidateEntries: string[]; // all .mjs/.js files at bundle root
  status: 'extracting' | 'installing' | 'ready' | 'failed';
  error?: string;
  serverId?: string;          // set when linked to a server record
  installLog?: string;        // tail of npm install output on failure
}

function ensureBundlesDir() {
  if (!existsSync(MCP_BUNDLES_DIR)) mkdirSync(MCP_BUNDLES_DIR, { recursive: true });
}

function bundleDir(bundleId: string): string {
  return join(MCP_BUNDLES_DIR, bundleId);
}

function bundleExtractedDir(bundleId: string): string {
  return join(bundleDir(bundleId), 'bundle');
}

function metaPath(bundleId: string): string {
  return join(bundleDir(bundleId), 'meta.json');
}

function readMeta(bundleId: string): BundleMeta | null {
  const p = metaPath(bundleId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')) as BundleMeta; }
  catch { return null; }
}

function writeMeta(bundleId: string, meta: BundleMeta): void {
  writeFileSync(metaPath(bundleId), JSON.stringify(meta, null, 2), 'utf-8');
}

/** List .mjs / .js / .cjs files at the top level of the extracted bundle. */
function findCandidateEntries(extractedDir: string): string[] {
  if (!existsSync(extractedDir)) return [];
  const entries: string[] = [];
  const walk = (dir: string, depth: number, prefix: string) => {
    if (depth > 2) return; // only look a couple levels deep
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const st = statSync(full);
      if (st.isFile() && /\.(mjs|js|cjs)$/.test(name)) entries.push(rel);
      else if (st.isDirectory()) walk(full, depth + 1, rel);
    }
  };
  walk(extractedDir, 0, '');
  return entries;
}

/** Detect the best entry point: package.json main → first .mjs/.js at root. */
function detectEntry(extractedDir: string, candidates: string[]): string {
  const pkgPath = join(extractedDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (typeof pkg.main === 'string') {
        const main = pkg.main.replace(/^\.\//, '');
        if (candidates.includes(main)) return main;
      }
    } catch {}
  }
  return candidates[0] ?? '';
}

export class McpBundleService {
  constructor(private db: Db) {
    ensureBundlesDir();
  }

  /**
   * Extract an uploaded zip file into a new bundle directory.
   * Enforces zip-slip protection, size/count caps, and rejects bundles that
   * include node_modules (user must strip it; we install ourselves).
   * Returns the initial meta (status=extracting). Caller should then call
   * runNpmInstall() which updates status to ready or failed.
   */
  async extractZip(zipPath: string, originalName: string): Promise<BundleMeta> {
    const bundleId = randomUUID();
    const dir = bundleDir(bundleId);
    const extracted = bundleExtractedDir(bundleId);
    mkdirSync(extracted, { recursive: true });

    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();

    // Validation pass
    let totalSize = 0;
    let fileCount = 0;
    const resolvedRoot = resolve(extracted);

    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;
      const entryName = entry.entryName;

      // Reject node_modules and .git
      if (entryName.includes('node_modules/') || entryName.startsWith('node_modules/')) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(
          'Bundle contains node_modules/. Please remove it — we run npm install automatically.',
        );
      }
      if (entryName.includes('.git/') || entryName.startsWith('.git/')) {
        continue; // silently skip
      }

      // Zip-slip check: resolved path must stay inside extracted dir
      const targetPath = resolve(extracted, entryName);
      if (!targetPath.startsWith(resolvedRoot + '/') && targetPath !== resolvedRoot) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`Zip entry escapes bundle dir: ${entryName}`);
      }

      fileCount++;
      totalSize += entry.header.size;

      if (fileCount > MAX_FILE_COUNT) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`Too many files in bundle (max ${MAX_FILE_COUNT})`);
      }
      if (totalSize > MAX_EXTRACTED_SIZE) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`Bundle too large when extracted (max ${MAX_EXTRACTED_SIZE / (1024 * 1024)}MB)`);
      }
    }

    // All checks passed — extract
    zip.extractAllTo(extracted, true);

    // Find candidate entries and pick a default
    const candidates = findCandidateEntries(extracted);
    if (candidates.length === 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error('No .mjs/.js/.cjs entry points found in bundle');
    }
    const entry = detectEntry(extracted, candidates);

    const meta: BundleMeta = {
      bundleId,
      originalName,
      uploadedAt: new Date().toISOString(),
      entry,
      candidateEntries: candidates,
      status: 'installing',
    };
    writeMeta(bundleId, meta);

    // Fire npm install in the background — don't await
    this.runNpmInstall(bundleId).catch(err => {
      console.error(`[mcp-bundle] npm install failed for ${bundleId}:`, err);
    });

    return meta;
  }

  /**
   * Run `npm install` inside the bundle directory. Updates meta.status to
   * 'ready' on success or 'failed' on failure. Noop if no package.json.
   */
  private async runNpmInstall(bundleId: string): Promise<void> {
    const extracted = bundleExtractedDir(bundleId);
    const meta = readMeta(bundleId);
    if (!meta) return;

    const pkgPath = join(extracted, 'package.json');
    if (!existsSync(pkgPath)) {
      // No deps to install — mark ready immediately
      meta.status = 'ready';
      writeMeta(bundleId, meta);
      return;
    }

    console.log(`[mcp-bundle] Running npm install in ${extracted}`);

    return new Promise<void>((resolveP) => {
      const proc = spawn('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: extracted,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderrBuf = '';
      let stdoutBuf = '';
      proc.stdout?.on('data', (c: Buffer) => { stdoutBuf += c.toString(); });
      proc.stderr?.on('data', (c: Buffer) => { stderrBuf += c.toString(); });

      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        const m = readMeta(bundleId);
        if (m) {
          m.status = 'failed';
          m.error = 'npm install timeout (5 min)';
          m.installLog = (stdoutBuf + stderrBuf).slice(-2000);
          writeMeta(bundleId, m);
        }
        resolveP();
      }, NPM_INSTALL_TIMEOUT);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        const m = readMeta(bundleId);
        if (m) {
          m.status = 'failed';
          m.error = `Failed to spawn npm: ${err.message}`;
          writeMeta(bundleId, m);
        }
        resolveP();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        const m = readMeta(bundleId);
        if (!m) { resolveP(); return; }
        if (code === 0) {
          m.status = 'ready';
        } else {
          m.status = 'failed';
          m.error = `npm install exited with code ${code}`;
          m.installLog = (stdoutBuf + stderrBuf).slice(-2000);
        }
        writeMeta(bundleId, m);
        console.log(`[mcp-bundle] npm install ${m.status} for ${bundleId}`);
        resolveP();
      });
    });
  }

  getMeta(bundleId: string): BundleMeta | null {
    return readMeta(bundleId);
  }

  /** Get the absolute path to the extracted bundle (used as spawn cwd). */
  getBundlePath(bundleId: string): string {
    return bundleExtractedDir(bundleId);
  }

  /** Get the absolute path to the resolved entry point (used as spawn arg). */
  getEntryPath(bundleId: string): string | null {
    const meta = readMeta(bundleId);
    if (!meta) return null;
    return join(bundleExtractedDir(bundleId), meta.entry);
  }

  setEntry(bundleId: string, entry: string): void {
    const meta = readMeta(bundleId);
    if (!meta) throw new Error('Bundle not found');
    if (!meta.candidateEntries.includes(entry)) {
      throw new Error(`Entry "${entry}" is not a valid candidate`);
    }
    meta.entry = entry;
    writeMeta(bundleId, meta);
  }

  markLinked(bundleId: string, serverId: string): void {
    const meta = readMeta(bundleId);
    if (!meta) return;
    meta.serverId = serverId;
    writeMeta(bundleId, meta);
  }

  delete(bundleId: string): void {
    const dir = bundleDir(bundleId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Delete bundles that were uploaded but never linked to a server,
   * if older than ORPHAN_AGE_MS. Returns count deleted.
   */
  async cleanupOrphans(): Promise<number> {
    ensureBundlesDir();
    let deleted = 0;
    const now = Date.now();
    for (const entry of readdirSync(MCP_BUNDLES_DIR)) {
      const dir = join(MCP_BUNDLES_DIR, entry);
      if (!statSync(dir).isDirectory()) continue;
      const meta = readMeta(entry);
      if (!meta) {
        // No meta = stale/corrupted — delete if older than 1h
        const dirStat = statSync(dir);
        if (now - dirStat.mtimeMs > 60 * 60 * 1000) {
          rmSync(dir, { recursive: true, force: true });
          deleted++;
        }
        continue;
      }
      if (meta.serverId) continue; // linked — keep
      const age = now - new Date(meta.uploadedAt).getTime();
      if (age > ORPHAN_AGE_MS) {
        rmSync(dir, { recursive: true, force: true });
        deleted++;
      }
    }
    return deleted;
  }
}

/**
 * Cron system action factory — deletes orphaned bundles every hour.
 */
export function createMcpBundleCleanupAction(db: Db): {
  name: string;
  description: string;
  run: () => Promise<string>;
} {
  return {
    name: 'mcp-bundle-cleanup',
    description: 'Delete MCP server bundles that were uploaded but never linked to a server (orphans > 24h).',
    async run() {
      const svc = new McpBundleService(db);
      const deleted = await svc.cleanupOrphans();
      return `Deleted ${deleted} orphaned bundle(s)`;
    },
  };
}
