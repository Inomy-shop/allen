/**
 * Workspace Service
 * Manages git worktrees, lifecycle hooks, port assignment, and service management.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Db, ObjectId } from 'mongodb';
import { watchWorkspace, unwatchWorkspace } from './workspace-watcher.js';

const exec = promisify(execFile);
const WORKSPACE_BASE = process.env.WORKSPACE_BASE_DIR ?? '/tmp/flowforge-workspaces';
const PORT_RANGE_START = 15000;
const PORT_RANGE_PER_WORKSPACE = 10;

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

export interface WorkspaceConfig {
  _id?: ObjectId;
  repoId: string;
  setupScript: string[];
  cleanupScript: string[];
  prePrScript?: string[];
  services: { name: string; command: string; portOffset: number; healthCheck?: string; env?: Record<string, string> }[];
  envVars?: Record<string, string>;
  autoStart?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── Service ──

export class WorkspaceManager {
  private runningProcesses = new Map<string, ChildProcess>(); // key: workspaceId:serviceName

  constructor(private db: Db) {
    if (!existsSync(WORKSPACE_BASE)) mkdirSync(WORKSPACE_BASE, { recursive: true });
  }

  private get col() { return this.db.collection('workspaces'); }
  private get configCol() { return this.db.collection('workspace_configs'); }

  // ── Port Assignment ──

  async assignBasePort(): Promise<number> {
    const workspaces = await this.col.find({ status: { $ne: 'archived' } }).toArray();
    const usedPorts = new Set(workspaces.map(w => w.basePort as number));
    for (let port = PORT_RANGE_START; ; port += PORT_RANGE_PER_WORKSPACE) {
      if (!usedPorts.has(port)) return port;
    }
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
      // Create worktree
      if (isPr) {
        await exec('git', ['fetch', 'origin', branch], { cwd: repoPath });
        await exec('git', ['worktree', 'add', worktreePath, `origin/${branch}`], { cwd: repoPath });
      } else {
        await exec('git', ['worktree', 'add', '-b', branch, worktreePath, baseBranch], { cwd: repoPath });
      }

      // Load config for this repo
      const ws = await this.get(id);
      if (!ws) return;
      const config = await this.getConfig(ws.repoId);

      if (config && config.setupScript.length > 0) {
        await this.col.updateOne({ _id: oid }, { $set: { status: 'setting_up' } });

        const totalSteps = config.setupScript.length;
        const log: string[] = [];

        for (let i = 0; i < totalSteps; i++) {
          const cmd = config.setupScript[i];
          await this.col.updateOne({ _id: oid }, {
            $set: { setupProgress: { currentStep: i + 1, totalSteps, currentCommand: cmd, log, status: 'running' } },
          });

          try {
            const { stdout, stderr } = await exec('sh', ['-c', cmd], { cwd: worktreePath, env: { ...process.env, ...config.envVars } });
            log.push(`✓ ${cmd}${stdout ? '\n' + stdout.slice(0, 500) : ''}`);
          } catch (err: any) {
            log.push(`✗ ${cmd}\n${err.stderr ?? err.message}`);
            throw err;
          }
        }

        await this.col.updateOne({ _id: oid }, { $set: { 'setupProgress.status': 'completed', 'setupProgress.log': log } });
      }

      // Build service list from config
      const services: WorkspaceService[] = [];
      if (config?.services) {
        const wsDoc = await this.get(id);
        for (const svc of config.services) {
          services.push({
            name: svc.name,
            command: svc.command.replace(/\{port\}/g, String((wsDoc?.basePort ?? PORT_RANGE_START) + svc.portOffset)),
            port: (wsDoc?.basePort ?? PORT_RANGE_START) + svc.portOffset,
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

    const { stdout: nameStatus } = await exec('git', ['diff', '--name-status', `${ws.baseBranch}...HEAD`], { cwd: ws.worktreePath });
    const { stdout: numstat } = await exec('git', ['diff', '--numstat', `${ws.baseBranch}...HEAD`], { cwd: ws.worktreePath });

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

    // Get full diff for each file
    for (const file of files) {
      try {
        const { stdout } = await exec('git', ['diff', `${ws.baseBranch}...HEAD`, '--', file.path], { cwd: ws.worktreePath });
        file.diff = stdout;
      } catch {}
    }

    return { baseBranch: ws.baseBranch, files };
  }

  async listFiles(id: string): Promise<{ path: string; isDir: boolean; status?: string }[]> {
    const ws = await this.get(id);
    if (!ws) throw new Error('Workspace not found');

    // Get all tracked + untracked files via git ls-files
    const { stdout: tracked } = await exec('git', ['ls-files'], { cwd: ws.worktreePath });
    const { stdout: untracked } = await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ws.worktreePath });

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

  async startService(id: string, serviceName: string): Promise<void> {
    const ws = await this.get(id);
    if (!ws) throw new Error('Workspace not found');
    const svc = ws.services.find(s => s.name === serviceName);
    if (!svc) throw new Error(`Service "${serviceName}" not found`);

    const config = await this.getConfig(ws.repoId);
    const svcConfig = config?.services.find(s => s.name === serviceName);
    const env = { ...process.env, ...config?.envVars, ...svcConfig?.env };

    const proc = spawn('sh', ['-c', svc.command], { cwd: ws.worktreePath, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const key = `${id}:${serviceName}`;
    this.runningProcesses.set(key, proc);

    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(id), 'services.name': serviceName },
      { $set: { 'services.$.status': 'starting', 'services.$.pid': proc.pid, 'services.$.startedAt': new Date(), status: 'running' } },
    );

    proc.on('close', () => {
      this.runningProcesses.delete(key);
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
    const key = `${id}:${serviceName}`;
    const proc = this.runningProcesses.get(key);
    if (proc) { proc.kill('SIGTERM'); this.runningProcesses.delete(key); }
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
