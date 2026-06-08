/**
 * Design Repo Service
 *
 * Manages `roles`, `isDefaultDesignRepo`, and `designPreviewConfig` fields
 * on the `repos` collection for the Allen Desktop Design Tab. Provides
 * methods for listing design repos, onboarding repos, managing defaults,
 * and handling preview configuration.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Collection, Db } from 'mongodb';
import { resolveRepositoriesDir } from '@allen/engine';
import { DesignPreviewService, type DesignPreviewConfig } from './design-preview.service.js';

const exec = promisify(execFile);

/** Known SSH clone URL for the default ui-designs template repo. */
export const DEFAULT_UI_DESIGNS_CLONE_URL = 'git@github.com:Inomy-shop/ui-designs.git';

/** Known HTTPS clone URL for the default ui-designs template repo. */
export const DEFAULT_UI_DESIGNS_HTTPS_URL = 'https://github.com/Inomy-shop/ui-designs.git';

/** Default local clone directory for ui-designs (under ~/.allen/repositories/). */
export const DEFAULT_UI_DESIGNS_LOCAL_PATH = join(resolveRepositoriesDir(), 'ui-designs');

/** Default preview configuration applied automatically to ui-designs repos. */
const UI_DESIGNS_DEFAULT_PREVIEW_CONFIG = {
  enabled: true,
  workingDirectory: '.',
  installCommand: 'npm i',
  buildCommand: 'npm run build',
  startCommand: 'npm run dev',
  portMode: 'fixed' as const,
  fixedPort: 3001,
  healthCheckPath: '',
  lastValidationStatus: 'unknown' as const,
};

// ── Background clone helper ────────────────────────────────────────────────

async function backgroundCloneIfAbsent(targetPath: string): Promise<void> {
  if (existsSync(targetPath)) return; // already there

  // SSH is primary (standard for private/internal repos); HTTPS is fallback
  let cloneUrl = DEFAULT_UI_DESIGNS_CLONE_URL; // SSH primary
  const sshEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  };
  try {
    await exec(
      'git',
      ['ls-remote', '--exit-code', DEFAULT_UI_DESIGNS_CLONE_URL, 'HEAD'],
      { timeout: 12_000, env: sshEnv },
    );
  } catch {
    cloneUrl = DEFAULT_UI_DESIGNS_HTTPS_URL; // HTTPS fallback
    console.info('[design] SSH not reachable, will use HTTPS for background clone');
  }

  console.info('[design] starting background clone', { cloneUrl, targetPath });
  await exec(
    'git',
    ['clone', cloneUrl, targetPath],
    {
      timeout: 10 * 60 * 1000,
      env: sshEnv,
    },
  );
  console.info('[design] background clone completed', { targetPath });
}

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
      // Update path/cloneUrl when provided (repairs placeholder records)
      if (data.path) {
        updateFields.path = data.path;
        // Promote from placeholder status if applicable
        if (existing.status === 'placeholder') {
          updateFields.status = 'registered';
        }
      }
      if (data.cloneUrl) {
        updateFields.cloneUrl = data.cloneUrl;
      }
      if (data.previewConfig) {
        updateFields.designPreviewConfig = {
          ...data.previewConfig,
          lastValidationStatus: 'unknown',
        };
      } else if (/ui.?designs/i.test(data.name) && !existing.designPreviewConfig) {
        // Auto-attach default preview config for ui-designs repos when none exists
        updateFields.designPreviewConfig = { ...UI_DESIGNS_DEFAULT_PREVIEW_CONFIG };
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
    } else if (/ui.?designs/i.test(data.name)) {
      // Auto-attach default preview config for ui-designs repos
      doc.designPreviewConfig = { ...UI_DESIGNS_DEFAULT_PREVIEW_CONFIG };
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
   * marks it as the default design repo and bakes in the canonical clone URL
   * and default local path. If not found, creates a placeholder entry with
   * those fields already populated. In both cases, spawns a background
   * `git clone` if the target directory is absent.
   */
  async bootstrapUiDesigns(name?: string, localPath?: string): Promise<any> {
    const effectivePath = localPath ?? DEFAULT_UI_DESIGNS_LOCAL_PATH;
    const existing = await this.col.findOne({ name: { $regex: /ui.?designs/i } });

    if (existing) {
      const roles: string[] = existing.roles ?? [];
      if (!roles.includes('design_repo')) {
        roles.push('design_repo');
      }
      const setFields: Record<string, unknown> = {
        isDefaultDesignRepo: true,
        roles,
        cloneUrl: DEFAULT_UI_DESIGNS_CLONE_URL,
        updatedAt: new Date(),
      };
      // Set path if empty or missing
      if (existing.path === '' || !existing.path) {
        setFields.path = effectivePath;
      }
      // Attach default preview config only if the repo has none yet
      if (!existing.designPreviewConfig) {
        setFields.designPreviewConfig = { ...UI_DESIGNS_DEFAULT_PREVIEW_CONFIG };
      }
      await this.col.updateOne(
        { _id: existing._id },
        { $set: setFields },
      );
      backgroundCloneIfAbsent(effectivePath).catch((err: unknown) => {
        console.warn('[design] background clone failed:', (err as Error)?.message ?? String(err));
      });
      console.info('[design] bootstrapped existing ui-designs repo', { repoId: existing._id.toString() });
      return this.col.findOne({ _id: existing._id });
    }

    // No existing repo — create placeholder with known clone URL and default path
    const now = new Date();
    const doc = {
      name: name ?? 'ui-designs',
      path: effectivePath,
      cloneUrl: DEFAULT_UI_DESIGNS_CLONE_URL,
      roles: ['design_repo'],
      isDefaultDesignRepo: true,
      status: existsSync(effectivePath) ? 'registered' : 'placeholder',
      designPreviewConfig: { ...UI_DESIGNS_DEFAULT_PREVIEW_CONFIG },
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.col.insertOne(doc);
    backgroundCloneIfAbsent(effectivePath).catch((err: unknown) => {
      console.warn('[design] background clone failed:', (err as Error)?.message ?? String(err));
    });
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

    // Resolve worktree path: explicit workspaceId (placeholder), or the repo's configured path
    let worktreePath: string;
    if (workspaceId) {
      worktreePath = `/tmp/workspace-${workspaceId}`;
    } else {
      const repo = await this.getRepoById(repoId);
      if (!repo || !repo.path) {
        return {
          status: 'failed',
          logs: ['Repo path not configured — add a local path for this repo before testing preview'],
        };
      }
      worktreePath = repo.path;
    }
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
