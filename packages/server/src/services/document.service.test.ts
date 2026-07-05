/**
 * DocumentService unit tests.
 *
 * Pattern: Vitest + MongoMemoryServer (see workflow.routes.test.ts).
 */
import { vi } from 'vitest';

vi.mock('../services/artifact.service.js', () => {
  const actual = vi.importActual('../services/artifact.service.js');
  return actual;
});

import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentService, computeDiff, type DocumentIdentityDoc, type DocumentCommentDoc } from './document.service.js';

describe('DocumentService', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let service: DocumentService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('test-docs');
    service = new DocumentService(db);
    await service.ensureIndexes();
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    await db.collection('document_identities').deleteMany({});
    await db.collection('document_comments').deleteMany({});
  });

  // ── createFromArtifact ──

  it('rejects createFromArtifact with missing artifactId', async () => {
    await expect(service.createFromArtifact('')).rejects.toThrow();
    await expect(service.createFromArtifact('  ')).rejects.toThrow();
  });

  it('returns 404 when artifact not found', async () => {
    await expect(service.createFromArtifact('nonexistent-id')).rejects.toMatchObject({
      code: 'ARTIFACT_NOT_FOUND',
    });
  });

  // ── Version Management ──

  it('addVersion rejects missing content', async () => {
    await expect(service.addVersion('any', '')).rejects.toMatchObject({
      code: 'CONTENT_REQUIRED',
    });
  });

  it('addVersion rejects duplicate content (same hash)', async () => {
    // Create a minimal identity with a seeded version
    await db.collection('document_identities').insertOne({
      documentId: 'doc-1',
      sourceArtifactId: 'art-1',
      versions: [{
        versionNumber: 1,
        content: 'hello world',
        contentHash: 'hashed',
        createdByOriginType: 'system',
        createdAt: new Date(),
      }],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Since the content hash won't match our manual hash, add a version first
    // then try to add the same content again
    const result1 = await service.addVersion('doc-1', 'new content', {
      createdByAgentName: 'test-agent',
      createdReason: 'first update',
    });
    expect(result1.versionNumber).toBe(2);

    // Now try to add the same content again
    await expect(service.addVersion('doc-1', 'new content', {
      createdByAgentName: 'test-agent',
    })).rejects.toMatchObject({
      code: 'CONTENT_UNCHANGED',
    });
  });

  it('addVersion increments version number', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-version',
      sourceArtifactId: 'art-1',
      versions: [{
        versionNumber: 1,
        content: 'v1 content',
        contentHash: 'abc123hash',
        createdByOriginType: 'system',
        createdAt: new Date(),
      }],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.addVersion('doc-version', 'v2 content', {
      createdByAgentName: 'test-agent',
      createdReason: 'added paragraph',
    });
    expect(result.versionNumber).toBe(2);
    expect(result.createdReason).toBe('added paragraph');
    expect(result.createdByAgentName).toBe('test-agent');
    expect(result.createdByOriginType).toBe('agent');
  });

  it('restoreVersion creates a new latest with historic content', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-restore',
      sourceArtifactId: 'art-1',
      versions: [
        {
          versionNumber: 1,
          content: 'original content',
          contentHash: 'hash1',
          createdByOriginType: 'system',
          createdAt: new Date(),
        },
        {
          versionNumber: 2,
          content: 'modified content',
          contentHash: 'hash2',
          createdByOriginType: 'agent',
          createdAt: new Date(),
        },
      ],
      latestVersionNumber: 2,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.restoreVersion('doc-restore', 1);
    expect(result.newVersionNumber).toBe(3);
    expect(result.restoredFromVersion).toBe(1);
    expect(result.createdReason).toContain('Restored from version 1');

    // Verify the restored content
    const versionDetail = await service.getVersion('doc-restore', 3);
    expect(versionDetail.version.content).toBe('original content');
    expect(versionDetail.isLatest).toBe(true);
  });

  it('restoreVersion returns 409 when restored content matches latest', async () => {
    const content = 'same content';
    const { createHash } = await import('node:crypto');
    const realHash = createHash('sha256').update(content).digest('hex');

    await db.collection('document_identities').insertOne({
      documentId: 'doc-restore-dup',
      sourceArtifactId: 'art-1',
      versions: [
        {
          versionNumber: 1,
          content,
          contentHash: realHash,
          createdByOriginType: 'system',
          createdAt: new Date(),
        },
      ],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Since the only version is the latest, restoring it should detect same hash
    await expect(service.restoreVersion('doc-restore-dup', 1)).rejects.toMatchObject({
      code: 'CONTENT_UNCHANGED',
    });
  });

  // ── Comments ──

  it('addComment creates a top-level comment with threadId', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-cmt',
      sourceArtifactId: 'art-1',
      versions: [{
        versionNumber: 1,
        content: 'doc content',
        contentHash: 'hash',
        createdByOriginType: 'system',
        createdAt: new Date(),
      }],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const comment = await service.addComment(
      'doc-cmt',
      'This is a comment',
      {
        type: 'line',
        lineStart: 1,
        lineEnd: 1,
        snippet: 'doc content',
        context: 'doc content',
        anchoredAtVersion: 1,
      },
      { userId: 'user-1' },
    );

    expect(comment.commentId).toBeDefined();
    expect(comment.threadId).toBeDefined();
    expect(comment.parentCommentId).toBeUndefined();
    expect(comment.authorType).toBe('human');
    expect(comment.authorUserId).toBe('user-1');
    expect(comment.body).toBe('This is a comment');
    expect(comment.status).toBe('open');
  });

  it('addReply inherits threadId from parent', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-reply',
      sourceArtifactId: 'art-1',
      versions: [{
        versionNumber: 1,
        content: 'doc content',
        contentHash: 'hash',
        createdByOriginType: 'system',
        createdAt: new Date(),
      }],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Seed a parent comment
    await db.collection('document_comments').insertOne({
      commentId: 'parent-1',
      documentId: 'doc-reply',
      threadId: 'thread-1',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'Parent comment',
      status: 'open',
      anchor: {
        type: 'line',
        lineStart: 1,
        lineEnd: 1,
        context: 'doc content',
        anchoredAtVersion: 1,
      },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const reply = await service.addReply(
      'doc-reply',
      'parent-1',
      'This is a reply',
      { agentName: 'test-agent' },
    );

    expect(reply.parentCommentId).toBe('parent-1');
    expect(reply.threadId).toBe('thread-1');
    expect(reply.authorType).toBe('agent');
    expect(reply.authorAgentName).toBe('test-agent');
    expect(reply.body).toBe('This is a reply');
  });

  it('resolveComment rejects already resolved comments', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-resolve',
      sourceArtifactId: 'art-1',
      versions: [{
        versionNumber: 1,
        content: 'content',
        contentHash: 'hash',
        createdByOriginType: 'system',
        createdAt: new Date(),
      }],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection('document_comments').insertOne({
      commentId: 'cmt-1',
      documentId: 'doc-resolve',
      threadId: 'thread-1',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'Fix this',
      status: 'resolved',
      anchor: {
        type: 'line',
        lineStart: 1,
        lineEnd: 1,
        context: 'content',
        anchoredAtVersion: 1,
      },
      resolution: {
        resolvedByUserId: 'user-1',
        resolvedAtVersion: 1,
        resolutionNote: 'Fixed',
        resolvedAt: new Date(),
      },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.resolveComment('doc-resolve', 'cmt-1', 'trying again', {
      userId: 'user-1',
    })).rejects.toMatchObject({
      code: 'COMMENT_ALREADY_RESOLVED',
    });
  });

  it('reopenComment rejects already open comments', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-reopen',
      sourceArtifactId: 'art-1',
      versions: [{
        versionNumber: 1,
        content: 'content',
        contentHash: 'hash',
        createdByOriginType: 'system',
        createdAt: new Date(),
      }],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection('document_comments').insertOne({
      commentId: 'cmt-2',
      documentId: 'doc-reopen',
      threadId: 'thread-2',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'Open comment',
      status: 'open',
      anchor: {
        type: 'line',
        lineStart: 1,
        lineEnd: 1,
        context: 'content',
        anchoredAtVersion: 1,
      },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.reopenComment('doc-reopen', 'cmt-2', 'user-1')).rejects.toMatchObject({
      code: 'COMMENT_ALREADY_OPEN',
    });
  });

  it('reopenComment rejects stale comments', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-reopen-stale',
      sourceArtifactId: 'art-1',
      versions: [{
        versionNumber: 1,
        content: 'content',
        contentHash: 'hash',
        createdByOriginType: 'system',
        createdAt: new Date(),
      }],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection('document_comments').insertOne({
      commentId: 'cmt-stale',
      documentId: 'doc-reopen-stale',
      threadId: 'thread-3',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'Stale comment',
      status: 'stale',
      anchor: {
        type: 'line',
        lineStart: 1,
        lineEnd: 1,
        context: 'content',
        anchoredAtVersion: 1,
        staleReason: 'Anchor not found',
        staleAt: new Date(),
      },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.reopenComment('doc-reopen-stale', 'cmt-stale', 'user-1')).rejects.toMatchObject({
      code: 'COMMENT_IS_STALE',
    });
  });

  it('resolveComment works end-to-end', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-resolve-ok',
      sourceArtifactId: 'art-1',
      versions: [{
        versionNumber: 1,
        content: 'content',
        contentHash: 'hash',
        createdByOriginType: 'system',
        createdAt: new Date(),
      }],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection('document_comments').insertOne({
      commentId: 'cmt-resolve',
      documentId: 'doc-resolve-ok',
      threadId: 'thread-resolve',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'Fix this problem',
      status: 'open',
      anchor: {
        type: 'line',
        lineStart: 1,
        lineEnd: 1,
        context: 'content',
        anchoredAtVersion: 1,
      },
      reopenCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resolved = await service.resolveComment('doc-resolve-ok', 'cmt-resolve', 'Fixed in version 2', {
      userId: 'user-1',
    });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution?.resolutionNote).toBe('Fixed in version 2');
    expect(resolved.resolution?.resolvedAtVersion).toBe(1);
  });

  // ── compareVersions diff ──

  it('compareVersions produces correct diff', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-diff',
      sourceArtifactId: 'art-1',
      versions: [
        {
          versionNumber: 1,
          content: 'line1\nline2\nline3',
          contentHash: 'hash1',
          createdByOriginType: 'system',
          createdAt: new Date(),
          addressedCommentIds: [],
        },
        {
          versionNumber: 2,
          content: 'line1\nline2_modified\nline3\nline4',
          contentHash: 'hash2',
          createdByOriginType: 'agent',
          createdAt: new Date(),
          addressedCommentIds: [],
        },
      ],
      latestVersionNumber: 2,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.compareVersions('doc-diff', 1, 2);
    expect(result.v1.versionNumber).toBe(1);
    expect(result.v2.versionNumber).toBe(2);
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.stats.linesAdded + result.stats.linesRemoved + result.stats.linesModified + result.stats.linesUnchanged)
      .toBe(result.diff.length);
  });

  // ── listComments status filter ──

  it('listComments filters by status', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-filter',
      sourceArtifactId: 'art-1',
      versions: [{
        versionNumber: 1,
        content: 'content',
        contentHash: 'hash',
        createdByOriginType: 'system',
        createdAt: new Date(),
      }],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection('document_comments').insertMany([
      {
        commentId: 'cmt-open',
        documentId: 'doc-filter',
        threadId: 't1',
        authorType: 'human',
        body: 'Open one',
        status: 'open',
        anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'content', anchoredAtVersion: 1 },
        reopenCount: 0,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      },
      {
        commentId: 'cmt-resolved',
        documentId: 'doc-filter',
        threadId: 't2',
        authorType: 'human',
        body: 'Resolved one',
        status: 'resolved',
        anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'content', anchoredAtVersion: 1 },
        resolution: {
          resolvedByUserId: 'user-1',
          resolvedAtVersion: 1,
          resolutionNote: 'done',
          resolvedAt: new Date(),
        },
        reopenCount: 0,
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-02'),
      },
    ]);

    const openComments = await service.listComments('doc-filter', 'open');
    expect(openComments).toHaveLength(1);
    expect(openComments[0].commentId).toBe('cmt-open');

    const resolvedComments = await service.listComments('doc-filter', 'resolved');
    expect(resolvedComments).toHaveLength(1);
    expect(resolvedComments[0].commentId).toBe('cmt-resolved');

    const allComments = await service.listComments('doc-filter', 'all');
    expect(allComments).toHaveLength(2);
  });

  // ── Timeline ordering ──

  it('getTimeline returns reverse chronological events', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-timeline',
      sourceArtifactId: 'art-1',
      versions: [
        {
          versionNumber: 1,
          content: 'v1',
          contentHash: 'hash1',
          createdByOriginType: 'system',
          createdAt: new Date('2024-01-01'),
        },
        {
          versionNumber: 2,
          content: 'v2',
          contentHash: 'hash2',
          createdByOriginType: 'agent',
          createdByAgentName: 'test-agent',
          createdReason: 'Updated content',
          createdAt: new Date('2024-01-02'),
        },
      ],
      latestVersionNumber: 2,
      contentType: 'markdown',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-02'),
    });

    await db.collection('document_comments').insertOne({
      commentId: 'cmt-timeline',
      documentId: 'doc-timeline',
      threadId: 't-timeline',
      authorType: 'human',
      authorUserId: 'user-1',
      body: 'A comment',
      status: 'open',
      anchor: { type: 'line', lineStart: 1, lineEnd: 1, context: 'v1', anchoredAtVersion: 1 },
      reopenCount: 0,
      createdAt: new Date('2024-01-01T12:00:00Z'),
      updatedAt: new Date('2024-01-01T12:00:00Z'),
    });

    const events = await service.getTimeline('doc-timeline');
    // Events: version_created(v1), version_created(v2), comment_created
    // Should be sorted reverse chrono: v2 first, then comment, then v1
    expect(events.length).toBe(3);
    expect(events[0].eventType).toBe('version_created');
    expect((events[0].data as any).versionNumber).toBe(2);
  });

  // ── computeDiff helper ──

  it('computeDiff returns empty array for identical content', () => {
    const result = computeDiff('line1\nline2\nline3', 'line1\nline2\nline3');
    expect(result.every((l) => l.type === 'unchanged')).toBe(true);
  });

  it('computeDiff detects additions and removals', () => {
    const result = computeDiff('line1\nline2', 'line1\nline2\nline3');
    const additions = result.filter((l) => l.type === 'added');
    expect(additions.length).toBe(1);
    expect(additions[0].text).toBe('line3');
  });

  // ── findIdentityByArtifactId ──

  it('findIdentityByArtifactId returns null for unknown artifact', async () => {
    const identity = await service.findIdentityByArtifactId('unknown');
    expect(identity).toBeNull();
  });

  it('findIdentityByArtifactId finds by documentId or sourceArtifactId', async () => {
    await db.collection('document_identities').insertOne({
      documentId: 'doc-found',
      sourceArtifactId: 'art-found',
      versions: [{
        versionNumber: 1,
        content: 'content',
        contentHash: 'hash',
        createdByOriginType: 'system',
        createdAt: new Date(),
      }],
      latestVersionNumber: 1,
      contentType: 'markdown',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Find by documentId
    const byDoc = await service.findIdentityByArtifactId('doc-found');
    expect(byDoc).not.toBeNull();
    expect(byDoc!.documentId).toBe('doc-found');

    // Find by sourceArtifactId
    const bySrc = await service.findIdentityByArtifactId('art-found');
    expect(bySrc).not.toBeNull();
    expect(bySrc!.sourceArtifactId).toBe('art-found');
  });
});
