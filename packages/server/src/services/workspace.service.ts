/**
 * Workspace Service
 * Manages git worktrees, lifecycle hooks, port assignment, and service management.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, accessSync, constants as fsConstants } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Db, ObjectId } from 'mongodb';
import { watchWorkspace, unwatchWorkspace } from './workspace-watcher.js';

const exec = promisify(execFile);

/**
 * Resolve the base directory where flowforge git worktrees live. Priority:
 *
 *   1. WORKSPACE_BASE_DIR env var — explicit opt-in, wins over everything.
 *   2. ~/.flowforge/workspaces — persistent, user-owned, survives reboots,
 *      not subject to /tmp sweeping. This is the preferred location in
 *      production.
 *   3. /tmp/flowforge-workspaces — legacy fallback. Only used if home dir
 *      is somehow unwritable (read-only HOME, no HOME env, etc.).
 *
 * We PROACTIVELY create the directory here with the current process's
 * ownership. This avoids the "someone else created /tmp/flowforge-workspaces
 * as root on a prior deploy and now the service user can't write to it"
 * failure class we hit in production.
 */
function resolveWorkspaceBaseDir(): string {
  const envOverride = process.env.WORKSPACE_BASE_DIR;
  if (envOverride) {
    ensureDir(envOverride);
    return envOverride;
  }

  const home = homedir();
  if (home && home !== '/') {
    const homeDir = join(home, '.flowforge', 'workspaces');
    try {
      ensureDir(homeDir);
      // Sanity: can we actually write here?
      accessSync(homeDir, fsConstants.W_OK);
      return homeDir;
    } catch (err) {
      console.warn(
        `[workspace] home-based dir ${homeDir} not writable (${(err as Error).message}); falling back to /tmp`,
      );
    }
  }

  const tmpDir = '/tmp/flowforge-workspaces';
  ensureDir(tmpDir);
  // Sanity: can we actually write here? If not, fail LOUD at startup
  // instead of waiting for a workflow run to cryptically fail later.
  try {
    accessSync(tmpDir, fsConstants.W_OK);
  } catch (err) {
    throw new Error(
      `[workspace] Cannot write to workspace base dir ${tmpDir}: ${(err as Error).message}. ` +
      `Either fix permissions (sudo chown -R <service-user> ${tmpDir}) or set WORKSPACE_BASE_DIR ` +
      `to a user-writable path in your environment.`,
    );
  }
  return tmpDir;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o755 });
  }
}

const WORKSPACE_BASE = resolveWorkspaceBaseDir();
const PORT_RANGE_START = 15000;
const PORT_RANGE_PER_WORKSPACE = 10;
const LOG_RING_SIZE = 2000; // max lines per service

// ── Log Ring Buffer ──

export interface LogLine {
  ts: number;      // epoch ms
  stream: 'stdout' | 'stderr';
  text: string;
}

class LogRingBuffer {
  private buf: LogLine[] = [];
  private listeners = new Set<(line: LogLine) => void>();

  push(line: LogLine) {
    this.buf.push(line);
    if (this.buf.length > LOG_RING_SIZE) this.buf.shift();
    for (const fn of this.listeners) fn(line);
  }

  snapshot(): LogLine[] { return [...this.buf]; }
  subscribe(fn: (line: LogLine) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  clear() { this.buf = []; }
}

// ── Types ──

export interface WorkspaceService {
  name: string;
  command: string;
  port: number;
  pid?: number;
  status: 'stopped' | 'starting' | 'ready' | 'failed';
  healthCheck?: string;
  startedAt?: Date;
}

export interface Workspace {
  _id?: ObjectId;
  name: string;
  repoId: string;
  repoName: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  status: 'creating' | 'setting_up' | 'active' | 'running' | 'archiving' | 'archived' | 'failed';
  source: 'new' | 'pr';
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;
  basePort: number;
  setupProgress?: { currentStep: number; totalSteps: number; currentCommand: string; log: string[]; status: 'running' | 'completed' | 'failed' };
  services: WorkspaceService[];
  terminals: { id: string; name: string; active: boolean }[];
  changedFiles: number;
  ahead: number;
  behind: number;
  lastCommit?: { hash: string; message: string; date: Date };
  chatSessionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnvFile {
  path: string;     // relative path in repo, e.g. ".env", "packages/server/.env"
  content: string;  // content with {port:0}, {port:1} placeholders
}

export interface WorkspaceConfig {
  _id?: ObjectId;
  repoId: string;
  envFiles: EnvFile[];
  setupScript: string[];
  cleanupScript: string[];
  prePrScript?: string[];
  services: { name: string; command: string; portOffset: number; healthCheck?: string }[];
  autoStart?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── Service ──

export class WorkspaceManager {
  private runningProcesses = new Map<string, ChildProcess>(); // key: workspaceId:serviceName
  private serviceLogs = new Map<string, LogRingBuffer>();     // key: workspaceId:serviceName

  constructor(private db: Db) {
    if (!existsSync(WORKSPACE_BASE)) mkdirSync(WORKSPACE_BASE, { recursive: true });
  }

  // ── Log access ──

  getLogBuffer(workspaceId: string, serviceName: string): LogRingBuffer {
    const key = `${workspaceId}:${serviceName}`;
    if (!this.serviceLogs.has(key)) this.serviceLogs.set(key, new LogRingBuffer());
    return this.serviceLogs.get(key)!;
  }

  // ── Stale PID cleanup (call once on boot) ──

  async cleanupStalePids(): Promise<void> {
    const active = await this.col.find({ status: { $in: ['active', 'running'] } }).toArray();
    for (const ws of active) {
      for (const svc of (ws.services ?? []) as WorkspaceService[]) {
        if (svc.status === 'ready' || svc.status === 'starting') {
          const key = `${ws._id!.toString()}:${svc.name}`;
          if (!this.runningProcesses.has(key)) {
            // Process is not tracked in memory — mark stopped
            await this.col.updateOne(
              { _id: ws._id, 'services.name': svc.name },
              { $set: { 'services.$.status': 'stopped', 'services.$.pid': null } },
            );
          }
        }
      }
    }
  }

  private get col() { return this.db.collection('workspaces'); }
  private get configCol() { return this.db.collection('workspace_configs'); }

  // ── Port Assignment ──

  private async isPortFree(port: number): Promise<boolean> {
    const net = await import('net');
    return new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => { server.close(); resolve(true); });
      server.listen(port, '127.0.0.1');
    });
  }

  async assignBasePort(): Promise<number> {
    const workspaces = await this.col.find({ status: { $ne: 'archived' } }).toArray();
    const usedPorts = new Set(workspaces.map(w => w.basePort as number));
    for (let port = PORT_RANGE_START; port < 20000; port += PORT_RANGE_PER_WORKSPACE) {
      if (usedPorts.has(port)) continue;
      // Check all ports in the range are free on the OS
      let allFree = true;
      for (let offset = 0; offset < PORT_RANGE_PER_WORKSPACE; offset++) {
        if (!(await this.isPortFree(port + offset))) { allFree = false; break; }
      }
      if (allFree) return port;
    }
    throw new Error('No free port range available');
  }

  // ── Workspace CRUD ──

  async list(): Promise<Workspace[]> {
    return this.col.find({ status: { $ne: 'archived' } }).sort({ updatedAt: -1 }).toArray() as Promise<Workspace[]>;
  }

  async listAll(): Promise<Workspace[]> {
    return this.col.find({}).sort({ updatedAt: -1 }).limit(50).toArray() as Promise<Workspace[]>;
  }

  async get(id: string): Promise<Workspace | null> {
    const { ObjectId } = await import('mongodb');
    return this.col.findOne({ _id: new ObjectId(id) }) as Promise<Workspace | null>;
  }

  async create(params: { repoId: string; repoName: string; repoPath: string; branch: string; baseBranch: string; name: string; source?: 'new' | 'pr'; prNumber?: number; prTitle?: string; prUrl?: string }): Promise<Workspace> {
    const basePort = await this.assignBasePort();
    const { ObjectId } = await import('mongodb');
    const id = new ObjectId();
    const worktreePath = join(WORKSPACE_BASE, id.toString());

    const workspace: Workspace = {
      _id: id,
      name: params.name,
      repoId: params.repoId,
      repoName: params.repoName,
      repoPath: params.repoPath,
      worktreePath,
      branch: params.branch,
      baseBranch: params.baseBranch,
      status: 'creating',
      source: params.source ?? 'new',
      prNumber: params.prNumber,
      prTitle: params.prTitle,
      prUrl: params.prUrl,
      basePort,
      services: [],
      terminals: [],
      changedFiles: 0,
      ahead: 0,
      behind: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.col.insertOne(workspace);

    // Run creation in background
    this.setupWorkspace(id.toString(), params.repoPath, worktreePath, params.branch, params.baseBranch, params.source === 'pr').catch(err => {
      console.error(`[workspace] Setup failed for ${id}:`, err);
      this.col.updateOne({ _id: id }, { $set: { status: 'failed', 'setupProgress.status': 'failed' } }).catch(() => {});
    });

    return workspace;
  }

  private async setupWorkspace(id: string, repoPath: string, worktreePath: string, branch: string, baseBranch: string, isPr: boolean): Promise<void> {
    const { ObjectId } = await import('mongodb');
    const oid = new ObjectId(id);

    try {
      // Fetch latest from origin so worktree starts from up-to-date base
      await exec('git', ['fetch', 'origin'], { cwd: repoPath }).catch(() => {});

      // Determine base ref: prefer origin/baseBranch, fallback to local baseBranch
      let baseRef = baseBranch;
      try {
        await exec('git', ['rev-parse', '--verify', `origin/${baseBranch}`], { cwd: repoPath });
        baseRef = `origin/${baseBranch}`;
      } catch {} // origin doesn't exist — use local

      // Create worktree
      if (isPr) {
        await exec('git', ['fetch', 'origin', branch], { cwd: repoPath }).catch(() => {});
        await exec('git', ['worktree', 'add', worktreePath, `origin/${branch}`], { cwd: repoPath });
      } else {
        // Delete stale branch if it exists, then create fresh from base
        await exec('git', ['branch', '-D', branch], { cwd: repoPath }).catch(() => {});
        await exec('git', ['worktree', 'add', '-b', branch, worktreePath, baseRef], { cwd: repoPath });
      }

      // Load config for this repo
      const ws = await this.get(id);
      if (!ws) return;
      const config = await this.getConfig(ws.repoId);
      const base = ws.basePort;

      // Helper: replace {port:N} → basePort+N, also {port} → basePort+0
      const resolvePortPlaceholders = (str: string): string =>
        str.replace(/\{port:(\d+)\}/g, (_, n) => String(base + parseInt(n)))
           .replace(/\{port\}/g, String(base));

      // Step 1: Generate .env files from templates BEFORE running scripts
      if (config?.envFiles?.length) {
        for (const envFile of config.envFiles) {
          const content = resolvePortPlaceholders(envFile.content);
          const fullPath = join(worktreePath, envFile.path);
          const dir = dirname(fullPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const { writeFileSync: wf } = await import('node:fs');
          wf(fullPath, content, 'utf-8');
        }
      }

      // Step 2: Run setup scripts
      const allSteps = [
        ...(config?.envFiles?.length ? [`Generate ${config.envFiles.length} .env file(s)`] : []),
        ...(config?.setupScript ?? []),
      ];
      const scriptSteps = config?.setupScript ?? [];

      if (allSteps.length > 0) {
        await this.col.updateOne({ _id: oid }, { $set: { status: 'setting_up' } });
        const log: string[] = [];

        // Log env file generation
        if (config?.envFiles?.length) {
          log.push(`✓ Generated ${config.envFiles.length} .env file(s): ${config.envFiles.map(f => f.path).join(', ')}`);
        }

        for (let i = 0; i < scriptSteps.length; i++) {
          const cmd = resolvePortPlaceholders(scriptSteps[i]);
          const stepNum = (config?.envFiles?.length ? 1 : 0) + i + 1;
          await this.col.updateOne({ _id: oid }, {
            $set: { setupProgress: { currentStep: stepNum, totalSteps: allSteps.length, currentCommand: cmd, log, status: 'running' } },
          });

          try {
            const { stdout } = await exec('sh', ['-c', cmd], { cwd: worktreePath, env: { ...process.env } });
            log.push(`✓ ${cmd}${stdout ? '\n' + stdout.slice(0, 500) : ''}`);
          } catch (err: any) {
            log.push(`✗ ${cmd}\n${err.stderr ?? err.message}`);
            throw err;
          }
        }

        await this.col.updateOne({ _id: oid }, { $set: { 'setupProgress.status': 'completed', 'setupProgress.log': log } });
      }

      // Step 3: Build service list — resolve port placeholders in commands
      const services: WorkspaceService[] = [];
      if (config?.services) {
        for (const svc of config.services) {
          const port = base + svc.portOffset;
          services.push({
            name: svc.name,
            command: resolvePortPlaceholders(svc.command),
            port,
            status: 'stopped',
            healthCheck: svc.healthCheck,
          });
        }
      }

      // Get git state
      const gitState = await this.getGitState(worktreePath, baseBranch);

      await this.col.updateOne({ _id: oid }, {
        $set: { status: 'active', services, ...gitState, updatedAt: new Date() },
      });

      // Start file watcher for live diff
      watchWorkspace(id, worktreePath);

      // Log activity
      await this.logActivity(id, 'workspace_created', { branch, baseBranch });
      if (config?.setupScript?.length) await this.logActivity(id, 'setup_completed');

      // Auto-start services if configured
      if (config?.autoStart && services.length > 0) {
        for (const svc of services) {
          try { await this.startService(id, svc.name); } catch {}
        }
      }
    } catch (err) {
      await this.col.updateOne({ _id: oid }, { $set: { status: 'failed' } });
      throw err;
    }
  }

  async archive(id: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    const ws = await this.get(id);
    if (!ws) return;

    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: { status: 'archiving' } });

    // Stop file watcher
    unwatchWorkspace(id);

    // Stop all services
    for (const svc of ws.services) {
      this.stopService(id, svc.name).catch(() => {});
    }

    // Run cleanup script
    const config = await this.getConfig(ws.repoId);
    if (config?.cleanupScript) {
      for (const cmd of config.cleanupScript) {
        try { await exec('sh', ['-c', cmd], { cwd: ws.worktreePath }); } catch {}
      }
    }

    // Remove worktree
    try { await exec('git', ['worktree', 'remove', ws.worktreePath, '--force'], { cwd: ws.repoPath }); } catch {}

    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: { status: 'archived', updatedAt: new Date() } });
  }

  // ── Git Operations ──

  async getGitState(worktreePath: string, baseBranch: string): Promise<{ changedFiles: number; ahead: number; behind: number; lastCommit?: { hash: string; message: string; date: Date } }> {
    try {
      const { stdout: diffStat } = await exec('git', ['diff', '--stat', `${baseBranch}...HEAD`], { cwd: worktreePath });
      const changedFiles = (diffStat.match(/\d+ file/)?.[0]?.match(/\d+/)?.[0] ?? '0');

      const { stdout: log } = await exec('git', ['log', '-1', '--format=%H|%s|%aI'], { cwd: worktreePath });
      const [hash, message, dateStr] = log.trim().split('|');

      const { stdout: revList } = await exec('git', ['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`], { cwd: worktreePath });
      const [behind, ahead] = revList.trim().split(/\s+/).map(Number);

      return {
        changedFiles: parseInt(changedFiles),
        ahead: ahead ?? 0,
        behind: behind ?? 0,
        lastCommit: hash ? { hash, message, date: new Date(dateStr) } : undefined,
      };
    } catch {
      return { changedFiles: 0, ahead: 0, behind: 0 };
    }
  }

  async getDiff(id: string): Promise<{ baseBranch: string; files: { path: string; status: string; additions: number; deletions: number; diff: string }[] }> {
    const ws = await this.get(id);
    if (!ws) throw new Error('Workspace not found');

    // Show current uncommitted changes (staged + unstaged) — what the developer is actively working on
    const { stdout: nameStatus } = await exec('git', ['diff', '--name-status', 'HEAD'], { cwd: ws.worktreePath }).catch(() => ({ stdout: '' }));
    const { stdout: numstat } = await exec('git', ['diff', '--numstat', 'HEAD'], { cwd: ws.worktreePath }).catch(() => ({ stdout: '' }));

    // Also include untracked new files
    const { stdout: untracked } = await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ws.worktreePath }).catch(() => ({ stdout: '' }));

    const statLines = numstat.trim().split('\n').filter(Boolean);
    const statusLines = nameStatus.trim().split('\n').filter(Boolean);

    const files = statusLines.map((line, i) => {
      const [statusChar, ...pathParts] = line.split('\t');
      const path = pathParts.join('\t');
      const status = statusChar === 'A' ? 'added' : statusChar === 'D' ? 'deleted' : 'modified';
      const statLine = statLines[i] ?? '';
      const [add, del] = statLine.split('\t');
      return { path, status, additions: parseInt(add) || 0, deletions: parseInt(del) || 0, diff: '' };
    });

    // Add untracked files as "added"
    const existingPaths = new Set(files.map(f => f.path));
    for (const f of untracked.trim().split('\n').filter(Boolean)) {
      if (!existingPaths.has(f)) {
        files.push({ path: f, status: 'added', additions: 0, deletions: 0, diff: '' });
      }
    }

    // Get full diff for each file
    for (const file of files) {
      try {
        if (file.status === 'added' && !nameStatus.includes(file.path)) {
          // Untracked file — show full content as diff
          const { readFileSync: rf } = await import('node:fs');
          const content = rf(join(ws.worktreePath, file.path), 'utf-8');
          file.diff = content.split('\n').map(l => `+${l}`).join('\n');
          file.additions = content.split('\n').length;
        } else {
          const { stdout } = await exec('git', ['diff', 'HEAD', '--', file.path], { cwd: ws.worktreePath });
          file.diff = stdout;
        }
      } catch {}
    }

    return { baseBranch: ws.baseBranch, files };
  }

  async listFiles(id: string): Promise<{ path: string; isDir: boolean; status?: string }[]> {
    const ws = await this.get(id);
    if (!ws) throw new Error('Workspace not found');

    // Get all tracked + untracked files (including gitignored .env files)
    const { stdout: tracked } = await exec('git', ['ls-files'], { cwd: ws.worktreePath });
    const { stdout: untracked } = await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ws.worktreePath });
    // Also include .env files even if gitignored — they're important for workspace config
    const { stdout: envFiles } = await exec('sh', ['-c', 'find . -name ".env*" -not -path "*/node_modules/*" -not -path "*/.git/*" | sed "s|^\\./||"'], { cwd: ws.worktreePath }).catch(() => ({ stdout: '' }));

    // Get changed files for status highlighting
    const changedMap = new Map<string, string>();
    try {
      const { stdout: diff } = await exec('git', ['status', '--porcelain'], { cwd: ws.worktreePath });
      for (const line of diff.trim().split('\n').filter(Boolean)) {
        const status = line.substring(0, 2).trim();
        const filePath = line.substring(3);
        changedMap.set(filePath, status === 'A' || status === '?' ? 'added' : status === 'D' ? 'deleted' : 'modified');
      }
    } catch {}

    const allFiles = new Set<string>();
    for (const f of tracked.trim().split('\n').filter(Boolean)) allFiles.add(f);
    for (const f of untracked.trim().split('\n').filter(Boolean)) allFiles.add(f);
    for (const f of envFiles.trim().split('\n').filter(Boolean)) allFiles.add(f);

    // Filter out common noise
    const ignored = ['.git', 'node_modules/', '.DS_Store', 'dist/', '.turbo/'];
    return Array.from(allFiles)
      .filter(f => !ignored.some(ig => f.startsWith(ig) || f.includes(`/${ig}`)))
      .sort()
      .map(f => ({ path: f, isDir: false, status: changedMap.get(f) }));
  }

  async getChangedFiles(id: string): Promise<{ path: string; status: string }[]> {
    const ws = await this.get(id);
    if (!ws) throw new Error('Workspace not found');
    const { stdout } = await exec('git', ['diff', '--name-status', `${ws.baseBranch}...HEAD`], { cwd: ws.worktreePath });
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [s, ...p] = line.split('\t');
      return { path: p.join('\t'), status: s === 'A' ? 'added' : s === 'D' ? 'deleted' : 'modified' };
    });
  }

  async commit(id: string, message: string): Promise<{ hash: string }> {
    const ws = await this.get(id);
    if (!ws) throw new Error('Workspace not found');
    await exec('git', ['add', '-A'], { cwd: ws.worktreePath });
    await exec('git', ['commit', '-m', message], { cwd: ws.worktreePath });
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: ws.worktreePath });
    const gitState = await this.getGitState(ws.worktreePath, ws.baseBranch);
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: { ...gitState, updatedAt: new Date() } });
    await this.logActivity(id, 'commit', { hash: stdout.trim(), message });
    return { hash: stdout.trim() };
  }

  async push(id: string): Promise<void> {
    const ws = await this.get(id);
    if (!ws) throw new Error('Workspace not found');
    await exec('git', ['push', '-u', 'origin', ws.branch], { cwd: ws.worktreePath });
    await this.logActivity(id, 'push', { branch: ws.branch });
  }

  async pull(id: string): Promise<void> {
    const ws = await this.get(id);
    if (!ws) throw new Error('Workspace not found');
    await exec('git', ['pull', 'origin', ws.baseBranch], { cwd: ws.worktreePath });
    const gitState = await this.getGitState(ws.worktreePath, ws.baseBranch);
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: { ...gitState, updatedAt: new Date() } });
  }

  // ── Service Management ──

  /** Extract all port numbers mentioned in a service command string */
  private extractPorts(command: string, assignedPort: number): number[] {
    const ports = new Set<number>([assignedPort]);
    // Match patterns like PORT=15010, --port 15011, --port=15011, WS_PORT=15012
    const patterns = [
      /(?:PORT|port)[=\s]+(\d{4,5})/g,
      /--port[=\s]+(\d{4,5})/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(command)) !== null) {
        const p = parseInt(m[1]);
        if (p >= 1024 && p <= 65535) ports.add(p);
      }
    }
    return [...ports];
  }

  /** Kill any process occupying the given ports */
  private async killPortUsers(ports: number[]): Promise<void> {
    for (const port of ports) {
      try {
        const { stdout } = await exec('lsof', ['-ti', `:${port}`]);
        const pids = stdout.trim().split('\n').filter(Boolean);
        for (const pid of pids) {
          try { process.kill(parseInt(pid), 'SIGKILL'); } catch {}
        }
      } catch {} // lsof returns exit 1 if no matches
    }
    // Brief pause so the OS releases the ports
    await new Promise(r => setTimeout(r, 300));
  }

  async startService(id: string, serviceName: string): Promise<void> {
    const ws = await this.get(id);
    if (!ws) throw new Error('Workspace not found');
    const svc = ws.services.find(s => s.name === serviceName);
    if (!svc) throw new Error(`Service "${serviceName}" not found`);

    // Kill any stale processes occupying the ports this service needs
    const ports = this.extractPorts(svc.command, svc.port);
    await this.killPortUsers(ports);

    // Strip all FlowForge app env vars so the workspace's own .env takes
    // full control via dotenv.config(). Prevents main server's DB URI,
    // master key, tokens, ports, etc. from leaking into workspace services.
    const STRIP = [
      'PORT', 'MONGODB_URI', 'FLOWFORGE_MASTER_KEY', 'FLOWFORGE_API_URL',
      'TERMINAL_WS_PORT', 'WORKSPACE_BASE_DIR',
      'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET',
      'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN',
      'API_PORT', 'UI_PORT',
      'NODE_ENV',
    ];
    const env = { ...process.env };
    for (const key of STRIP) delete env[key];

    const proc = spawn('sh', ['-c', svc.command], { cwd: ws.worktreePath, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const key = `${id}:${serviceName}`;
    this.runningProcesses.set(key, proc);

    // Set up log capture
    const logBuf = this.getLogBuffer(id, serviceName);
    logBuf.clear();

    const pipeLogs = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr') => {
      let partial = '';
      stream.on('data', (chunk: Buffer) => {
        partial += chunk.toString();
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const text of lines) {
          logBuf.push({ ts: Date.now(), stream: name, text });
        }
      });
      stream.on('end', () => {
        if (partial) logBuf.push({ ts: Date.now(), stream: name, text: partial });
      });
    };
    if (proc.stdout) pipeLogs(proc.stdout, 'stdout');
    if (proc.stderr) pipeLogs(proc.stderr, 'stderr');

    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(id), 'services.name': serviceName },
      { $set: { 'services.$.status': 'starting', 'services.$.pid': proc.pid, 'services.$.startedAt': new Date(), status: 'running' } },
    );

    proc.on('close', (code) => {
      this.runningProcesses.delete(key);
      logBuf.push({ ts: Date.now(), stream: 'stderr', text: `[process exited with code ${code}]` });
      this.col.updateOne(
        { _id: new ObjectId(id), 'services.name': serviceName },
        { $set: { 'services.$.status': 'stopped', 'services.$.pid': null } },
      ).catch(() => {});
    });

    // Start health check polling
    if (svc.healthCheck) {
      this.pollHealth(id, serviceName, svc.port, svc.healthCheck);
    } else {
      // No health check — mark ready after 3s
      setTimeout(() => {
        this.col.updateOne(
          { _id: new ObjectId(id), 'services.name': serviceName },
          { $set: { 'services.$.status': 'ready' } },
        ).catch(() => {});
      }, 3000);
    }
  }

  async stopService(id: string, serviceName: string): Promise<void> {
    const ws = await this.get(id);
    const svc = ws?.services.find(s => s.name === serviceName);
    const key = `${id}:${serviceName}`;
    const proc = this.runningProcesses.get(key);

    if (proc && proc.pid) {
      // Kill the entire process group (sh + child processes like node/vite)
      try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
      // Fallback: also kill the shell process directly
      try { proc.kill('SIGTERM'); } catch {}
      this.runningProcesses.delete(key);
    }

    // Fallback: kill any process still occupying this service's ports
    if (svc) {
      const ports = this.extractPorts(svc.command, svc.port);
      await this.killPortUsers(ports);
    }

    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(id), 'services.name': serviceName },
      { $set: { 'services.$.status': 'stopped', 'services.$.pid': null } },
    );
  }

  private async pollHealth(id: string, serviceName: string, port: number, healthCheck: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    const oid = new ObjectId(id);
    let attempts = 0;
    const maxAttempts = 60; // 5 min max

    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`http://localhost:${port}${healthCheck}`);
        if (res.ok) {
          clearInterval(interval);
          await this.col.updateOne({ _id: oid, 'services.name': serviceName }, { $set: { 'services.$.status': 'ready' } });
        }
      } catch {
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          await this.col.updateOne({ _id: oid, 'services.name': serviceName }, { $set: { 'services.$.status': 'failed' } });
        }
      }
    }, 5000);
  }

  // ── Config ──

  async getConfig(repoId: string): Promise<WorkspaceConfig | null> {
    return this.configCol.findOne({ repoId }) as Promise<WorkspaceConfig | null>;
  }

  async saveConfig(repoId: string, config: Partial<WorkspaceConfig>): Promise<void> {
    await this.configCol.updateOne(
      { repoId },
      { $set: { ...config, repoId, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
  }

  // ── Link Chat ──

  async getByChat(chatSessionId: string): Promise<Workspace | null> {
    return this.col.findOne({ chatSessionId, status: { $nin: ['archived', 'failed'] } }) as Promise<Workspace | null>;
  }

  // ── Templates ──

  private get templateCol() { return this.db.collection('workspace_templates'); }

  async listTemplates(): Promise<any[]> {
    return this.templateCol.find({}).sort({ name: 1 }).toArray();
  }

  async saveTemplate(name: string, template: { description?: string; branch: string; baseBranch: string; setupScript: string[]; services: { name: string; command: string; portOffset: number; healthCheck?: string }[]; envVars?: Record<string, string>; autoStart?: boolean }): Promise<void> {
    await this.templateCol.updateOne({ name }, { $set: { ...template, name, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  }

  async deleteTemplate(name: string): Promise<void> {
    await this.templateCol.deleteOne({ name });
  }

  // ── Activity Log ──

  async logActivity(workspaceId: string, action: string, details?: Record<string, unknown>): Promise<void> {
    await this.db.collection('workspace_activity').insertOne({ workspaceId, action, details, timestamp: new Date() });
  }

  async getActivity(workspaceId: string, limit = 50): Promise<any[]> {
    return this.db.collection('workspace_activity').find({ workspaceId }).sort({ timestamp: -1 }).limit(limit).toArray();
  }

  // ── Bulk Operations ──

  async bulkArchive(ids: string[]): Promise<{ archived: number }> {
    let archived = 0;
    for (const id of ids) {
      try { await this.archive(id); archived++; } catch {}
    }
    return { archived };
  }

  async linkChat(id: string, chatSessionId: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: { chatSessionId, updatedAt: new Date() } });
  }
}
