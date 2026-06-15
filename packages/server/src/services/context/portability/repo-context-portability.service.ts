import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { computePackageChecksum, verifyPackageChecksum } from './package-checksum.js';
import { classifyCuratedAction, classifyMandatoryAction } from './portability-clash.js';
import { RepoMandatoryContextService } from '../mandatory/repo-mandatory-context.service.js';

const SCHEMA_VERSION = 1;
const PACKAGE_KIND = 'allen.repo-context-package';
const STALE_CONTEXT_MESSAGE =
  'Imported curated context is saved. Semantic context is stale — Refresh Context from Context Graph before relying on semantic recall. Mandatory context takes effect on new agent runs immediately.';

export class RepoContextPortabilityService {
  private readonly db: Db;
  private readonly mandatorySvc: RepoMandatoryContextService;

  constructor(db: Db) {
    this.db = db;
    this.mandatorySvc = new RepoMandatoryContextService(db);
  }

  /** Preview: how many active curated + enabled mandatory would be exported. */
  async previewExport(repoId: string): Promise<{ repoName: string; curatedCount: number; mandatoryCount: number; schemaVersion: number }> {
    const repo = await this.db.collection('repos').findOne({ _id: new ObjectId(repoId) });
    if (!repo) throw Object.assign(new Error('Repo not found'), { code: 'REPO_NOT_FOUND', statusCode: 404 });
    const curatedCount = await this.db.collection('repo_context_curation_entries').countDocuments({ repoId, inclusion: 'include', active: { $ne: false } });
    const mandatoryCount = await this.db.collection('repo_mandatory_context_mappings').countDocuments({ repoId, enabled: true });
    return { repoName: String(repo.name), curatedCount, mandatoryCount, schemaVersion: SCHEMA_VERSION };
  }

  /** Build the full export package. */
  async buildExport(repoId: string): Promise<Record<string, unknown>> {
    const repo = await this.db.collection('repos').findOne({ _id: new ObjectId(repoId) });
    if (!repo) throw Object.assign(new Error('Repo not found'), { code: 'REPO_NOT_FOUND', statusCode: 404 });
    const repoName = String(repo.name);

    const rawCurated = await this.db.collection('repo_context_curation_entries')
      .find({ repoId, inclusion: 'include', active: { $ne: false } }, { projection: { _id: 0 } })
      .toArray();
    const curatedEntries = rawCurated.map((e) => {
      const { _id: _mid, repoId: _repoId, agentId: _agentId, cogneeSyncStatus: _css, ...rest } = e as Record<string, unknown>;
      return { ...rest, repoName };
    });

    const rawMandatory = await this.db.collection('repo_mandatory_context_mappings')
      .find({ repoId, enabled: true }, { projection: { _id: 0 } })
      .toArray();
    const mandatoryMappings = rawMandatory.map((m) => {
      const { _id: _mid, agentId: _agentId, repoId: _repoId, createdAt: _ca, updatedAt: _ua, lastValidatedAt: _lva, ...rest } = m as Record<string, unknown>;
      return { ...rest, repoName };
    });

    const pkg: Record<string, unknown> = {
      kind: PACKAGE_KIND,
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      sourceRepo: { repoName, sourceRepoId: repoId },
      selection: { curated: true, mandatory: true },
      curatedEntries,
      mandatoryMappings,
      manifest: {
        curatedCount: curatedEntries.length,
        mandatoryCount: mandatoryMappings.length,
        contentSha256: '',
      },
    };

    computePackageChecksum(pkg);
    return pkg;
  }

  /** Preview import: dry-run classification. Writes nothing. */
  async previewImport(targetRepoId: string, pkg: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.validatePackageShape(pkg);
    const targetRepo = await this.db.collection('repos').findOne({ _id: new ObjectId(targetRepoId) });
    if (!targetRepo) throw Object.assign(new Error('Repo not found'), { code: 'REPO_NOT_FOUND', statusCode: 404 });
    const targetRepoName = String(targetRepo.name);
    const packageRepoName = (pkg.sourceRepo as Record<string, unknown>).repoName as string;

    // Detect name mismatch — sourceRepo.repoName is provenance metadata only
    const repoNameMismatch = packageRepoName !== targetRepoName
      ? { source: packageRepoName, target: targetRepoName }
      : null;

    // Package-internal integrity: every entry/mapping repoName must match package's own repoName
    const curatedEntries = (pkg.curatedEntries as Array<Record<string, unknown>>) ?? [];
    const mandatoryMappings = (pkg.mandatoryMappings as Array<Record<string, unknown>>) ?? [];
    for (const entry of curatedEntries) {
      if (entry.repoName !== packageRepoName) {
        throw Object.assign(new Error(`Entry repoName "${entry.repoName}" does not match package repoName "${packageRepoName}"`), { code: 'REPO_NAME_INCONSISTENT_IN_PACKAGE', statusCode: 400 });
      }
    }
    for (const mapping of mandatoryMappings) {
      if (mapping.repoName !== packageRepoName) {
        throw Object.assign(new Error(`Mapping repoName "${mapping.repoName}" does not match package repoName "${packageRepoName}"`), { code: 'REPO_NAME_INCONSISTENT_IN_PACKAGE', statusCode: 400 });
      }
    }

    const checksumValid = verifyPackageChecksum(pkg);

    // Use targetRepoId directly — never resolvedRepo from name lookup.
    // Align with runtime behavior: only classify against active included curated entries and enabled mandatory mappings.
    const existingCurated = await this.db.collection('repo_context_curation_entries').find({ repoId: targetRepoId, inclusion: 'include', active: { $ne: false } }).toArray() as Array<Record<string, unknown>>;
    const existingMandatory = await this.db.collection('repo_mandatory_context_mappings').find({ repoId: targetRepoId, enabled: true }).toArray() as Array<Record<string, unknown>>;

    // Classify curated
    const curatedActions = curatedEntries.map((entry) => {
      const result = classifyCuratedAction(existingCurated, entry);
      return {
        entryId: entry.entryId,
        title: entry.title,
        path: entry.path,
        ...result,
        clashKind: (result as Record<string, unknown>).clashKind ?? null,
        reason: (result as Record<string, unknown>).reason ?? null,
      };
    });

    const curatedSummary = { add: 0, skip_duplicate: 0, skip_clash: 0 };
    for (const a of curatedActions) {
      if (a.action === 'add') curatedSummary.add++;
      else if (a.action === 'skip_duplicate') curatedSummary.skip_duplicate++;
      else if (a.action === 'skip_clash') curatedSummary.skip_clash++;
    }

    // Batch agent lookup — one $in query instead of N findOne calls
    const agentNames = [...new Set(mandatoryMappings.map((m) => String(m.agentName ?? '')).filter(Boolean))];
    const agentDocs = agentNames.length > 0
      ? await this.db.collection('agents').find({ name: { $in: agentNames } }).toArray() as Array<Record<string, unknown>>
      : [];
    const existingAgents = new Set(agentDocs.map((a) => String(a.name)));

    // Pre-group mandatory by agentName — O(n) instead of O(n²) per mapping
    const mandatoryByAgent = new Map<string, Array<Record<string, unknown>>>();
    for (const m of existingMandatory) {
      const key = String(m.agentName ?? '');
      const arr = mandatoryByAgent.get(key) ?? [];
      arr.push(m);
      mandatoryByAgent.set(key, arr);
    }

    // Classify mandatory
    const mandatoryActions = mandatoryMappings.map((mapping) => {
      const agentName = String(mapping.agentName ?? '');
      const agentMappings = mandatoryByAgent.get(agentName) ?? [];
      const result = classifyMandatoryAction(agentMappings, existingAgents.has(agentName), mapping);
      return {
        mappingId: mapping.mappingId,
        agentName: mapping.agentName,
        title: mapping.title,
        sourcePath: mapping.sourcePath ?? null,
        ...result,
        clashKind: (result as Record<string, unknown>).clashKind ?? null,
        reason: (result as Record<string, unknown>).reason ?? null,
      };
    });

    const mandatorySummary = { add: 0, skip_duplicate: 0, skip_clash: 0, skip_missing_agent: 0 };
    for (const a of mandatoryActions) {
      if (a.action === 'add') mandatorySummary.add++;
      else if (a.action === 'skip_duplicate') mandatorySummary.skip_duplicate++;
      else if (a.action === 'skip_clash') mandatorySummary.skip_clash++;
      else if (a.action === 'skip_missing_agent') mandatorySummary.skip_missing_agent++;
    }

    return {
      targetRepo: { _id: targetRepoId, name: targetRepoName },
      repoNameMismatch,
      checksumValid,
      curatedActions,
      mandatoryActions,
      summary: { curated: curatedSummary, mandatory: mandatorySummary },
    };
  }

  /** Apply import: re-runs preview then writes add-only records. */
  async applyImport(targetRepoId: string, pkg: Record<string, unknown>, opts?: { confirmRepoNameMismatch?: boolean }): Promise<Record<string, unknown>> {
    // Re-run preview for server-side re-validation
    const preview = await this.previewImport(targetRepoId, pkg);

    // Enforce mismatch confirmation
    if (preview.repoNameMismatch && !opts?.confirmRepoNameMismatch) {
      const m = preview.repoNameMismatch as { source: string; target: string };
      throw Object.assign(
        new Error(`Package source repo "${m.source}" does not match target repo "${m.target}". Set confirmRepoNameMismatch=true to proceed.`),
        { code: 'REPO_NAME_MISMATCH_REQUIRES_CONFIRMATION', statusCode: 409, repoNameMismatch: preview.repoNameMismatch },
      );
    }

    const checksumValid = preview.checksumValid as boolean;

    const curatedActions = preview.curatedActions as Array<Record<string, unknown>>;
    const mandatoryActions = preview.mandatoryActions as Array<Record<string, unknown>>;

    // targetRepoId is the route param — already verified by previewImport above. Re-fetch to get repoName for insert.
    const targetRepoDoc = await this.db.collection('repos').findOne({ _id: new ObjectId(targetRepoId) });
    if (!targetRepoDoc) throw Object.assign(new Error('Repo not found'), { code: 'REPO_NOT_FOUND', statusCode: 404 });
    const repoName = String(targetRepoDoc.name);

    const curatedEntries = (pkg.curatedEntries as Array<Record<string, unknown>>) ?? [];
    const mandatoryMappings = (pkg.mandatoryMappings as Array<Record<string, unknown>>) ?? [];

    // Insert curated add-only
    let importedCurated = 0;
    const clashes: Array<Record<string, unknown>> = [];
    const missingAgents: string[] = [];

    const now = new Date();
    for (let i = 0; i < curatedActions.length; i++) {
      const action = curatedActions[i];
      if (action.action === 'add') {
        const entry = curatedEntries[i];
        const { _id: _unused, repoId: _rid, repoName: _rn, cogneeSyncStatus: _css, ...rest } = entry as Record<string, unknown>;
        try {
          await this.db.collection('repo_context_curation_entries').insertOne({
            ...rest,
            repoId: targetRepoId,
            repoName,
            cogneeSyncStatus: 'pending',
            createdAt: now,
            updatedAt: now,
          });
          importedCurated++;
        } catch (err: unknown) {
          // E11000: duplicate key race at apply time — a concurrent import beat us. Treat as skip.
          if ((err as { code?: number }).code === 11000) {
            // already exists — continue
          } else {
            throw err;
          }
        }
      } else if (action.action === 'skip_clash') {
        clashes.push({ kind: 'curated', key: action.clashKind, title: action.title, path: action.path });
      }
    }

    // Insert mandatory add-only
    let importedMandatory = 0;
    const skippedCuratedDup = curatedActions.filter((a) => a.action === 'skip_duplicate').length;
    const skippedCuratedClash = curatedActions.filter((a) => a.action === 'skip_clash').length;
    const skippedMandatoryDup = mandatoryActions.filter((a) => a.action === 'skip_duplicate').length;
    const skippedMandatoryClash = mandatoryActions.filter((a) => a.action === 'skip_clash').length;
    const skippedMandatoryMissingAgent = mandatoryActions.filter((a) => a.action === 'skip_missing_agent').length;

    for (let i = 0; i < mandatoryActions.length; i++) {
      const action = mandatoryActions[i];
      const mapping = mandatoryMappings[i];
      if (action.action === 'add') {
        const { _id: _unused, repoId: _rid, repoName: _rn, mappingId: _mid, agentId: _aid, createdAt: _ca, updatedAt: _ua, lastValidatedAt: _lva, ...rest } = mapping as Record<string, unknown>;
        await this.mandatorySvc.upsert(targetRepoId, { ...rest, enabled: true });
        importedMandatory++;
      } else if (action.action === 'skip_clash') {
        clashes.push({ kind: 'mandatory', key: action.clashKind, agentName: action.agentName, title: action.title, sourcePath: action.sourcePath });
      } else if (action.action === 'skip_missing_agent') {
        missingAgents.push(String(action.agentName ?? ''));
      }
    }

    return {
      targetRepo: preview.targetRepo,
      checksumValid,
      imported: { curated: importedCurated, mandatory: importedMandatory },
      skipped: {
        curated: { duplicate: skippedCuratedDup, clash: skippedCuratedClash },
        mandatory: { duplicate: skippedMandatoryDup, clash: skippedMandatoryClash, missing_agent: skippedMandatoryMissingAgent },
      },
      clashes,
      missingAgents: [...new Set(missingAgents)],
      errors: [],
      staleContextMessage: STALE_CONTEXT_MESSAGE,
    };
  }

  private validatePackageShape(pkg: Record<string, unknown>): void {
    if (pkg.kind !== PACKAGE_KIND) {
      throw Object.assign(new Error('Package is not a valid Allen repo-context package'), { code: 'PACKAGE_INVALID', statusCode: 400 });
    }
    if (pkg.schemaVersion !== SCHEMA_VERSION) {
      throw Object.assign(new Error('Package is not a valid Allen repo-context package'), { code: 'PACKAGE_INVALID', statusCode: 400 });
    }
    const sourceRepo = pkg.sourceRepo as Record<string, unknown> | undefined;
    if (!sourceRepo?.repoName || typeof sourceRepo.repoName !== 'string') {
      throw Object.assign(new Error('Package is not a valid Allen repo-context package'), { code: 'PACKAGE_INVALID', statusCode: 400 });
    }
    if (!Array.isArray(pkg.curatedEntries) || !Array.isArray(pkg.mandatoryMappings)) {
      throw Object.assign(new Error('Package is not a valid Allen repo-context package'), { code: 'PACKAGE_INVALID', statusCode: 400 });
    }
  }
}
