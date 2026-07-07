/**
 * Document routes integration tests.
 *
 * Pattern: Vitest + MongoMemoryServer + supertest (see workflow.routes.test.ts).
 */
import { vi } from 'vitest';

vi.mock('../services/artifact.service.js');

import express from 'express';
import request from 'supertest';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { documentRoutes } from './document.routes.js';
import { DocumentService } from '../services/document.service.js';
import { ArtifactService, type ArtifactDoc } from '../services/artifact.service.js';

describe('documentRoutes', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;
  let service: DocumentService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('test-doc-routes');
    service = new DocumentService(db);
    await service.ensureIndexes();
    app = express();
    app.use(express.json());
    app.use('/api/documents', documentRoutes(db));
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    await db.collection('document_identities').deleteMany({});
    await db.collection('document_comments').deleteMany({});
    await db.collection('artifacts').deleteMany({});
    await db.collection('users').deleteMany({});
  });

  // Helper: seed an artifact for document creation tests
  async function seedArtifact(overrides: Partial<ArtifactDoc> = {}): Promise<string> {
    const artifactService = new ArtifactService(db);
    const result = await artifactService.save({
      rootType: 'workflow',
      rootId: 'test-root',
      filename: 'test-doc.md',
      content: '# Test Document\n\nHello world\n\nThis is test content.',
      contentType: 'markdown',
      overwrite: true,
    });
    return result.artifactId;
  }

  // Helper: seed a document identity
  async function seedDocument(overrides: Partial<{
    documentId: string;
    sourceArtifactId: string;
    content: string;
    versions: any[];
  }> = {}): Promise<string> {
    const documentId = overrides.documentId ?? 'test-doc-id';
    const sourceArtifactId = overrides.sourceArtifactId ?? 'test-artifact';
    const versions = overrides.versions ?? [
      {
        versionNumber: 1,
        content: overrides.content ?? '# Document\n\nVersion 1 content',
        contentHash: 'hash-v1',
        createdByOriginType: 'system' as const,
        createdAt: new Date(),
      },
    ];
    await db.collection('document_identities').insertOne({
      documentId,
      sourceArtifactId,
      versions,
      latestVersionNumber: versions.length,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return documentId;
  }

  // ── D0: GET /by-artifact/:artifactId ──

  it('D0 returns 404 for unknown artifact', async () => {
    const res = await request(app).get('/api/documents/by-artifact/unknown');
    expect(res.status).toBe(404);
    expect(res.body.eligibleForCommenting).toBe(false);
  });

  it('D0 returns 200 with document info when identity exists', async () => {
    const docId = await seedDocument({ documentId: 'd0-doc', sourceArtifactId: 'd0-art' });
    const res = await request(app).get('/api/documents/by-artifact/d0-art');
    expect(res.status).toBe(200);
    expect(res.body.documentId).toBe('d0-doc');
    expect(res.body.latestVersionNumber).toBe(1);
  });

  it('D0 returns 200 via documentId lookup', async () => {
    const docId = await seedDocument({ documentId: 'd0-doc2', sourceArtifactId: 'd0-art2' });
    const res = await request(app).get('/api/documents/by-artifact/d0-doc2');
    expect(res.status).toBe(200);
    expect(res.body.documentId).toBe('d0-doc2');
  });

  // ── D1: POST / ──

  it('D1 returns 400 when artifactId missing', async () => {
    const res = await request(app).post('/api/documents').send({});
    expect(res.status).toBe(400);
  });

  it('D1 returns 409 when identity already exists', async () => {
    const docId = await seedDocument({ documentId: 'existing-doc', sourceArtifactId: 'existing-art' });
    const res = await request(app).post('/api/documents').send({
      artifactId: 'existing-art',
    });
    // The doc already exists under sourceArtifactId 'existing-art'
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDENTITY_EXISTS');
  });

  // ── D2: GET /:documentId ──

  it('D2 returns 404 for unknown document', async () => {
    const res = await request(app).get('/api/documents/unknown');
    expect(res.status).toBe(404);
  });

  it('D2 returns document summary', async () => {
    await seedDocument({
      documentId: 'd2-doc',
      sourceArtifactId: 'd2-art',
      content: '# D2\n\nSummary test',
    });
    const res = await request(app).get('/api/documents/d2-doc');
    expect(res.status).toBe(200);
    expect(res.body.documentId).toBe('d2-doc');
    expect(res.body.latestContent).toBeDefined();
    expect(typeof res.body.unresolvedCommentCount).toBe('number');
  });

  // ── D3: GET /:documentId/versions ──

  it('D3 returns version list', async () => {
    await seedDocument({ documentId: 'd3-doc' });
    const res = await request(app).get('/api/documents/d3-doc/versions');
    expect(res.status).toBe(200);
    expect(res.body.documentId).toBe('d3-doc');
    expect(Array.isArray(res.body.versions)).toBe(true);
    expect(res.body.versions[0].content).toBeUndefined(); // metadata only
  });

  // ── D4: GET /:documentId/versions/:versionNumber ──

  it('D4 returns specific version with content', async () => {
    await seedDocument({ documentId: 'd4-doc' });
    const res = await request(app).get('/api/documents/d4-doc/versions/1');
    expect(res.status).toBe(200);
    expect(res.body.version.versionNumber).toBe(1);
    expect(res.body.version.content).toBeDefined();
    expect(res.body.isLatest).toBe(true);
  });

  it('D4 returns 404 for nonexistent version', async () => {
    await seedDocument({ documentId: 'd4-doc2' });
    const res = await request(app).get('/api/documents/d4-doc2/versions/999');
    expect(res.status).toBe(404);
  });

  // ── D7: GET /:documentId/versions/compare (test ordering BEFORE D4) ──

  it('D7 compare route works (not captured by :versionNumber)', async () => {
    const documentId = 'd7-doc';
    await db.collection('document_identities').insertOne({
      documentId,
      sourceArtifactId: 'd7-art',
      versions: [
        {
          versionNumber: 1,
          content: 'line A\nline B\nline C',
          contentHash: 'hash-v1',
          createdByOriginType: 'system',
          createdAt: new Date(),
        },
        {
          versionNumber: 2,
          content: 'line A\nline B modified\nline C\nline D',
          contentHash: 'hash-v2',
          createdByOriginType: 'agent',
          createdByAgentName: 'test-agent',
          createdAt: new Date(),
        },
      ],
      latestVersionNumber: 2,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app).get(`/api/documents/${documentId}/versions/compare?v1=1&v2=2`);
    expect(res.status).toBe(200);
    expect(res.body.diff).toBeDefined();
    expect(Array.isArray(res.body.diff)).toBe(true);
    expect(res.body.stats).toBeDefined();
  });

  it('D7 returns 400 for missing v1/v2 params', async () => {
    await seedDocument({ documentId: 'd7-doc2' });
    const res = await request(app).get('/api/documents/d7-doc2/versions/compare');
    expect(res.status).toBe(400);
  });

  // ── D5: POST /:documentId/versions ──

  it('D5 creates a new version', async () => {
    await seedDocument({
      documentId: 'd5-doc',
      content: 'Original content',
    });
    const res = await request(app)
      .post('/api/documents/d5-doc/versions')
      .send({
        content: 'Updated content v2',
        createdReason: 'Updated the document',
      });
    expect(res.status).toBe(201);
    expect(res.body.versionNumber).toBe(2);
    expect(res.body.createdReason).toBe('Updated the document');
  });

  it('D5 returns 409 for unchanged content', async () => {
    await seedDocument({
      documentId: 'd5-doc2',
    });
    // First update
    await request(app)
      .post('/api/documents/d5-doc2/versions')
      .send({ content: 'Some new content' });
    // Same content again
    const res = await request(app)
      .post('/api/documents/d5-doc2/versions')
      .send({ content: 'Some new content' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTENT_UNCHANGED');
  });

  // ── D6: POST /:documentId/versions/:versionNumber/restore ──

  it('D6 restores a previous version', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'd6-doc',
      sourceArtifactId: 'd6-art',
      versions: [
        {
          versionNumber: 1,
          content: 'Original version',
          contentHash: 'hash1',
          createdByOriginType: 'system',
          createdAt: new Date(),
        },
        {
          versionNumber: 2,
          content: 'Modified version',
          contentHash: 'hash2',
          createdByOriginType: 'agent',
          createdByAgentName: 'agent',
          createdAt: new Date(),
        },
      ],
      latestVersionNumber: 2,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/documents/d6-doc/versions/1/restore');
    expect(res.status).toBe(201);
    expect(res.body.newVersionNumber).toBe(3);
    expect(res.body.restoredFromVersion).toBe(1);
  });

  // ── D8: GET /:documentId/comments ──

  it('D8 returns comments list', async () => {
    await seedDocument({ documentId: 'd8-doc' });
    // Seed a comment
    await db.collection('document_comments').insertOne({
      commentId: 'd8-cmt',
      documentId: 'd8-doc',
      threadId: 'd8-thread',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'Test comment',
      status: 'open',
      anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'test', anchoredAtVersion: 1 },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app).get('/api/documents/d8-doc/comments');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
  });

  // ── D9: POST /:documentId/comments ──

  it('D9 creates a comment', async () => {
    await seedDocument({
      documentId: 'd9-doc',
      content: 'Commentable document',
    });
    const res = await request(app)
      .post('/api/documents/d9-doc/comments')
      .send({
        body: 'Great document',
        anchor: {
          type: 'line',
          lineStart: 1,
          lineEnd: 1,
          snippet: 'Commentable document',
          context: 'Commentable document',
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.commentId).toBeDefined();
    expect(res.body.body).toBe('Great document');
    expect(res.body.status).toBe('open');
  });

  it('D9 returns 400 for missing body', async () => {
    await seedDocument({ documentId: 'd9-doc2' });
    const res = await request(app)
      .post('/api/documents/d9-doc2/comments')
      .send({ anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'test', anchoredAtVersion: 1 } });
    expect(res.status).toBe(400);
  });

  // ── D10: POST /:documentId/comments/:commentId/reply ──

  it('D10 creates a reply', async () => {
    await seedDocument({ documentId: 'd10-doc' });
    await db.collection('document_comments').insertOne({
      commentId: 'd10-parent',
      documentId: 'd10-doc',
      threadId: 'd10-thread',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'Parent comment',
      status: 'open',
      anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'test', anchoredAtVersion: 1 },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/documents/d10-doc/comments/d10-parent/reply')
      .send({ body: 'This is a reply' });
    expect(res.status).toBe(201);
    expect(res.body.parentCommentId).toBe('d10-parent');
    expect(res.body.body).toBe('This is a reply');
  });

  // ── D11: POST /:documentId/comments/:commentId/resolve ──

  it('D11 resolves a comment', async () => {
    await seedDocument({ documentId: 'd11-doc' });
    await db.collection('document_comments').insertOne({
      commentId: 'd11-cmt',
      documentId: 'd11-doc',
      threadId: 'd11-thread',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'Fix this',
      status: 'open',
      anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'test', anchoredAtVersion: 1 },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/documents/d11-doc/comments/d11-cmt/resolve')
      .send({ resolutionNote: 'Fixed in v2' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
  });

  it('D11 returns 409 for already resolved', async () => {
    await seedDocument({ documentId: 'd11-doc2' });
    await db.collection('document_comments').insertOne({
      commentId: 'd11-cmt2',
      documentId: 'd11-doc2',
      threadId: 'd11-thread2',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'Already fixed',
      status: 'resolved',
      anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'test', anchoredAtVersion: 1 },
      resolution: {
        resolvedByUserId: 'user-1',
        resolvedAtVersion: 1,
        resolutionNote: 'Done',
        resolvedAt: new Date(),
      },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/documents/d11-doc2/comments/d11-cmt2/resolve')
      .send({ resolutionNote: 'Again' });
    expect(res.status).toBe(409);
  });

  // ── D12: POST /:documentId/comments/:commentId/reopen ──

  it('D12 reopens a resolved comment', async () => {
    await seedDocument({ documentId: 'd12-doc' });
    await db.collection('document_comments').insertOne({
      commentId: 'd12-cmt',
      documentId: 'd12-doc',
      threadId: 'd12-thread',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'Resolved comment to reopen',
      status: 'resolved',
      anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'test', anchoredAtVersion: 1 },
      resolution: {
        resolvedByUserId: 'user-1',
        resolvedAtVersion: 1,
        resolutionNote: 'Done',
        resolvedAt: new Date(),
      },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/documents/d12-doc/comments/d12-cmt/reopen');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
    expect(res.body.reopenCount).toBe(1);
  });

  // ── D13: GET /:documentId/timeline ──

  it('D13 returns timeline events', async () => {
    await seedDocument({
      documentId: 'd13-doc',
      content: 'Timeline doc',
    });
    const res = await request(app).get('/api/documents/d13-doc/timeline');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].eventType).toBeDefined();
  });

  it('enriches human comment actors with user name and email', async () => {
    await seedDocument({ documentId: 'actor-doc', content: 'Actor doc' });
    const userId = new ObjectId();
    await db.collection('users').insertOne({
      _id: userId,
      email: 'alice@test.local',
      name: 'Alice',
      role: 'user',
      passwordHash: 'hash',
      mustResetPassword: false,
      createdBy: 'system',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null,
    });
    await db.collection('document_comments').insertOne({
      commentId: 'actor-cmt',
      documentId: 'actor-doc',
      threadId: 'actor-thread',
      authorType: 'human',
      authorUserId: userId.toHexString(),
      body: 'Needs a label',
      status: 'open',
      anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'Actor doc', anchoredAtVersion: 1 },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app).get('/api/documents/actor-doc/comments?status=all');
    expect(res.status).toBe(200);
    expect(res.body[0].authorDisplayName).toBe('Alice');
    expect(res.body[0].authorEmail).toBe('alice@test.local');
  });
});
