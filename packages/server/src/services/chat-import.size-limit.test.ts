/**
 * Tests for ChatImportService.preview() size limit.
 *
 * IMPORT_MAX_BYTES is a module-level const that gets set at import time.
 * We use vi.resetModules() + dynamic import to ensure the env var is set
 * before the module's top-level code runs.
 *
 * @see PRD AC17 — oversized bundle rejection
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';

describe('ChatImportService size limit (ALLEN_IMPORT_MAX_BYTES=200)', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('chat-import-sizelimit-test');
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    const collections = await db.listCollections().toArray();
    for (const col of collections) {
      await db.collection(col.name).deleteMany({});
    }
  });

  it('rejects bundle exceeding ALLEN_IMPORT_MAX_BYTES → IMPORT_SIZE_EXCEEDED', async () => {
    // Reset module cache and set env before importing
    vi.resetModules();
    process.env.ALLEN_IMPORT_MAX_BYTES = '200';

    const { ChatImportService } = await import('./chat-import.service.js');
    const service = new ChatImportService(db);

    const bundle = {
      bundleVersion: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: 'user',
      sourceEnvironment: { appName: 'A', appVersion: 'B' },
      redactions: {
        pathsRedacted: false, identityRedacted: false, secretsRedacted: false,
        rawTracesExcluded: false, artifactsExcluded: false, thinkingExcluded: false,
      },
      session: {
        title: 'T', status: 'active', messageCount: 0, totalCostUsd: 0,
        provider: 'c', createdAt: '2025-01-01T00:00:00Z', lastMessageAt: '2025-01-01T00:00:00Z',
      },
      messages: [
        { role: 'user', content: 'A'.repeat(400), status: 'completed', createdAt: '2025-01-01T00:00:00Z' },
      ],
      chatLogs: [],
      executions: [],
      executionLogs: [],
      executionTraces: [],
      artifacts: [],
      interventions: [],
      watchers: [],
    };
    const jsonStr = JSON.stringify(bundle);
    expect(Buffer.byteLength(jsonStr, 'utf8')).toBeGreaterThan(200);

    await expect(service.preview(jsonStr, 'user-1')).rejects.toMatchObject({
      errorCode: 'IMPORT_SIZE_EXCEEDED',
      statusCode: 400,
    });
  });
});
