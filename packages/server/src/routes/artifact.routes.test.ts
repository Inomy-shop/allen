import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifactRoutes, publicArtifactRoutes } from './artifact.routes.js';
import { DocumentService } from '../services/document.service.js';

describe('artifactRoutes', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;
  let uploadsDir: string;
  let previousUploadsDir: string | undefined;

  beforeAll(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'allen-artifact-routes-'));
    previousUploadsDir = process.env.UPLOADS_DIR;
    process.env.UPLOADS_DIR = uploadsDir;

    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('test-artifact-routes');
    await new DocumentService(db).ensureIndexes();
    app = express();
    app.use(express.json());
    app.use('/api/artifacts', publicArtifactRoutes(db));
    app.use('/api/artifacts', artifactRoutes(db));
  });

  afterAll(async () => {
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    await client.close();
    await mongo.stop();
    await rm(uploadsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.collection('artifacts').deleteMany({});
    await db.collection('document_identities').deleteMany({});
    await db.collection('document_comments').deleteMany({});
  });

  it('creates a document identity by default for text-backed artifacts', async () => {
    const res = await request(app)
      .post('/api/artifacts')
      .send({
        rootType: 'chat',
        rootId: 'chat-1',
        filename: 'plan.md',
        content: '# Plan\n\nShip unified artifacts.',
        contentType: 'markdown',
      });

    expect(res.status).toBe(201);
    const identity = await new DocumentService(db).findIdentityByArtifactId(res.body.artifactId);
    expect(identity).toBeTruthy();
    expect(identity?.sourceArtifactId).toBe(res.body.artifactId);
    expect(identity?.contentType).toBe('markdown');
    expect(identity?.versions[0]?.content).toContain('Ship unified artifacts.');
  });

  it('inherits its parent classification and supports a manual override', async () => {
    const chatId = new ObjectId();
    await db.collection('chat_sessions').insertOne({
      _id: chatId,
      title: 'Product planning',
      teamClassification: 'product',
      teamClassificationSource: 'manual',
    });

    const created = await request(app)
      .post('/api/artifacts')
      .send({
        rootType: 'chat',
        rootId: chatId.toHexString(),
        filename: 'requirements.md',
        content: '# Requirements',
        contentType: 'markdown',
      })
      .expect(201);

    const inherited = await request(app).get(`/api/artifacts/${created.body.artifactId}`).expect(200);
    expect(inherited.body).toMatchObject({
      teamClassification: 'product',
      teamClassificationSource: 'inherited',
    });

    const overridden = await request(app)
      .patch(`/api/artifacts/${created.body.artifactId}/classification`)
      .send({ teamClassification: 'design' })
      .expect(200);
    expect(overridden.body).toMatchObject({
      teamClassification: 'design',
      teamClassificationSource: 'manual',
    });

    await request(app)
      .patch(`/api/artifacts/${created.body.artifactId}/classification`)
      .send({ teamClassification: 'sales' })
      .expect(400);
  });

  it('adds a document version when an existing artifact is overwritten', async () => {
    const first = await request(app)
      .post('/api/artifacts')
      .send({
        rootType: 'workflow',
        rootId: 'exec-1',
        filename: 'summary.txt',
        content: 'First version',
        contentType: 'text',
        overwrite: true,
      });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/artifacts')
      .send({
        rootType: 'workflow',
        rootId: 'exec-1',
        filename: 'summary.txt',
        content: 'Second version',
        contentType: 'text',
        overwrite: true,
      });
    expect(second.status).toBe(201);
    expect(second.body.artifactId).toBe(first.body.artifactId);

    const identity = await new DocumentService(db).findIdentityByArtifactId(first.body.artifactId);
    expect(identity?.latestVersionNumber).toBe(2);
    expect(identity?.versions[1]?.content).toBe('Second version');
  });

  it('does not create a document identity for binary artifacts', async () => {
    const res = await request(app)
      .post('/api/artifacts')
      .send({
        rootType: 'agent',
        rootId: 'agent-1',
        filename: 'archive.zip',
        content: Buffer.from('binary bytes').toString('base64'),
        contentType: 'binary',
      });

    expect(res.status).toBe(201);
    const identity = await new DocumentService(db).findIdentityByArtifactId(res.body.artifactId);
    expect(identity).toBeNull();
  });

  it('keeps saved and favorite library state independent', async () => {
    const created = await request(app)
      .post('/api/artifacts')
      .send({
        rootType: 'chat',
        rootId: 'chat-library',
        filename: 'library-note.md',
        content: '# Library note',
        contentType: 'markdown',
      });
    expect(created.status).toBe(201);

    const initial = await request(app).get(`/api/artifacts/${created.body.artifactId}`);
    expect(initial.body).toMatchObject({ saved: false, favorite: false });

    const saved = await request(app)
      .patch(`/api/artifacts/${created.body.artifactId}/library-state`)
      .send({ saved: true });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ saved: true, favorite: false });
    expect(saved.body.savedByUserIds).toBeUndefined();
    expect(saved.body.favoriteByUserIds).toBeUndefined();

    const favorited = await request(app)
      .patch(`/api/artifacts/${created.body.artifactId}/library-state`)
      .send({ favorite: true });
    expect(favorited.body).toMatchObject({ saved: true, favorite: true });

    const removed = await request(app)
      .patch(`/api/artifacts/${created.body.artifactId}/library-state`)
      .send({ saved: false });
    expect(removed.body).toMatchObject({ saved: false, favorite: false });
  });

  const binaryCases = [
    { filename: 'pixel.png', mime: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]) },
    { filename: 'report.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7\n%\xff\xff\n', 'latin1') },
    { filename: 'clip.mp4', mime: 'video/mp4', bytes: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0x01]) },
    { filename: 'clip.webm', mime: 'video/webm', bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0xff]) },
  ];

  for (const { filename, mime, bytes } of binaryCases) {
    it(`decodes and serves original ${filename} bytes with media headers`, async () => {
      const created = await request(app)
        .post('/api/artifacts')
        .send({
          rootType: 'agent',
          rootId: `binary-${filename}`,
          filename,
          content: bytes.toString('base64'),
          contentType: 'binary',
        });

      expect(created.status).toBe(201);
      expect(created.body.sizeBytes).toBe(bytes.length);
      expect(created.body.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

      const served = await request(app)
        .get(`/api/artifacts/${created.body.artifactId}/content`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe(mime);
      expect(served.headers['content-length']).toBe(String(bytes.length));
      expect(served.headers['accept-ranges']).toBe('bytes');
      expect(served.headers.etag).toBe(`"${createHash('sha256').update(bytes).digest('hex')}"`);
      expect(Buffer.compare(served.body as Buffer, bytes)).toBe(0);
    });
  }

  it('serves byte ranges for playable media', async () => {
    const bytes = binaryCases[2].bytes;
    const created = await request(app)
      .post('/api/artifacts')
      .send({
        rootType: 'chat',
        rootId: 'video-range',
        filename: 'clip.mp4',
        content: bytes.toString('base64'),
        contentType: 'binary',
      });

    const served = await request(app)
      .get(`/api/artifacts/${created.body.artifactId}/content`)
      .set('Range', 'bytes=2-5')
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(served.status).toBe(206);
    expect(served.headers['content-range']).toBe(`bytes 2-5/${bytes.length}`);
    expect(served.headers['content-length']).toBe('4');
    expect(Buffer.compare(served.body as Buffer, bytes.subarray(2, 6))).toBe(0);
  });

  it('rejects invalid base64 for binary artifacts', async () => {
    const res = await request(app)
      .post('/api/artifacts')
      .send({
        rootType: 'agent',
        rootId: 'invalid-binary',
        filename: 'broken.png',
        content: 'not-base64',
        contentType: 'binary',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid base64/);
  });

  for (const [contentType, filename, content, mime] of [
    ['markdown', 'notes.md', '# Notes\n', 'text/markdown; charset=utf-8'],
    ['json', 'data.json', '{"ok":true}', 'application/json; charset=utf-8'],
    ['csv', 'data.csv', 'name,value\nalpha,1\n', 'text/csv; charset=utf-8'],
    ['text', 'notes.txt', 'plain text', 'text/plain; charset=utf-8'],
  ] as const) {
    it(`preserves ${contentType} artifact text delivery`, async () => {
      const created = await request(app)
        .post('/api/artifacts')
        .send({ rootType: 'chat', rootId: `text-${contentType}`, filename, content, contentType });
      const served = await request(app)
        .get(`/api/artifacts/${created.body.artifactId}/content`);

      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe(mime);
      expect(served.text).toBe(content);
      expect(created.body.sizeBytes).toBe(Buffer.byteLength(content));
      expect(created.body.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    });
  }
});
