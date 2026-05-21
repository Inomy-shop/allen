import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';

const mocks = vi.hoisted(() => ({
  runCogneeSidecar: vi.fn(),
}));

vi.mock('../../../../src/services/context/cognee/repo-context-cognee-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/services/context/cognee/repo-context-cognee-provider.js')>();
  return {
    ...actual,
    runCogneeSidecar: mocks.runCogneeSidecar,
  };
});

import { CogneeMemoryService } from '../../../../src/services/context/cognee/cognee-memory.service.js';

describe('CogneeMemoryService', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let repoPath: string | undefined;
  let tempPaths: string[] = [];
  const originalContextProvider = process.env.ALLEN_CONTEXT_PROVIDER;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db('allen-test');
  });

  afterAll(async () => {
    if (originalContextProvider === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
    else process.env.ALLEN_CONTEXT_PROVIDER = originalContextProvider;
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    process.env.ALLEN_CONTEXT_PROVIDER = 'cognee';
    await db.dropDatabase();
    mocks.runCogneeSidecar.mockReset();
    mocks.runCogneeSidecar.mockResolvedValue({ diagnostics: [{ code: 'fake_cognee', severity: 'info' }] });
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
    for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
    repoPath = undefined;
    tempPaths = [];
  });

  it('builds Cognee input from tracked Markdown files without Allen knowledge nodes', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    await db.collection('repo_knowledge_indexes').insertOne({ repoId: repoId.toString(), indexId: 'index-1', latest: true });
    await db.collection('knowledge_nodes').insertOne({
      repoId: repoId.toString(),
      indexId: 'index-1',
      id: 'node:ignored',
      title: 'Ignored production note',
      summary: 'This should not be sent to Cognee.',
      kind: 'production_note',
    });

    const status = await new CogneeMemoryService(db).refreshRepo(repoId.toString());

    expect(status.status).toBe('completed');
    expect(status.source).toBe('markdown_file_filter');
    expect(status.documentCount).toBe(2);
    expect(status.ingestFormat).toBe('markdown_file_docmeta_v1');
    expect(mocks.runCogneeSidecar).toHaveBeenCalledOnce();
    const payload = mocks.runCogneeSidecar.mock.calls[0][1] as any;
    expect(payload.documents.map((doc: any) => doc.path)).toEqual(['AGENTS.md', 'docs/runbook.md']);
    expect(payload.documents.map((doc: any) => doc.kind)).toEqual(['doc', 'doc']);
    expect(payload.documents[0].content).toContain('# Agent Rules');
    expect(payload.documents[0].content).not.toContain('allen-cognee-chunk');
    expect(payload.documents[0].content.trim()).not.toMatch(/^\{/);
    expect(payload.documents[0].dataId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(payload.documents[0].externalMetadata).toEqual(expect.objectContaining({
      repoId: repoId.toString(),
      path: 'AGENTS.md',
      title: 'Agent Rules',
      kind: 'doc',
      fileHash: expect.any(String),
      ingestFormat: 'markdown_file_docmeta_v1',
    }));
    expect(payload.documents[0].externalMetadata).not.toHaveProperty('repoPath');
    expect(payload.documents[0].externalMetadata).not.toHaveProperty('sourcePath');
    expect(payload.ingestFormat).toBe('markdown_file_docmeta_v1');
    expect(payload.chunkSize).toBe(4096);
    expect(status.manifest).toEqual(expect.objectContaining({
      version: 1,
      ingestFormat: 'markdown_file_docmeta_v1',
      documentCount: 2,
      documents: expect.arrayContaining([
        expect.objectContaining({ path: 'AGENTS.md', dataId: expect.any(String) }),
      ]),
    }));
    expect(JSON.stringify(payload.documents)).not.toContain('Ignored production note');
    expect(JSON.stringify(payload.documents)).not.toContain('This should not be sent to Cognee');
  });

  it('sends the current Markdown set to Cognee so the sidecar can diff against Cognee DB metadata', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    const service = new CogneeMemoryService(db);

    await service.refreshRepo(repoId.toString());
    mocks.runCogneeSidecar.mockClear();
    mocks.runCogneeSidecar.mockResolvedValueOnce({
      ingestedDocumentCount: 2,
      cognifiedDocumentCount: 2,
      diagnostics: [{
        code: 'cognee_db_diff',
        severity: 'info',
        addedDocumentCount: 0,
        changedDocumentCount: 0,
        deletedDocumentCount: 0,
        unchangedDocumentCount: 2,
      }],
    });

    const status = await service.refreshRepo(repoId.toString());

    expect(mocks.runCogneeSidecar).toHaveBeenCalledOnce();
    const payload = mocks.runCogneeSidecar.mock.calls[0][1] as any;
    expect(payload.documents.map((doc: any) => doc.path)).toEqual(['AGENTS.md', 'docs/runbook.md']);
    expect(payload.deletedDocuments).toBeUndefined();
    expect(status).toEqual(expect.objectContaining({
      status: 'completed',
      message: 'Context built from 2 Markdown files',
      documentCount: 2,
      ingestedDocumentCount: 2,
      cognifiedDocumentCount: 2,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'cognee_db_diff',
          addedDocumentCount: 0,
          changedDocumentCount: 0,
          deletedDocumentCount: 0,
          unchangedDocumentCount: 2,
        }),
      ]),
    }));
  });

  it('does not pre-filter changed and deleted Markdown documents before calling Cognee', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    const service = new CogneeMemoryService(db);

    await service.refreshRepo(repoId.toString());
    writeFileSync(join(repoPath, 'AGENTS.md'), '# Agent Rules\n\nFollow repo rules and prefer relative paths.\n');
    execFileSync('git', ['add', 'AGENTS.md'], { cwd: repoPath });
    execFileSync('git', ['rm', '-f', 'docs/runbook.md'], { cwd: repoPath });
    mocks.runCogneeSidecar.mockClear();

    const status = await service.refreshRepo(repoId.toString());

    expect(status.status).toBe('completed');
    expect(mocks.runCogneeSidecar).toHaveBeenCalledOnce();
    const payload = mocks.runCogneeSidecar.mock.calls[0][1] as any;
    expect(payload.totalDocumentCount).toBe(1);
    expect(payload.documents).toEqual([
      expect.objectContaining({
        path: 'AGENTS.md',
        changeType: 'current',
        externalMetadata: expect.objectContaining({ path: 'AGENTS.md' }),
      }),
    ]);
    expect(payload.deletedDocuments).toBeUndefined();
    expect(payload.changedDocumentCount).toBeUndefined();
    expect(payload.deletedDocumentCount).toBeUndefined();
  });

  it('runs Cognee cognify without re-adding unchanged files when prior cognify was partial', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    mocks.runCogneeSidecar.mockResolvedValueOnce({
      ingestedDocumentCount: 2,
      cognifiedDocumentCount: 1,
      uncognifiedDocuments: [{ path: 'docs/runbook.md', title: 'Runbook', cogneeDataId: 'data-1' }],
      diagnostics: [{ code: 'fake_cognee', severity: 'info' }],
    });
    const service = new CogneeMemoryService(db);

    await service.refreshRepo(repoId.toString());
    mocks.runCogneeSidecar.mockClear();
    mocks.runCogneeSidecar.mockResolvedValueOnce({
      ingestedDocumentCount: 2,
      cognifiedDocumentCount: 2,
      diagnostics: [{ code: 'fake_cognee', severity: 'info' }],
    });

    const status = await service.refreshRepo(repoId.toString());

    expect(status.status).toBe('completed');
    expect(mocks.runCogneeSidecar).toHaveBeenCalledOnce();
    const payload = mocks.runCogneeSidecar.mock.calls[0][1] as any;
    expect(payload.documents.map((doc: any) => doc.path)).toEqual(['AGENTS.md', 'docs/runbook.md']);
    expect(payload.deletedDocuments).toBeUndefined();
    expect(payload.uncognifiedRetryCount).toBeUndefined();
    expect(payload.totalDocumentCount).toBe(2);
  });

  it('retries cognify failures without re-adding unchanged files', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    mocks.runCogneeSidecar.mockImplementationOnce((_action, _payload, onProgress) => {
      onProgress?.({
        stage: 'cognifying',
        message: 'Cognified: 1/2',
        processedDocumentCount: 1,
        ingestedDocumentCount: 2,
        cognifiedDocumentCount: 1,
        documentCount: 2,
      });
      return Promise.reject(new Error('cognify failed'));
    });
    const service = new CogneeMemoryService(db);

    const failed = await service.refreshRepo(repoId.toString());
    expect(failed).toEqual(expect.objectContaining({
      status: 'failed',
      uncognifiedDocuments: expect.arrayContaining([
        expect.objectContaining({ path: 'AGENTS.md', dataId: expect.any(String) }),
        expect.objectContaining({ path: 'docs/runbook.md', dataId: expect.any(String) }),
      ]),
    }));
    mocks.runCogneeSidecar.mockClear();
    mocks.runCogneeSidecar.mockResolvedValueOnce({
      ingestedDocumentCount: 2,
      cognifiedDocumentCount: 2,
      diagnostics: [{ code: 'fake_cognee', severity: 'info' }],
    });

    const status = await service.refreshRepo(repoId.toString());

    expect(status.status).toBe('completed');
    expect(mocks.runCogneeSidecar).toHaveBeenCalledOnce();
    const payload = mocks.runCogneeSidecar.mock.calls[0][1] as any;
    expect(payload.documents.map((doc: any) => doc.path)).toEqual(['AGENTS.md', 'docs/runbook.md']);
    expect(payload.deletedDocuments).toBeUndefined();
    expect(payload.uncognifiedRetryCount).toBeUndefined();
  });

  it('pulls the default branch before building canonical repo context when requested', async () => {
    const fixture = createRemoteFixture();
    tempPaths = [fixture.originPath, fixture.seedPath];
    repoPath = fixture.repoPath;
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({
      _id: repoId,
      name: 'fixture',
      path: repoPath,
      detected: { defaultBranch: 'main' },
    });
    writeFileSync(join(fixture.seedPath, 'docs', 'latest.md'), '# Latest\n\nDefault branch update.\n');
    execFileSync('git', ['add', 'docs/latest.md'], { cwd: fixture.seedPath });
    execFileSync('git', ['commit', '-m', 'add latest docs'], { cwd: fixture.seedPath });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: fixture.seedPath });

    const status = await new CogneeMemoryService(db).refreshRepo(repoId.toString(), { pullLatest: true });

    expect(status.repoId).toBe(repoId.toString());
    expect(status.sourcePath).toBe(repoPath);
    expect(status.documentCount).toBe(3);
    const payload = mocks.runCogneeSidecar.mock.calls[0][1] as any;
    expect(payload.repo).toEqual(expect.objectContaining({ repoId: repoId.toString(), sourcePath: repoPath, branch: 'main' }));
    expect(payload.documents.map((doc: any) => doc.path)).toContain('docs/latest.md');
    expect(status.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'cognee_repo_default_branch_updated', branch: 'main', updated: true }),
    ]));
  });

  it('schedules Cognee refresh in the background and exposes running progress', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    const sidecar = deferred<{ diagnostics: Array<Record<string, unknown>> }>();
    mocks.runCogneeSidecar.mockImplementationOnce((_action, _payload, onProgress) => {
      onProgress?.({
        stage: 'ingesting',
        message: 'Ingested: 1/2',
        processedDocumentCount: 1,
        ingestedDocumentCount: 1,
        cognifiedDocumentCount: 0,
        documentCount: 2,
        storageRoot: '/tmp/allen-cognee',
        systemRoot: '/tmp/allen-cognee/system',
        databasePath: '/tmp/allen-cognee/system/databases',
        storageExisting: true,
        datasetExisting: false,
      });
      return sidecar.promise;
    });
    const service = new CogneeMemoryService(db);

    const started = await service.scheduleRefreshRepo(repoId.toString());

    expect(started.status).toBe('running');
    expect(started.stage).toBe('collecting_markdown');
    expect(started.workerActive).toBe(true);
    await vi.waitFor(() => expect(mocks.runCogneeSidecar).toHaveBeenCalledOnce());
    const running = await service.getStatus(repoId.toString());
    expect(running).toEqual(expect.objectContaining({
      status: 'running',
      stage: 'ingesting',
      workerActive: true,
      documentCount: 2,
      processedDocumentCount: 1,
      ingestedDocumentCount: 1,
      cognifiedDocumentCount: 0,
      message: 'Ingested: 1/2',
      storageRoot: '/tmp/allen-cognee',
      databasePath: '/tmp/allen-cognee/system/databases',
      storageExisting: true,
      datasetExisting: false,
    }));

    sidecar.resolve({
      diagnostics: [{ code: 'fake_cognee', severity: 'info' }],
      storageRoot: '/tmp/allen-cognee',
      systemRoot: '/tmp/allen-cognee/system',
      databasePath: '/tmp/allen-cognee/system/databases',
      storageExisting: true,
      datasetExisting: false,
    });
    await vi.waitFor(async () => {
      const completed = await service.getStatus(repoId.toString());
      expect(completed).toEqual(expect.objectContaining({
        status: 'completed',
        stage: 'completed',
        documentCount: 2,
        processedDocumentCount: 2,
        ingestedDocumentCount: 2,
        cognifiedDocumentCount: 2,
        storageRoot: '/tmp/allen-cognee',
        databasePath: '/tmp/allen-cognee/system/databases',
        storageExisting: true,
        datasetExisting: false,
      }));
    });
  });

  it('returns the running status instead of starting duplicate Cognee builds', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    const sidecar = deferred<{ diagnostics: Array<Record<string, unknown>> }>();
    mocks.runCogneeSidecar.mockReturnValueOnce(sidecar.promise);
    const service = new CogneeMemoryService(db);

    const first = await service.scheduleRefreshRepo(repoId.toString());
    const second = await service.scheduleRefreshRepo(repoId.toString());

    expect(first.status).toBe('running');
    expect(second.status).toBe('running');
    expect(first.workerActive).toBe(true);
    expect(second.workerActive).toBe(true);
    await vi.waitFor(() => expect(mocks.runCogneeSidecar).toHaveBeenCalledOnce());
    sidecar.resolve({ diagnostics: [] });
    await vi.waitFor(async () => {
      expect((await service.getStatus(repoId.toString()))?.status).toBe('completed');
    });
  });

  it('reclaims a persisted running status when no live worker exists in this process', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    await db.collection('repo_cognee_datasets').insertOne({
      repoId: repoId.toString(),
      repoName: 'fixture',
      repoPath,
      sourcePath: repoPath,
      branch: 'main',
      datasetName: `allen-fixture-${repoId.toString()}`,
      status: 'running',
      stage: 'cognifying',
      message: 'Cognified: 0/2',
      diagnostics: [{ code: 'previous_progress', severity: 'info' }],
      ingestedDocumentCount: 2,
      cognifiedDocumentCount: 0,
      updatedAt: new Date(),
      createdAt: new Date(),
      lastStartedAt: new Date(),
    });
    const sidecar = deferred<{ diagnostics: Array<Record<string, unknown>> }>();
    mocks.runCogneeSidecar.mockReturnValueOnce(sidecar.promise);
    const service = new CogneeMemoryService(db);

    const orphaned = await service.getStatus(repoId.toString());
    expect(orphaned).toEqual(expect.objectContaining({
      status: 'running',
      stage: 'cognifying',
      workerActive: false,
    }));

    const started = await service.scheduleRefreshRepo(repoId.toString());

    expect(started).toEqual(expect.objectContaining({
      status: 'running',
      stage: 'collecting_markdown',
      workerActive: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'previous_progress' }),
        expect.objectContaining({ code: 'cognee_build_interrupted', stage: 'cognifying' }),
      ]),
    }));
    await vi.waitFor(() => expect(mocks.runCogneeSidecar).toHaveBeenCalledOnce());
    const running = await service.getStatus(repoId.toString());
    expect(running?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'cognee_build_interrupted' }),
    ]));

    sidecar.resolve({ diagnostics: [{ code: 'fake_cognee', severity: 'info' }] });
    await vi.waitFor(async () => {
      expect(await service.getStatus(repoId.toString())).toEqual(expect.objectContaining({
        status: 'completed',
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'cognee_build_interrupted' }),
          expect.objectContaining({ code: 'fake_cognee' }),
        ]),
      }));
    });
  });

  it('does not let late ingest progress overwrite cognifying or completed status', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    const sidecar = deferred<{ diagnostics: Array<Record<string, unknown>> }>();
    mocks.runCogneeSidecar.mockImplementationOnce((_action, _payload, onProgress) => {
      onProgress?.({ stage: 'ingesting', processedDocumentCount: 2, ingestedDocumentCount: 2, cognifiedDocumentCount: 0, documentCount: 2, message: 'Ingested: 2/2' });
      onProgress?.({ stage: 'cognifying', processedDocumentCount: 1, ingestedDocumentCount: 2, cognifiedDocumentCount: 1, documentCount: 2, message: 'Cognified: 1/2' });
      onProgress?.({ stage: 'ingesting', processedDocumentCount: 2, ingestedDocumentCount: 2, cognifiedDocumentCount: 0, documentCount: 2, message: 'Late ingest update' });
      return sidecar.promise;
    });
    const service = new CogneeMemoryService(db);

    await service.scheduleRefreshRepo(repoId.toString());

    await vi.waitFor(async () => {
      const running = await service.getStatus(repoId.toString());
      expect(running).toEqual(expect.objectContaining({
        status: 'running',
        stage: 'cognifying',
        message: 'Cognified: 1/2',
        ingestedDocumentCount: 2,
        cognifiedDocumentCount: 1,
      }));
    });

    sidecar.resolve({ diagnostics: [] });
    await vi.waitFor(async () => {
      expect(await service.getStatus(repoId.toString())).toEqual(expect.objectContaining({
        status: 'completed',
        stage: 'completed',
      }));
    });
  });

  it('persists Cognee DB diff progress as status fields and diagnostics', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    const sidecar = deferred<{ diagnostics: Array<Record<string, unknown>> }>();
    mocks.runCogneeSidecar.mockImplementationOnce((_action, _payload, onProgress) => {
      onProgress?.({
        stage: 'ingesting',
        message: 'Checked Cognee database: 1 unchanged, 1 to ingest',
        processedDocumentCount: 0,
        ingestedDocumentCount: 0,
        cognifiedDocumentCount: 0,
        documentCount: 2,
        documentsToIngestCount: 1,
        addedDocumentCount: 1,
        changedDocumentCount: 0,
        deletedDocumentCount: 0,
        unchangedDocumentCount: 1,
        uncognifiedRetryCount: 0,
      });
      return sidecar.promise;
    });
    const service = new CogneeMemoryService(db);

    await service.scheduleRefreshRepo(repoId.toString());

    await vi.waitFor(async () => {
      const running = await service.getStatus(repoId.toString());
      expect(running).toEqual(expect.objectContaining({
        status: 'running',
        stage: 'ingesting',
        message: 'Checked Cognee database: 1 unchanged, 1 to ingest',
        documentsToIngestCount: 1,
        unchangedDocumentCount: 1,
        addedDocumentCount: 1,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: 'cognee_db_diff',
            unchangedDocumentCount: 1,
            documentsToIngestCount: 1,
            addedDocumentCount: 1,
          }),
        ]),
      }));
    });

    sidecar.resolve({
      diagnostics: [{
        code: 'cognee_db_diff',
        severity: 'info',
        addedDocumentCount: 1,
        changedDocumentCount: 0,
        deletedDocumentCount: 0,
        unchangedDocumentCount: 1,
        documentsToIngestCount: 1,
        uncognifiedRetryCount: 0,
      }],
    });
    await vi.waitFor(async () => {
      expect(await service.getStatus(repoId.toString())).toEqual(expect.objectContaining({
        status: 'completed',
        documentsToIngestCount: 1,
        unchangedDocumentCount: 1,
      }));
    });
  });

  it('moves corrupted Cognee graph WAL files aside and retries once', async () => {
    const previousDataDir = process.env.ALLEN_COGNEE_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), 'allen-cognee-data-'));
    tempPaths.push(dataDir);
    process.env.ALLEN_COGNEE_DATA_DIR = dataDir;
    try {
      repoPath = createGitFixture();
      const repoId = new ObjectId();
      await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
      const graphDir = join(dataDir, 'system', 'databases', 'dataset-id');
      mkdirSync(graphDir, { recursive: true });
      const corruptWal = join(graphDir, 'graph.lbug.wal.checkpoint');
      writeFileSync(corruptWal, 'corrupt wal');
      mocks.runCogneeSidecar
        .mockRejectedValueOnce(new Error('Runtime exception: Corrupted wal file. Read out invalid WAL record type.'))
        .mockResolvedValueOnce({ diagnostics: [{ code: 'fake_cognee', severity: 'info' }] });

      const status = await new CogneeMemoryService(db).refreshRepo(repoId.toString());

      expect(mocks.runCogneeSidecar).toHaveBeenCalledTimes(2);
      expect(existsSync(corruptWal)).toBe(false);
      expect(readdirSync(graphDir).some((name) => name.startsWith('graph.lbug.wal.checkpoint.corrupt-'))).toBe(true);
      expect(status).toEqual(expect.objectContaining({
        status: 'completed',
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'cognee_graph_wal_recovered', fileCount: 1 }),
          expect.objectContaining({ code: 'fake_cognee' }),
        ]),
      }));
    } finally {
      if (previousDataDir === undefined) delete process.env.ALLEN_COGNEE_DATA_DIR;
      else process.env.ALLEN_COGNEE_DATA_DIR = previousDataDir;
    }
  });

  it('does not let progress emitted after completion overwrite completed status', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    mocks.runCogneeSidecar.mockImplementationOnce((_action, _payload, onProgress) => {
      setTimeout(() => {
        onProgress?.({ stage: 'ingesting', processedDocumentCount: 1, documentCount: 2, message: 'Late progress after completion' });
      }, 0);
      return Promise.resolve({ diagnostics: [] });
    });
    const service = new CogneeMemoryService(db);

    await service.scheduleRefreshRepo(repoId.toString());

    await vi.waitFor(async () => {
      expect(await service.getStatus(repoId.toString())).toEqual(expect.objectContaining({
        status: 'completed',
        stage: 'completed',
      }));
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await service.getStatus(repoId.toString())).toEqual(expect.objectContaining({
      status: 'completed',
      stage: 'completed',
    }));
  });

  it('marks a finished Cognee run partial when cognified count is lower than ingested count', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    mocks.runCogneeSidecar.mockResolvedValueOnce({
      ingestedDocumentCount: 2,
      cognifiedDocumentCount: 1,
      uncognifiedDocuments: [
        {
          path: 'docs/runbook.md',
          title: 'Runbook',
          fileHash: 'hash-1',
          cogneeDataId: 'data-1',
          status: 'None',
        },
      ],
      diagnostics: [{ code: 'fake_cognee', severity: 'info' }],
    });

    const status = await new CogneeMemoryService(db).refreshRepo(repoId.toString());

    expect(status).toEqual(expect.objectContaining({
      status: 'partial',
      stage: 'completed',
      message: 'Context partially built: 1/2 Markdown files cognified',
      ingestedDocumentCount: 2,
      cognifiedDocumentCount: 1,
      uncognifiedDocuments: [
        expect.objectContaining({ path: 'docs/runbook.md', cogneeDataId: 'data-1' }),
      ],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'cognee_cognify_partial', ingestedDocumentCount: 2, cognifiedDocumentCount: 1 }),
      ]),
    }));
  });

  it('resumes the existing dataset by default when retrying after a previous status', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    await db.collection('repo_cognee_datasets').insertOne({
      repoId: repoId.toString(),
      repoName: 'fixture',
      repoPath,
      sourcePath: repoPath,
      branch: 'main',
      datasetName: 'allen-fixture-previous-docmeta-v1',
      status: 'partial',
      stage: 'completed',
      updatedAt: new Date(),
      createdAt: new Date(),
    });

    const status = await new CogneeMemoryService(db).refreshRepo(repoId.toString());

    expect(status.status).toBe('completed');
    expect(status.previousDatasetName).toBeUndefined();
    expect(status.buildMode).toBe('resume');
    expect(status.datasetName).toBe('allen-fixture-previous-docmeta-v1');
    const payload = mocks.runCogneeSidecar.mock.calls[0][1] as any;
    expect(payload.datasetName).toBe(status.datasetName);
  });

  it('uses a fresh dataset name only when clean rebuild is requested', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    await db.collection('repo_cognee_datasets').insertOne({
      repoId: repoId.toString(),
      repoName: 'fixture',
      repoPath,
      sourcePath: repoPath,
      branch: 'main',
      datasetName: 'allen-fixture-previous-docmeta-v1',
      status: 'partial',
      stage: 'completed',
      updatedAt: new Date(),
      createdAt: new Date(),
    });

    const status = await new CogneeMemoryService(db).refreshRepo(repoId.toString(), { cleanRebuild: true });

    expect(status.status).toBe('completed');
    expect(status.previousDatasetName).toBe('allen-fixture-previous-docmeta-v1');
    expect(status.buildMode).toBe('clean_rebuild');
    expect(status.datasetName).not.toBe('allen-fixture-previous-docmeta-v1');
    expect(status.datasetName).toContain(`${repoId.toString()}-docmeta-v1-`);
    const payload = mocks.runCogneeSidecar.mock.calls[0][1] as any;
    expect(payload.datasetName).toBe(status.datasetName);
  });

  it('stops an active Cognee refresh and persists stopped status', async () => {
    repoPath = createGitFixture();
    const repoId = new ObjectId();
    await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
    mocks.runCogneeSidecar.mockImplementationOnce((_action, _payload, onProgress, options) => {
      onProgress?.({ stage: 'cognifying', processedDocumentCount: 1, ingestedDocumentCount: 2, cognifiedDocumentCount: 1, documentCount: 2, message: 'Cognified: 1/2' });
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const err = new Error('Cognee ingest stopped by user');
          err.name = 'CogneeSidecarStoppedError';
          reject(err);
        }, { once: true });
      });
    });
    const service = new CogneeMemoryService(db);

    await service.scheduleRefreshRepo(repoId.toString());
    await vi.waitFor(() => expect(mocks.runCogneeSidecar).toHaveBeenCalledOnce());
    const stopped = await service.stopRefreshRepo(repoId.toString());

    expect(stopped).toEqual(expect.objectContaining({
      status: 'stopped',
      stage: 'failed',
      message: 'Cognee context build stopped by user',
      ingestedDocumentCount: 2,
      cognifiedDocumentCount: 1,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'cognee_build_stopped' }),
      ]),
    }));
  });

  it('marks stale running status failed on passive status reads', async () => {
    const previousStaleMs = process.env.ALLEN_COGNEE_STALE_MS;
    process.env.ALLEN_COGNEE_STALE_MS = '1';
    try {
      repoPath = createGitFixture();
      const repoId = new ObjectId();
      await db.collection('repos').insertOne({ _id: repoId, name: 'fixture', path: repoPath, defaultBranch: 'main' });
      await db.collection('repo_cognee_datasets').insertOne({
        repoId: repoId.toString(),
        repoName: 'fixture',
        repoPath,
        sourcePath: repoPath,
        branch: 'main',
        datasetName: `allen-fixture-${repoId.toString()}`,
        status: 'running',
        stage: 'ingesting',
        message: 'Ingested: 2/2',
        updatedAt: new Date(Date.now() - 60_000),
        createdAt: new Date(Date.now() - 60_000),
        lastStartedAt: new Date(Date.now() - 60_000),
      });
      const service = new CogneeMemoryService(db);

      const status = await service.getStatus(repoId.toString());

      expect(status).toEqual(expect.objectContaining({
        status: 'failed',
        stage: 'failed',
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'cognee_build_stale' }),
        ]),
      }));
      expect(mocks.runCogneeSidecar).not.toHaveBeenCalled();
    } finally {
      if (previousStaleMs === undefined) delete process.env.ALLEN_COGNEE_STALE_MS;
      else process.env.ALLEN_COGNEE_STALE_MS = previousStaleMs;
    }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createGitFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'allen-cognee-memory-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), '# Agent Rules\n\nFollow repo rules.\n');
  writeFileSync(join(dir, 'docs', 'runbook.md'), '# Runbook\n\nUse idempotent retries.\n');
  writeFileSync(join(dir, 'docs', 'notes.mdx'), '# MDX should be ignored\n');
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const value = 1;\n');
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['add', 'AGENTS.md', 'docs/runbook.md', 'docs/notes.mdx', 'src/index.ts'], { cwd: dir });
  writeFileSync(join(dir, 'untracked.md'), '# Untracked should be ignored\n');
  return dir;
}

function createRemoteFixture(): { originPath: string; seedPath: string; repoPath: string } {
  const originPath = mkdtempSync(join(tmpdir(), 'allen-cognee-origin-'));
  const seedPath = mkdtempSync(join(tmpdir(), 'allen-cognee-seed-'));
  const repoPath = mkdtempSync(join(tmpdir(), 'allen-cognee-clone-'));
  rmSync(repoPath, { recursive: true, force: true });
  execFileSync('git', ['init', '--bare'], { cwd: originPath });
  mkdirSync(join(seedPath, 'docs'), { recursive: true });
  writeFileSync(join(seedPath, 'AGENTS.md'), '# Agent Rules\n\nFollow repo rules.\n');
  writeFileSync(join(seedPath, 'docs', 'runbook.md'), '# Runbook\n\nUse idempotent retries.\n');
  execFileSync('git', ['init'], { cwd: seedPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: seedPath });
  execFileSync('git', ['config', 'user.email', 'allen@example.test'], { cwd: seedPath });
  execFileSync('git', ['config', 'user.name', 'Allen Test'], { cwd: seedPath });
  execFileSync('git', ['add', '.'], { cwd: seedPath });
  execFileSync('git', ['commit', '-m', 'initial docs'], { cwd: seedPath });
  execFileSync('git', ['remote', 'add', 'origin', originPath], { cwd: seedPath });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: seedPath });
  execFileSync('git', ['clone', originPath, repoPath]);
  execFileSync('git', ['checkout', 'main'], { cwd: repoPath });
  return { originPath, seedPath, repoPath };
}
