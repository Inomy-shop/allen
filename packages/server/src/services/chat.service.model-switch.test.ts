import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ChatService } from './chat.service.js';

describe('ChatService in-session model switching', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let chatService: ChatService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('chat-model-switch-test');
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

  async function insertSession(provider: string, model: string) {
    const _id = new ObjectId();
    await db.collection('chat_sessions').insertOne({
      _id,
      title: 'Model switch test',
      status: 'active',
      messageCount: 2,
      totalCostUsd: 0,
      provider,
      model,
      llmSessionId: 'native-session-123',
      llmSessionCwd: '/tmp/allen',
      lastMessageAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return _id.toString();
  }

  it('preserves the native llm session id when switching models in the same Claude family', async () => {
    const sessionId = await insertSession('claude', 'claude-sonnet-4-6');

    const updated = await chatService.updateSession(sessionId, {
      provider: 'claude',
      model: 'claude-opus-4-7',
    });

    expect(updated?.provider).toBe('claude');
    expect(updated?.model).toBe('claude-opus-4-7');
    expect(updated?.llmSessionId).toBe('native-session-123');
    expect(updated?.llmSessionCwd).toBe('/tmp/allen');
  });

  it('rejects switching between Claude-family and Codex providers inside the same chat', async () => {
    const sessionId = await insertSession('claude', 'claude-sonnet-4-6');

    await expect(chatService.updateSession(sessionId, {
      provider: 'codex',
      model: 'gpt-5.5',
    })).rejects.toMatchObject({
      code: 'incompatible_provider_family',
      status: 400,
    });
  });
});
