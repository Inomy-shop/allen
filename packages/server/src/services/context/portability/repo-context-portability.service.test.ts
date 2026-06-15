import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RepoContextPortabilityService } from './repo-context-portability.service.js';
import { computePackageChecksum } from './package-checksum.js';
import { makeCollection, makeDb } from '../../../test-helpers/mock-mongo.js';

// Mock the mandatory context service to avoid complex upsert logic
vi.mock('../mandatory/repo-mandatory-context.service.js', () => ({
  RepoMandatoryContextService: vi.fn().mockImplementation(() => ({
    upsert: vi.fn().mockResolvedValue({ mappingId: 'mock-mapping-id' }),
  })),
}));

// Valid 24-char hex ObjectIds — new ObjectId(REPO_ID) must not throw
const REPO_ID = '507f1f77bcf86cd799439011';
const REPO_ID_2 = '507f1f77bcf86cd799439022';

function makeRepoDoc(id: string, name: string) {
  return {
    _id: { toString: () => id, toHexString: () => id },
    name,
  };
}

function makeCuratedEntry(overrides?: Record<string, unknown>) {
  return {
    entryId: 'entry-1',
    repoId: REPO_ID,
    repoName: 'test-repo',
    title: 'Test Entry',
    path: 'docs/test.md',
    curatedContext: 'Some curated context',
    retrievalText: 'Some retrieval text',
    inclusion: 'include',
    category: 'guideline',
    injectionPolicy: 'snippet',
    agentId: 'agent-id-to-strip',
    cogneeSyncStatus: 'synced',
    ...overrides,
  };
}

function makeMandatoryMapping(overrides?: Record<string, unknown>) {
  return {
    mappingId: 'map-1',
    repoId: REPO_ID,
    repoName: 'test-repo',
    agentName: 'code-reviewer',
    agentId: 'agent-id-to-strip',
    title: 'Review Guide',
    content: 'Review content here',
    contentHash: 'hash-abc',
    enabled: true,
    sourceType: 'agent_generated',
    sourcePath: 'docs/review.md',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeValidPackage(repoName: string, entries: Record<string, unknown>[] = [], mappings: Record<string, unknown>[] = []) {
  const pkg: Record<string, unknown> = {
    kind: 'allen.repo-context-package',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceRepo: { repoName, sourceRepoId: REPO_ID },
    selection: { curated: true, mandatory: true },
    curatedEntries: entries,
    mandatoryMappings: mappings,
    manifest: {
      curatedCount: entries.length,
      mandatoryCount: mappings.length,
      contentSha256: '',
    },
  };
  computePackageChecksum(pkg);
  return pkg;
}

describe('RepoContextPortabilityService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── previewExport ──────────────────────────────────────────────────────────

  describe('previewExport', () => {
    it('returns only active+enabled counts', async () => {
      const curatedCol = makeCollection([
        makeCuratedEntry({ entryId: 'e1', inclusion: 'include' }),
        makeCuratedEntry({ entryId: 'e2', inclusion: 'exclude' }),
        makeCuratedEntry({ entryId: 'e3', inclusion: 'include' }),
      ]);
      const mandatoryCol = makeCollection([
        makeMandatoryMapping({ mappingId: 'm1', enabled: true }),
        makeMandatoryMapping({ mappingId: 'm2', enabled: false }),
      ]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: curatedCol,
        repo_mandatory_context_mappings: mandatoryCol,
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewExport(REPO_ID);
      expect(result.curatedCount).toBe(2); // only inclusion: 'include'
      expect(result.mandatoryCount).toBe(1); // only enabled: true
      expect(result.repoName).toBe('test-repo');
      expect(result.schemaVersion).toBe(1);
    });

    it('throws REPO_NOT_FOUND when repo does not exist', async () => {
      const db = makeDb({ repos: makeCollection() });
      const svc = new RepoContextPortabilityService(db);
      await expect(svc.previewExport(REPO_ID)).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
    });
  });

  // ── buildExport ────────────────────────────────────────────────────────────

  describe('buildExport', () => {
    it('excludes _id from curated rows', async () => {
      const curatedCol = makeCollection([
        { ...makeCuratedEntry(), _id: 'some-mongo-id' },
      ]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: curatedCol,
        repo_mandatory_context_mappings: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const pkg = await svc.buildExport(REPO_ID);
      const entries = pkg.curatedEntries as Array<Record<string, unknown>>;
      expect(entries[0]).not.toHaveProperty('_id');
    });

    it('excludes agentId from curated rows', async () => {
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection([makeCuratedEntry()]),
        repo_mandatory_context_mappings: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const pkg = await svc.buildExport(REPO_ID);
      const entries = pkg.curatedEntries as Array<Record<string, unknown>>;
      // agentId should be set to undefined and therefore not serialized
      expect(entries[0].agentId).toBeUndefined();
    });

    it('excludes agentId from mandatory rows', async () => {
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection([makeMandatoryMapping()]),
      });
      const svc = new RepoContextPortabilityService(db);
      const pkg = await svc.buildExport(REPO_ID);
      const mappings = pkg.mandatoryMappings as Array<Record<string, unknown>>;
      expect(mappings[0].agentId).toBeUndefined();
    });

    it('attaches repoName to every curated row', async () => {
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'my-special-repo')]),
        repo_context_curation_entries: makeCollection([makeCuratedEntry()]),
        repo_mandatory_context_mappings: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const pkg = await svc.buildExport(REPO_ID);
      const entries = pkg.curatedEntries as Array<Record<string, unknown>>;
      expect(entries[0].repoName).toBe('my-special-repo');
    });

    it('attaches repoName to every mandatory row', async () => {
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'my-special-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection([makeMandatoryMapping()]),
      });
      const svc = new RepoContextPortabilityService(db);
      const pkg = await svc.buildExport(REPO_ID);
      const mappings = pkg.mandatoryMappings as Array<Record<string, unknown>>;
      expect(mappings[0].repoName).toBe('my-special-repo');
    });

    it('sets manifest.contentSha256 deterministically', async () => {
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection([makeCuratedEntry()]),
        repo_mandatory_context_mappings: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const pkg = await svc.buildExport(REPO_ID);
      const manifest = pkg.manifest as Record<string, unknown>;
      expect(typeof manifest.contentSha256).toBe('string');
      expect((manifest.contentSha256 as string).length).toBe(64);
      expect(manifest.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('strips createdAt, updatedAt, and lastValidatedAt from mandatory rows', async () => {
      const mappingWithTimestamps = {
        ...makeMandatoryMapping(),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-06-01'),
        lastValidatedAt: new Date('2024-05-01'),
      };
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection([mappingWithTimestamps]),
      });
      const svc = new RepoContextPortabilityService(db);
      const pkg = await svc.buildExport(REPO_ID);
      const mappings = pkg.mandatoryMappings as Array<Record<string, unknown>>;
      expect(mappings[0].createdAt).toBeUndefined();
      expect(mappings[0].updatedAt).toBeUndefined();
      expect(mappings[0].lastValidatedAt).toBeUndefined();
    });
  });

  // ── previewImport ──────────────────────────────────────────────────────────

  describe('previewImport', () => {
    it('uses targetRepoId directly — does not resolve by package repoName', async () => {
      // Package claims source is 'other-repo' but target is identified by route repoId
      const entry = { entryId: 'e-new', repoName: 'other-repo', title: 'New Title', path: 'docs/new.md', curatedContext: 'ctx', retrievalText: 'rt', inclusion: 'include' };
      const pkg = makeValidPackage('other-repo', [entry]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'my-target-repo')]),  // target repo found by ID
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      // Should NOT throw — uses targetRepoId (REPO_ID) directly
      const result = await svc.previewImport(REPO_ID, pkg);
      expect(result.targetRepo).toMatchObject({ _id: REPO_ID, name: 'my-target-repo' });
      expect(result.repoNameMismatch).toEqual({ source: 'other-repo', target: 'my-target-repo' });
    });

    it('returns repoNameMismatch null when source name matches target name', async () => {
      const pkg = makeValidPackage('test-repo');
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      expect(result.repoNameMismatch).toBeNull();
    });

    it('batches agent lookup with a single find call (not N findOne calls)', async () => {
      const m1 = { ...makeMandatoryMapping(), repoName: 'test-repo', agentName: 'code-reviewer', mappingId: 'm1' };
      const m2 = { ...makeMandatoryMapping(), repoName: 'test-repo', agentName: 'backend-developer', mappingId: 'm2' };
      const pkg = makeValidPackage('test-repo', [], [m1, m2]);
      const agentsCol = makeCollection([{ name: 'code-reviewer' }, { name: 'backend-developer' }]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: agentsCol,
      });
      const svc = new RepoContextPortabilityService(db);
      await svc.previewImport(REPO_ID, pkg);
      // find called once with $in, not findOne called twice
      expect(agentsCol.find).toHaveBeenCalledOnce();
      expect(agentsCol.findOne).not.toHaveBeenCalled();
    });

    it('does not require sourceHash in entries', async () => {
      const entry = {
        entryId: 'entry-no-hash',
        repoName: 'test-repo',
        title: 'No Hash Entry',
        path: 'docs/no-hash.md',
        curatedContext: 'content',
        retrievalText: 'retrieval',
        inclusion: 'include',
        // No sourceHash field
      };
      const pkg = makeValidPackage('test-repo', [entry]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      // Should not throw
      const result = await svc.previewImport(REPO_ID, pkg);
      expect(result.curatedActions).toHaveLength(1);
      expect((result.curatedActions as Array<Record<string, unknown>>)[0].action).toBe('add');
    });

    it('classifies exact-duplicate curated entries as skip_duplicate', async () => {
      const entry = makeCuratedEntry({ repoName: 'test-repo' });
      const pkg = makeValidPackage('test-repo', [entry]);
      // Pre-existing entry with same content
      const existingEntry = { ...entry, repoId: REPO_ID };
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection([existingEntry]),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      const actions = result.curatedActions as Array<Record<string, unknown>>;
      expect(actions[0].action).toBe('skip_duplicate');
    });

    it('classifies title clash as skip_clash', async () => {
      const entry = makeCuratedEntry({ repoName: 'test-repo' });
      const pkg = makeValidPackage('test-repo', [entry]);
      // Pre-existing entry with same title but different content
      const existingEntry = {
        ...entry,
        repoId: REPO_ID,
        curatedContext: 'completely different content',
        entryId: 'different-entry-id', // different entryId so falls through to title check
      };
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection([existingEntry]),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      const actions = result.curatedActions as Array<Record<string, unknown>>;
      expect(actions[0].action).toBe('skip_clash');
      expect(actions[0].clashKind).toBe('title');
    });

    it('classifies path clash as skip_clash', async () => {
      const entry = makeCuratedEntry({ repoName: 'test-repo', entryId: 'new-entry-id', title: 'New Title' });
      const pkg = makeValidPackage('test-repo', [entry]);
      // Pre-existing entry with same path but different title
      const existingEntry = {
        repoId: REPO_ID,
        entryId: 'different-entry-id',
        title: 'Different Title',
        path: entry.path,
        curatedContext: 'different content',
        retrievalText: 'different retrieval',
        inclusion: 'include',
      };
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection([existingEntry]),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      const actions = result.curatedActions as Array<Record<string, unknown>>;
      expect(actions[0].action).toBe('skip_clash');
      expect(actions[0].clashKind).toBe('path');
    });

    it('classifies mandatory as skip_missing_agent when agentName not in agents', async () => {
      const mapping = { ...makeMandatoryMapping(), repoName: 'test-repo', agentName: 'nonexistent-agent' };
      const pkg = makeValidPackage('test-repo', [], [mapping]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(), // empty — no agents
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      const actions = result.mandatoryActions as Array<Record<string, unknown>>;
      expect(actions[0].action).toBe('skip_missing_agent');
    });

    it('classifies mandatory exact-duplicate as skip_duplicate', async () => {
      const mapping = { ...makeMandatoryMapping(), repoName: 'test-repo' };
      const pkg = makeValidPackage('test-repo', [], [mapping]);
      // Pre-existing mandatory mapping with same title + contentHash (equivalent content)
      const existingMapping = { ...mapping, repoId: REPO_ID };
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection([existingMapping]),
        agents: makeCollection([{ name: 'code-reviewer' }]),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      const actions = result.mandatoryActions as Array<Record<string, unknown>>;
      expect(actions[0].action).toBe('skip_duplicate');
    });

    it('classifies mandatory title clash as skip_clash', async () => {
      const mapping = { ...makeMandatoryMapping(), repoName: 'test-repo' };
      const pkg = makeValidPackage('test-repo', [], [mapping]);
      // Pre-existing mapping with same title but different content
      const existingMapping = {
        ...mapping,
        repoId: REPO_ID,
        content: 'totally different content',
        contentHash: 'hash-xyz-different',
      };
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection([existingMapping]),
        agents: makeCollection([{ name: 'code-reviewer' }]),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      const actions = result.mandatoryActions as Array<Record<string, unknown>>;
      expect(actions[0].action).toBe('skip_clash');
      expect(actions[0].clashKind).toBe('title');
    });

    it('classifies mandatory sourcePath clash as skip_clash', async () => {
      const mapping = { ...makeMandatoryMapping(), repoName: 'test-repo', title: 'Different Title' };
      const pkg = makeValidPackage('test-repo', [], [mapping]);
      // Pre-existing mapping with same sourcePath but different title and content
      const existingMapping = {
        ...mapping,
        repoId: REPO_ID,
        title: 'Original Title',
        content: 'different content',
        contentHash: 'hash-xyz-different',
      };
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection([existingMapping]),
        agents: makeCollection([{ name: 'code-reviewer' }]),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      const actions = result.mandatoryActions as Array<Record<string, unknown>>;
      expect(actions[0].action).toBe('skip_clash');
      expect(actions[0].clashKind).toBe('sourcePath');
    });

    it('flags checksumValid:false but still returns actions when checksum mismatches', async () => {
      const pkg = makeValidPackage('test-repo');
      // Tamper with the package after checksumming
      (pkg as Record<string, unknown>).schemaVersion = 1; // no change, just to make it still valid shape
      // Tamper the contentSha256 to simulate corruption
      (pkg.manifest as Record<string, unknown>).contentSha256 = 'tampered-checksum-value-not-a-real-hash';
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      expect(result.checksumValid).toBe(false);
      // Still returns actions array
      expect(Array.isArray(result.curatedActions)).toBe(true);
      expect(Array.isArray(result.mandatoryActions)).toBe(true);
    });

    it('ignores inactive curated entries (active:false) when classifying — treats import entry as add', async () => {
      // An existing entry with the same entryId/title as the import but active:false
      const inactiveExisting = {
        repoId: REPO_ID,
        entryId: 'e-clash',
        title: 'Title Clash',
        path: 'docs/clash.md',
        curatedContext: 'old ctx',
        retrievalText: 'old rt',
        inclusion: 'include',
        active: false,
      };
      const importEntry = {
        repoName: 'test-repo',
        entryId: 'e-clash',
        title: 'Title Clash',
        path: 'docs/clash.md',
        curatedContext: 'old ctx',
        retrievalText: 'old rt',
        inclusion: 'include',
      };
      const pkg = makeValidPackage('test-repo', [importEntry]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection([inactiveExisting]),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      // Active:false entry is excluded from existingCurated — no clash, should be 'add'
      expect((result.curatedActions as Array<Record<string, unknown>>)[0].action).toBe('add');
    });

    it('ignores disabled mandatory mappings (enabled:false) when classifying — treats import mapping as add', async () => {
      const disabledExisting = makeMandatoryMapping({
        repoId: REPO_ID,
        mappingId: 'm-disabled',
        agentName: 'code-reviewer',
        title: 'Review Guide',
        enabled: false,
      });
      const importMapping = {
        ...makeMandatoryMapping(),
        repoName: 'test-repo',
        mappingId: 'm-new',
        agentName: 'code-reviewer',
        title: 'Review Guide',
      };
      const pkg = makeValidPackage('test-repo', [], [importMapping]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection([disabledExisting]),
        agents: makeCollection([{ name: 'code-reviewer' }]),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      // Disabled existing mapping is excluded from existingMandatory — no clash, should be 'add'
      expect((result.mandatoryActions as Array<Record<string, unknown>>)[0].action).toBe('add');
    });

    it('undefined entryId on import entry does not false-match existing entry with undefined entryId', async () => {
      // Existing entry has no entryId field
      const existingNoId = {
        repoId: REPO_ID,
        title: 'Different Title',
        path: 'docs/different.md',
        curatedContext: 'ctx',
        retrievalText: 'rt',
        inclusion: 'include',
        active: true,
      };
      // Import entry also has no entryId but different title+path — should be 'add'
      const importEntry = {
        repoName: 'test-repo',
        title: 'New Unique Title',
        path: 'docs/unique-new.md',
        curatedContext: 'ctx2',
        retrievalText: 'rt2',
        inclusion: 'include',
      };
      const pkg = makeValidPackage('test-repo', [importEntry]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection([existingNoId]),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.previewImport(REPO_ID, pkg);
      // Should be 'add' — different title+path, undefined entryId must not match
      expect((result.curatedActions as Array<Record<string, unknown>>)[0].action).toBe('add');
    });
  });

  // ── applyImport ────────────────────────────────────────────────────────────

  describe('applyImport', () => {
    it('only inserts add records — no overwrites', async () => {
      const entry = makeCuratedEntry({ repoName: 'test-repo' });
      const pkg = makeValidPackage('test-repo', [entry]);
      // Pre-existing entry with same content → skip_duplicate, no insert
      const existingEntry = { ...entry, repoId: REPO_ID };
      const curatedCol = makeCollection([existingEntry]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: curatedCol,
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.applyImport(REPO_ID, pkg);
      expect((result.imported as Record<string, number>).curated).toBe(0);
      expect(curatedCol.insertOne).not.toHaveBeenCalled();
    });

    it('writes target repoId, never source repoId from package entry', async () => {
      // The package entry contains a foreign repoId (simulating what a real import
      // package would look like if someone included a repoId field from a different instance).
      // The import logic must strip the source repoId and write the resolved target repoId.
      const FAKE_SOURCE_REPO_ID = '999999999999999999999999';
      const entry = makeCuratedEntry({
        repoName: 'test-repo',
        entryId: 'new-entry-unique',
        repoId: FAKE_SOURCE_REPO_ID, // foreign repoId that must NOT end up in the insert
      });
      const pkg = makeValidPackage('test-repo', [entry]);
      const curatedCol = makeCollection();
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: curatedCol,
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      await svc.applyImport(REPO_ID, pkg);
      // insertOne should have been called
      expect(curatedCol.insertOne).toHaveBeenCalled();
      const insertedDoc = (curatedCol.insertOne.mock.calls[0][0] as Record<string, unknown>);
      // Must use resolved repoId, not the fake source repoId from the package entry
      expect(insertedDoc.repoId).toBe(REPO_ID);
      expect(insertedDoc.repoId).not.toBe(FAKE_SOURCE_REPO_ID);
    });

    it('does not create any audit collection rows', async () => {
      const entry = makeCuratedEntry({ repoName: 'test-repo', entryId: 'audit-test-entry' });
      const pkg = makeValidPackage('test-repo', [entry]);
      // We verify no extra collections were written by tracking a fake audit collection
      const auditCol = makeCollection();
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
        context_import_audit: auditCol, // should never be written to
      });
      const svc = new RepoContextPortabilityService(db);
      await svc.applyImport(REPO_ID, pkg);
      expect(auditCol.insertOne).not.toHaveBeenCalled();
    });

    it('returns stale-context message verbatim', async () => {
      const pkg = makeValidPackage('test-repo');
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.applyImport(REPO_ID, pkg);
      expect(result.staleContextMessage).toBe(
        'Imported curated context is saved. Semantic context is stale — Refresh Context from Context Graph before relying on semantic recall. Mandatory context takes effect on new agent runs immediately.',
      );
    });

    it('surfaces clashes in result.clashes', async () => {
      const entry = makeCuratedEntry({ repoName: 'test-repo', entryId: 'clash-entry' });
      const pkg = makeValidPackage('test-repo', [entry]);
      // Pre-existing entry with same entryId but different content
      const existingEntry = {
        ...entry,
        repoId: REPO_ID,
        curatedContext: 'completely different content',
      };
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection([existingEntry]),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.applyImport(REPO_ID, pkg);
      const clashes = result.clashes as Array<Record<string, unknown>>;
      expect(clashes.length).toBeGreaterThan(0);
      expect(clashes[0].kind).toBe('curated');
    });

    it('inserts new entries and returns correct imported counts', async () => {
      const entry = makeCuratedEntry({ repoName: 'test-repo', entryId: 'brand-new-entry', title: 'Brand New' });
      const pkg = makeValidPackage('test-repo', [entry]);
      const curatedCol = makeCollection();
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: curatedCol,
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.applyImport(REPO_ID, pkg);
      expect((result.imported as Record<string, number>).curated).toBe(1);
      expect(curatedCol.insertOne).toHaveBeenCalledOnce();
    });

    it('re-runs preview server-side: clash sneaked in after preview is still skipped on apply', async () => {
      // Entry starts as "add" in preview, but by apply time a clash exists
      const entry = makeCuratedEntry({ repoName: 'test-repo', entryId: 'sneaky-entry', title: 'Sneaky Entry' });
      const pkg = makeValidPackage('test-repo', [entry]);
      // At apply time, a row with same entryId already exists (simulating a race)
      const existingEntry = { ...entry, repoId: REPO_ID, curatedContext: 'different content already here' };
      const curatedCol = makeCollection([existingEntry]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: curatedCol,
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.applyImport(REPO_ID, pkg);
      // Server re-ran preview before writing → clash detected → not inserted
      expect((result.imported as Record<string, number>).curated).toBe(0);
      expect(curatedCol.insertOne).not.toHaveBeenCalled();
      const clashes = result.clashes as Array<Record<string, unknown>>;
      expect(clashes.length).toBeGreaterThan(0);
    });

    it('surfaces missing agents in result.missingAgents', async () => {
      const mapping = { ...makeMandatoryMapping(), repoName: 'test-repo', agentName: 'ghost-agent' };
      const pkg = makeValidPackage('test-repo', [], [mapping]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(), // empty — no matching agent
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.applyImport(REPO_ID, pkg);
      const missingAgents = result.missingAgents as string[];
      expect(missingAgents).toContain('ghost-agent');
      expect((result.skipped as Record<string, Record<string, number>>).mandatory.missing_agent).toBe(1);
    });

    it('throws REPO_NAME_MISMATCH_REQUIRES_CONFIRMATION when mismatch and no confirm', async () => {
      const entry = { entryId: 'e1', repoName: 'source-repo', title: 'T', path: 'p.md', curatedContext: 'c', retrievalText: 'r', inclusion: 'include' };
      const pkg = makeValidPackage('source-repo', [entry]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'target-repo')]),  // different name
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      await expect(svc.applyImport(REPO_ID, pkg)).rejects.toMatchObject({
        code: 'REPO_NAME_MISMATCH_REQUIRES_CONFIRMATION',
        statusCode: 409,
      });
    });

    it('proceeds when mismatch and confirmRepoNameMismatch=true', async () => {
      const entry = { entryId: 'e-confirm', repoName: 'source-repo', title: 'Confirmed', path: 'docs/confirm.md', curatedContext: 'ctx', retrievalText: 'rt', inclusion: 'include' };
      const pkg = makeValidPackage('source-repo', [entry]);
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'target-repo')]),
        repo_context_curation_entries: makeCollection(),
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      const result = await svc.applyImport(REPO_ID, pkg, { confirmRepoNameMismatch: true });
      expect((result.imported as Record<string, number>).curated).toBe(1);
    });
  });

  // ── applyImport — race handling ──────────────────────────────────────────

  describe('applyImport — E11000 race handling', () => {
    it('treats E11000 duplicate key on insertOne as a skip (import continues)', async () => {
      const entry = makeCuratedEntry({ repoName: 'test-repo', entryId: 'race-entry', title: 'Race Entry' });
      const pkg = makeValidPackage('test-repo', [entry]);
      const curatedCol = makeCollection([]);
      // Simulate E11000 race on insert
      (curatedCol.insertOne as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error('E11000 duplicate key error collection'), { code: 11000 }),
      );
      const db = makeDb({
        repos: makeCollection([makeRepoDoc(REPO_ID, 'test-repo')]),
        repo_context_curation_entries: curatedCol,
        repo_mandatory_context_mappings: makeCollection(),
        agents: makeCollection(),
      });
      const svc = new RepoContextPortabilityService(db);
      // Should not throw — E11000 is treated as a race-condition skip
      const result = await svc.applyImport(REPO_ID, pkg);
      expect((result.imported as { curated: number }).curated).toBe(0);
      expect((result.errors as unknown[]).length).toBe(0);
    });
  });
});
