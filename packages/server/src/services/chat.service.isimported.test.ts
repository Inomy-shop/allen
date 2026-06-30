/**
 * Tests for ChatService.isSessionImported() — integration with
 * MongoMemoryServer.
 *
 * @see PRD AC14 (no live continuation), AC16 (no intervention submission)
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';

// We can construct a minimal ChatService instance directly.
// Rather than importing the full class with dozens of dependencies, we test
// the same query pattern the chat routes use — the isSessionImported()
// method itself is a simple DB lookup.
//
// We test the actual ChatService.isSessionImported() integration with a real
// DB. For that we need to instantiate ChatService. Let's check its constructor.
import { ChatService } from './chat.service.js';

describe('ChatService.isSessionImported()', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let chatService: ChatService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('chat-isimported-test');
    chatService = new ChatService(db);
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

  it('returns true when session has isImported: true', async () => {
    const sessionId = new ObjectId().toString();
    await db.collection('chat_sessions').insertOne({
      _id: new ObjectId(sessionId),
      isImported: true,
      title: 'Imported replay',
      status: 'active',
      provider: 'claude',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await chatService.isSessionImported(sessionId);
    expect(result).toBe(true);
  });

  it('returns false when session has isImported: false', async () => {
    const sessionId = new ObjectId().toString();
    await db.collection('chat_sessions').insertOne({
      _id: new ObjectId(sessionId),
      isImported: false,
      title: 'Normal session',
      status: 'active',
      provider: 'claude',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await chatService.isSessionImported(sessionId);
    expect(result).toBe(false);
  });

  it('returns false when session does not have isImported field', async () => {
    const sessionId = new ObjectId().toString();
    await db.collection('chat_sessions').insertOne({
      _id: new ObjectId(sessionId),
      title: 'Normal session',
      status: 'active',
      provider: 'claude',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await chatService.isSessionImported(sessionId);
    expect(result).toBe(false);
  });

  it('returns false for missing/invalid session ID', async () => {
    const result = await chatService.isSessionImported(new ObjectId().toString());
    expect(result).toBe(false);
  });

  it('returns false for empty string', async () => {
    const result = await chatService.isSessionImported('');
    expect(result).toBe(false);
  });

  it('returns false for non-ObjectId string', async () => {
    const result = await chatService.isSessionImported('not-an-objectid');
    expect(result).toBe(false);
  });

  it('returns false for null/undefined (type-safe)', async () => {
    // @ts-expect-error testing invalid input
    const resultNull = await chatService.isSessionImported(null);
    expect(resultNull).toBe(false);

    // @ts-expect-error testing invalid input
    const resultUndefined = await chatService.isSessionImported(undefined);
    expect(resultUndefined).toBe(false);
  });
});
