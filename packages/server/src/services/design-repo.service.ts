/**
 * Design Repo Service
 *
 * Manages `roles`, `isDefaultDesignRepo`, and `designPreviewConfig` fields
 * on the `repos` collection for the Allen Desktop Design Tab. Provides
 * methods for listing design repos, onboarding repos, managing defaults,
 * and handling preview configuration.
 */

import type { Collection, Db } from 'mongodb';
import { DesignPreviewService, type DesignPreviewConfig } from './design-preview.service.js';

// ── Service ────────────────────────────────────────────────────────────────

export class DesignRepoService {
  private col: Collection;
  private previewService: DesignPreviewService;

  constructor(db: Db) {
    this.col = db.collection('repos');
    this.previewService = new DesignPreviewService();
  }

  /**
   * List all repos with the `design_repo` role or `isDefaultDesignRepo: true`.
   * Pass `includeAll=true` to include repos with any role.
   */
  async listDesignRepos(includeAll?: boolean): Promise<any[]> {
    // includeAll=true returns every registered repo (for source repo selector)
    // includeAll=false (default) returns only repos tagged as design repos
    const query: Record<string, unknown> = includeAll
      ? {}
      : { $or: [{ roles: 'design_repo' }, { isDefaultDesignRepo: true }] };
    return this.col.find(query).sort({ updatedAt: -1 }).toArray();
  }

  /**
   * Get the current default design repo.
   */
  async getDefault(): Promise<any | null> {
    return this.col.findOne({ isDefaultDesignRepo: true });
  }

  /**
   * Get a single repo by its ObjectId string.
   */
  async getRepoById(repoId: string): Promise<any | null> {
    const { ObjectId } = await import('mongodb');
    return this.col.findOne({ _id: new ObjectId(repoId) });
  }

  /**
   * Set the default design repo. Clears the flag on all other repos first,
   * then sets it on the given repo.
   */
  async setDefault(repoId: string): Promise<any> {
    const { ObjectId } = await import('mongodb');
    const oid = new ObjectId(repoId);

    // Use a session for atomicity where available; fall back to sequential ops.
    // Clear all existing defaults, then set the new one.
    await this.col.updateMany(
      { isDefaultDesignRepo: true },
      { $set: { isDefaultDesignRepo: false, updatedAt: new Date() } },
    );
    await this.col.updateOne(
      { _id: oid },
      { $set: { isDefaultDesignRepo: true, updatedAt: new Date() } },
    );

    const updated = await this.col.findOne({ _id: oid });
    console.info('[design] default design repo set', { repoId });
    return updated;
  }

  /**
   * Onboard an existing repo as a design repo. Looks up by `path` first;
   * registers a new record if not found. Adds `roles: ['design_repo']`,
   * optionally sets as default, and optionally attaches previewConfig.
   */
  async onboardRepo(data: {
    path?: string;
    cloneUrl?: string;
    name: string;
    makeDefault?: boolean;
    previewConfig?: DesignPreviewConfig;
  }): Promise<any> {
    const now = new Date();

    let existing: any = null;
    if (data.path) {
      existing = await this.col.findOne({ path: data.path });
    }
    if (!existing && data.name) {
      existing = await this.col.findOne({ name: data.name });
    }

    if (existing) {
      // Add design_repo role if not already present
      const roles: string[] = existing.roles ?? [];
      if (!roles.includes('design_repo')) {
        roles.push('design_repo');
      }
      const updateFields: Record<string, unknown> = {
        roles,
        updatedAt: now,
      };
      if (data.previewConfig) {
        updateFields.designPreviewConfig = {
          ...data.previewConfig,
          lastValidationStatus: 'unknown',
        };
      }
      await this.col.updateOne({ _id: existing._id }, { $set: updateFields });
      const updated = await this.col.findOne({ _id: existing._id });
      if (data.makeDefault) {
        await this.setDefault(existing._id.toString());
        return this.col.findOne({ _id: existing._id });
      }
      console.info('[design] repo onboarded', { repoId: existing._id.toString(), name: data.name });
      return updated;
    }

    // Register new repo entry with design fields
    const doc: Record<string, unknown> = {
      name: data.name,
      path: data.path ?? '',
      cloneUrl: data.cloneUrl,
      roles: ['design_repo'],
      isDefaultDesignRepo: data.makeDefault ?? false,
      status: 'registered',
      createdAt: now,
      updatedAt: now,
    };
    if (data.previewConfig) {
      doc.designPreviewConfig = { ...data.previewConfig, lastValidationStatus: 'unknown' };
    }
    const result = await this.col.insertOne(doc);
    const newRepo = { ...doc, _id: result.insertedId };
    console.info('[design] repo registered', { repoId: result.insertedId.toString(), name: data.name });
    return newRepo;
  }

  /**
   * Bootstrap the ui-designs template repo.
   *
   * If a repo named 'ui-designs' (or matching /ui.?designs/i) already exists,
   * marks it as the default design repo. If not found, creates a placeholder
   * entry with basic design fields.
   *
   * TODO: REQ-039, REQ-040 — full clone/setup logic for new ui-designs repos.
   */
  async bootstrapUiDesigns(name?: string): Promise<any> {
    const existing = await this.col.findOne({ name: { $regex: /ui.?designs/i } });

    if (existing) {
      const roles: string[] = existing.roles ?? [];
      if (!roles.includes('design_repo')) {
        roles.push('design_repo');
      }
      await this.col.updateOne(
        { _id: existing._id },
        { $set: { isDefaultDesignRepo: true, roles, updatedAt: new Date() } },
      );
      console.info('[design] bootstrapped existing ui-designs repo', { repoId: existing._id.toString() });
      return this.col.findOne({ _id: existing._id });
    }

    // No existing repo — create placeholder
    // TODO: REQ-039 — trigger actual git clone / workspace setup after placeholder creation.
    // TODO: REQ-040 — wire up GitHub template clone for new ui-designs repos.
    const now = new Date();
    const doc = {
      name: name ?? 'ui-designs',
      path: '',
      roles: ['design_repo'],
      isDefaultDesignRepo: true,
      status: 'placeholder',
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.col.insertOne(doc);
    console.info('[design] bootstrapped ui-designs placeholder', { repoId: result.insertedId.toString() });
    return { ...doc, _id: result.insertedId };
  }

  /**
   * Get the preview config for a repo.
   */
  async getPreviewConfig(repoId: string): Promise<DesignPreviewConfig | null> {
    const { ObjectId } = await import('mongodb');
    const repo = await this.col.findOne({ _id: new ObjectId(repoId) });
    if (!repo) return null;
    return (repo.designPreviewConfig as DesignPreviewConfig) ?? null;
  }

  /**
   * Validate and save a preview config for a repo.
   * Resets `lastValidationStatus` to 'unknown' on save.
   */
  async savePreviewConfig(repoId: string, config: DesignPreviewConfig): Promise<DesignPreviewConfig> {
    const { ObjectId } = await import('mongodb');

    const validation = this.previewService.validateConfig(config);
    if (!validation.ok) {
      const err = new Error(validation.code ?? 'Invalid preview config') as Error & { code: string; details?: unknown };
      err.code = validation.code ?? 'DESIGN_PREVIEW_INVALID';
      err.details = validation.details;
      throw err;
    }

    const storedConfig: DesignPreviewConfig = {
      ...config,
      lastValidationStatus: 'unknown',
    };
    delete storedConfig.lastValidatedAt;
    delete storedConfig.lastValidationError;

    await this.col.updateOne(
      { _id: new ObjectId(repoId) },
      { $set: { designPreviewConfig: storedConfig, updatedAt: new Date() } },
    );
    console.info('[design] preview config saved', { repoId });
    return storedConfig;
  }

  /**
   * Test the preview config for a repo against an optional workspace worktree.
   */
  async testPreviewConfig(
    repoId: string,
    workspaceId?: string,
  ): Promise<{ status: 'passed' | 'failed'; logs: string[]; previewUrl?: string }> {
    const config = await this.getPreviewConfig(repoId);
    if (!config) {
      return { status: 'failed', logs: ['No preview config found for this repo'] };
    }

    const validation = this.previewService.validateConfig(config);
    if (!validation.ok) {
      return {
        status: 'failed',
        logs: [`Config validation failed: ${validation.code}`],
      };
    }

    // Resolve worktree path from workspaceId if provided
    // For now, use an empty worktree path if no workspace is given
    const worktreePath = workspaceId ? `/tmp/workspace-${workspaceId}` : '';
    const result = await this.previewService.testConfig(config, worktreePath);

    // Update validation status in DB
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(repoId) },
      {
        $set: {
          'designPreviewConfig.lastValidatedAt': new Date(),
          'designPreviewConfig.lastValidationStatus': result.status === 'passed' ? 'passed' : 'failed',
          'designPreviewConfig.lastValidationError': result.status === 'failed'
            ? result.logs[result.logs.length - 1]
            : undefined,
          updatedAt: new Date(),
        },
      },
    );

    return result;
  }
}
