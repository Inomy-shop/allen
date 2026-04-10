import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Collection, Db } from 'mongodb';
import { scanRepo } from './repo-scanner.js';
import { RepoContextScannerService } from './repo-context-scanner.service.js';

export class RepoService {
  private db: Db;
  private col: Collection;
  private contextScanner: RepoContextScannerService;

  constructor(db: Db) {
    this.db = db;
    this.col = db.collection('repos');
    this.contextScanner = new RepoContextScannerService(db);
  }

  async list(): Promise<Record<string, unknown>[]> {
    return this.col.find({}).sort({ lastUsedAt: -1, createdAt: -1 }).toArray();
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const { ObjectId } = await import('mongodb');
    return this.col.findOne({ _id: new ObjectId(id) });
  }

  async create(body: {
    path: string;
    name?: string;
    description?: string;
    tags?: string[];
  }): Promise<Record<string, unknown>> {
    const repoPath = body.path.trim();

    // Validate path
    if (!repoPath) throw new Error('Path is required');
    if (!existsSync(repoPath)) throw new Error(`Path does not exist: ${repoPath}`);
    if (!statSync(repoPath).isDirectory()) throw new Error(`Path is not a directory: ${repoPath}`);

    // Check uniqueness
    const existing = await this.col.findOne({ path: repoPath });
    if (existing) throw new Error(`Repo already registered at path: ${repoPath}`);

    // Scan
    const scanResult = await scanRepo(repoPath);

    const doc = {
      name: body.name?.trim() || basename(repoPath),
      path: repoPath,
      description: body.description?.trim() || '',
      detected: {
        language: scanResult.language,
        framework: scanResult.framework,
        packageManager: scanResult.packageManager,
        defaultBranch: scanResult.defaultBranch,
        remoteUrl: scanResult.remoteUrl,
      },
      tags: body.tags ?? [],
      defaultWorkflow: undefined,
      context: scanResult.context,
      status: 'active' as const,
      lastUsedAt: undefined,
      executionCount: 0,
      contextScan: { status: 'pending' as const, scannedAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await this.col.insertOne(doc);

    // Fire deep context scan in the background — don't await, don't fail create
    this.contextScanner.scheduleScan(String(result.insertedId)).catch((err) => {
      console.error(`[repos] failed to schedule deep scan for ${result.insertedId}:`, err);
    });

    return { ...doc, _id: result.insertedId };
  }

  /** Trigger a fresh deep context scan for a repo. Async — returns immediately. */
  async rescanContext(id: string): Promise<{ scheduled: boolean; reason?: string }> {
    return this.contextScanner.scheduleScan(id);
  }

  /** Fetch the stored detailed context document for a repo. */
  async getContext(id: string): Promise<Record<string, unknown> | null> {
    const ctx = await this.contextScanner.getByRepoId(id);
    return ctx as unknown as Record<string, unknown> | null;
  }

  /** Fetch context by repo path (used by MCP get_repo_context tool). */
  async getContextByPath(repoPath: string): Promise<Record<string, unknown> | null> {
    const repo = await this.col.findOne({ path: repoPath });
    if (!repo) return null;
    const ctx = await this.contextScanner.getByRepoId(String(repo._id));
    return ctx as unknown as Record<string, unknown> | null;
  }

  async update(id: string, body: {
    name?: string;
    description?: string;
    tags?: string[];
    context?: string;
    defaultWorkflow?: string;
    status?: 'active' | 'archived';
  }): Promise<Record<string, unknown>> {
    const { ObjectId } = await import('mongodb');
    const existing = await this.col.findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('Repo not found');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = body.description.trim();
    if (body.tags !== undefined) updates.tags = body.tags;
    if (body.context !== undefined) updates.context = body.context;
    if (body.defaultWorkflow !== undefined) updates.defaultWorkflow = body.defaultWorkflow;
    if (body.status !== undefined) updates.status = body.status;

    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: updates });
    return { ...existing, ...updates };
  }

  async delete(id: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.deleteOne({ _id: new ObjectId(id) });
    // Cascade-delete the deep context row so we don't leave orphans
    await this.db.collection('repo_contexts').deleteOne({ repoId: id }).catch(() => {});
  }

  /**
   * Trigger a deep scan. Refreshes the heuristic `detected` metadata
   * synchronously, then schedules the agent-driven deep context rebuild
   * in the background. Returns immediately — caller should poll
   * `contextScan.status` on the repo doc or hit GET /:id/context.
   *
   * No shallow path: every explicit scan is a deep scan.
   */
  async scan(id: string): Promise<Record<string, unknown>> {
    const { ObjectId } = await import('mongodb');
    const existing = await this.col.findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('Repo not found');

    // Refresh the cheap heuristic metadata first so the repo list UI is up to date
    const scanResult = await scanRepo(existing.path as string);
    const updates = {
      detected: {
        language: scanResult.language,
        framework: scanResult.framework,
        packageManager: scanResult.packageManager,
        defaultBranch: scanResult.defaultBranch,
        remoteUrl: scanResult.remoteUrl,
      },
      context: scanResult.context,
      updatedAt: new Date(),
    };
    await this.col.updateOne({ _id: new ObjectId(id) }, { $set: updates });

    // Kick off the deep agent scan in the background
    const deepResult = await this.contextScanner.scheduleScan(id);

    return { ...existing, ...updates, deepScan: deepResult };
  }
}
