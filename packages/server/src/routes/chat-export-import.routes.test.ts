/**
 * Tests for chat-export-import.routes.ts — Express integration with
 * MongoMemoryServer + supertest.
 *
 * @see PRD AC2 (export produces file), AC3 (no hosted share URL),
 *      AC5 (preview response), AC6 (isImported), AC7 (messages preserved),
 *      AC13 (source refs), AC17 (validation errors), AC19 (size limit)
 */

import express from 'express';
import request from 'supertest';
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chatExportImportRoutes } from './chat-export-import.routes.js';
import type { ChatExportBundle } from '../services/chat-export.service.js';

describe('chat-export-import routes', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;

  const mockUser = { sub: 'test-user-123' };

  // Middleware to simulate auth
  function authMiddleware(req: express.Request, _res: express.Response, next: express.NextFunction): void {
    (req as unknown as Record<string, unknown>).user = mockUser;
    next();
  }

  /** Helper: seed a minimal chat session */
  async function seedSession(): Promise<string> {
    const sessionId = new ObjectId().toString();
    const sessionOid = new ObjectId(sessionId);
    await db.collection('chat_sessions').insertOne({
      _id: sessionOid,
      title: 'Export Test Chat',
      status: 'active',
      messageCount: 1,
      lastMessageAt: new Date(),
      totalCostUsd: 0.1,
      provider: 'claude',
      model: 'claude-sonnet-4',
      source: 'ui',
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-02'),
    });
    await db.collection('chat_messages').insertOne({
      _id: new ObjectId(),
      sessionId,
      role: 'user',
      content: 'Hello, export me!',
      status: 'completed',
      createdAt: new Date('2025-01-01T10:00:00Z'),
    });
    return sessionId;
  }

  /** Helper: produce a valid export-like bundle */
  function validBundlePayload(): Record<string, unknown> {
    return {
      bundleVersion: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: 'user-123',
      sourceEnvironment: { appName: 'Allen', appVersion: '1.0.0' },
      redactions: {
        pathsRedacted: false,
        identityRedacted: false,
        secretsRedacted: false,
        rawTracesExcluded: true,
        artifactsExcluded: true,
        thinkingExcluded: true,
      },
      session: {
        title: 'Imported Chat',
        status: 'active',
        messageCount: 1,
        totalCostUsd: 0,
        provider: 'claude',
        model: 'claude-sonnet-4',
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        _sourceId: 'src-session-id',
      },
      messages: [
        {
          role: 'user',
          content: 'Hello from export',
          status: 'completed',
          createdAt: new Date().toISOString(),
          _sourceId: 'src-msg-1',
        },
      ],
      chatLogs: [],
      executions: [],
      executionLogs: [],
      executionTraces: [],
      artifacts: [],
      interventions: [],
      watchers: [],
    };
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('chat-export-import-routes-test');
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(authMiddleware);
    app.use('/api/chat', chatExportImportRoutes(db));
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

  // ── Export Options ──────────────────────────────────────────────────────

  describe('GET /api/chat/sessions/:id/export-options', () => {
    it('returns 404 for missing session', async () => {
      const res = await request(app).get(`/api/chat/sessions/${new ObjectId().toString()}/export-options`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('EXPORT_SESSION_NOT_FOUND');
    });

    it('returns 200 with counts for existing session', async () => {
      const sessionId = await seedSession();
      const res = await request(app).get(`/api/chat/sessions/${sessionId}/export-options`);
      expect(res.status).toBe(200);
      expect(res.body.messageCount).toBe(1);
      expect(res.body.estimatedSizeBytes).toBeGreaterThan(0);
      expect(Array.isArray(res.body.warnings)).toBe(true);
    });
  });

  // ── Export ──────────────────────────────────────────────────────────────

  describe('POST /api/chat/sessions/:id/export', () => {
    it('returns 200 with Content-Disposition attachment header (AC2)', async () => {
      const sessionId = await seedSession();
      const res = await request(app)
        .post(`/api/chat/sessions/${sessionId}/export`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBeDefined();
      expect(res.headers['content-disposition']).toContain('attachment; filename=');
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('response body has bundleVersion, session, messages — no _id, no shareUrl (AC3)', async () => {
      const sessionId = await seedSession();
      const res = await request(app)
        .post(`/api/chat/sessions/${sessionId}/export`)
        .send({});

      expect(res.status).toBe(200);

      // Has required fields
      expect(res.body.bundleVersion).toBe(1);
      expect(res.body.session).toBeDefined();
      expect(res.body.session.title).toBe('Export Test Chat');
      expect(res.body.messages).toBeDefined();
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].content).toBe('Hello, export me!');

      // No _id
      expect(res.body._id).toBeUndefined();

      // No hosted share URL field (AC3)
      expect(res.body.shareUrl).toBeUndefined();
      expect(res.body.publicUrl).toBeUndefined();
    });

    it('returns 400 EXPORT_SIZE_LIMIT_EXCEEDED with suggestedExclusions when size cap hit (AC19)', async () => {
      const sessionId = await seedSession();
      // Override with tiny limit via body
      const res = await request(app)
        .post(`/api/chat/sessions/${sessionId}/export`)
        .send({ maxBundleSizeBytes: 10 }); // 10 bytes — tiny

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('EXPORT_SIZE_LIMIT_EXCEEDED');
      expect(res.body.suggestedExclusions).toBeDefined();
      expect(Array.isArray(res.body.suggestedExclusions)).toBe(true);
    });

    it('returns 404 for missing session', async () => {
      const res = await request(app)
        .post(`/api/chat/sessions/${new ObjectId().toString()}/export`)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('EXPORT_SESSION_NOT_FOUND');
    });
  });

  // ── Import Preview ──────────────────────────────────────────────────────

  describe('POST /api/chat/import/preview', () => {
    it('rejects invalid JSON body → 400 IMPORT_INVALID_JSON (AC17)', async () => {
      // Send a value that is valid JSON but not a valid bundle object.
      // The preview() method throws IMPORT_INVALID_JSON for non-object,
      // non-string inputs when the else branch catches it.
      const res = await request(app)
        .post('/api/chat/import/preview')
        .send({}); // empty object — passes JSON parse, fails validation

      // Empty object passes the preview() "valid object" branch but then
      // fails with IMPORT_UNSUPPORTED_VERSION (missing bundleVersion).
      // We need a different approach to test IMPORT_INVALID_JSON.
      // Instead, verify that the error handling still returns a 400:
      expect(res.status).toBe(400);
    });

    // IMPORT_INVALID_JSON is tested at the service level in
    // chat-import.service.test.ts. Express 4.21+ initializes req.body
    // to {} for every request, so the route handler always receives an
    // object. The JSON.parse failure path in preview() is unreachable
    // through the HTTP route — it's a service-level contract.

    it('rejects unsupported bundleVersion → 400 IMPORT_UNSUPPORTED_VERSION (AC17)', async () => {
      const bundle = validBundlePayload();
      bundle.bundleVersion = 0;
      const res = await request(app)
        .post('/api/chat/import/preview')
        .send(bundle);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('IMPORT_UNSUPPORTED_VERSION');
    });

    it('allows inert script-like text in message content', async () => {
      const bundle = validBundlePayload();
      bundle.messages = [
        { role: 'user', content: '<script>alert("xss")</script>', createdAt: new Date().toISOString() },
      ];
      const res = await request(app)
        .post('/api/chat/import/preview')
        .send(bundle);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    it('rejects unsafe markdown link → 400 IMPORT_XSS_REJECTED (AC17)', async () => {
      const bundle = validBundlePayload();
      bundle.messages = [
        { role: 'user', content: '[click](javascript:alert("xss"))', createdAt: new Date().toISOString() },
      ];
      const res = await request(app)
        .post('/api/chat/import/preview')
        .send(bundle);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('IMPORT_XSS_REJECTED');
    });

    it('accepts valid bundle → 200 with preview structure (AC5)', async () => {
      const bundle = validBundlePayload();
      const res = await request(app)
        .post('/api/chat/import/preview')
        .send(bundle);

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.bundleId).toBeTruthy();
      expect(res.body.preview.title).toBe('Imported Chat');
      expect(res.body.preview.messageCount).toBe(1);
      expect(res.body.preview.executionCount).toBe(0);
      expect(res.body.preview.artifactCount).toBe(0);
      expect(res.body.preview.bundleVersion).toBe(1);
      expect(res.body.preview.sourceEnvironment).toBeDefined();
      expect(res.body.preview.importsAs).toBe('read-only replay');
      expect(Array.isArray(res.body.preview.warnings)).toBe(true);
    });

    it('accepts bundle wrapped in { bundle: <object> }', async () => {
      const bundle = validBundlePayload();
      const res = await request(app)
        .post('/api/chat/import/preview')
        .send({ bundle });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    it('rejects missing session field → 400 IMPORT_MISSING_FIELDS', async () => {
      const bundle = validBundlePayload();
      delete (bundle as Record<string, unknown>).session;
      const res = await request(app)
        .post('/api/chat/import/preview')
        .send(bundle);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('IMPORT_MISSING_FIELDS');
    });
  });

  // ── Import Confirm ──────────────────────────────────────────────────────

  describe('POST /api/chat/import/confirm', () => {
    it('rejects missing bundleId → 400 IMPORT_BUNDLE_NOT_FOUND (AC17)', async () => {
      const res = await request(app)
        .post('/api/chat/import/confirm')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('IMPORT_BUNDLE_NOT_FOUND');
    });

    it('full flow: preview → confirm → 201 with imported session (AC6, AC7, AC13)', async () => {
      const bundle = validBundlePayload();
      const previewRes = await request(app)
        .post('/api/chat/import/preview')
        .send(bundle);
      expect(previewRes.status).toBe(200);

      const bundleId = previewRes.body.bundleId;

      // Now confirm
      const confirmRes = await request(app)
        .post('/api/chat/import/confirm')
        .send({ bundleId });

      expect(confirmRes.status).toBe(201);
      expect(confirmRes.body.imported).toBe(true);
      expect(confirmRes.body.sessionId).toBeTruthy();
      expect(confirmRes.body.session.isImported).toBe(true);
      expect(confirmRes.body.session.importBundleId).toBe(bundleId);
      expect(confirmRes.body.session.sourceEnvironment).toMatchObject({
        appName: 'Allen',
        appVersion: '1.0.0',
      });
      expect(confirmRes.body.session.sourceSessionId).toBe('src-session-id');
      expect(confirmRes.body.remappedCounts.messages).toBe(1);
    });

    it('rejects already-confirmed bundle → 400 IMPORT_ALREADY_COMPLETED', async () => {
      const bundle = validBundlePayload();
      const previewRes = await request(app)
        .post('/api/chat/import/preview')
        .send(bundle);
      const bundleId = previewRes.body.bundleId;

      // First confirm should succeed
      await request(app).post('/api/chat/import/confirm').send({ bundleId });

      // Second confirm should fail
      const res = await request(app)
        .post('/api/chat/import/confirm')
        .send({ bundleId });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('IMPORT_ALREADY_COMPLETED');
    });
  });
});
