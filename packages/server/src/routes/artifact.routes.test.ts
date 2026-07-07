import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifactRoutes } from './artifact.routes.js';
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
        content: 'not-really-binary',
        contentType: 'binary',
      });

    expect(res.status).toBe(201);
    const identity = await new DocumentService(db).findIdentityByArtifactId(res.body.artifactId);
    expect(identity).toBeNull();
  });
});
