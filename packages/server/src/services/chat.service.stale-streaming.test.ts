import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ChatService } from './chat.service.js';

describe('ChatService stale streaming turn reconciliation', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let chatService: ChatService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('chat-stale-streaming-test');
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

  async function insertSession(sessionId: string) {
    await db.collection('chat_sessions').insertOne({
      _id: new ObjectId(sessionId),
      title: 'Stale stream test',
      status: 'active',
      messageCount: 1,
      totalCostUsd: 0,
      provider: 'claude',
      lastMessageAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('marks a persisted streaming assistant message interrupted when no runtime is active', async () => {
    const sessionId = new ObjectId().toString();
    const staleAt = new Date(Date.now() - 60_000);
    await insertSession(sessionId);
    const inserted = await db.collection('chat_messages').insertOne({
      sessionId,
      role: 'assistant',
      content: 'partial answer',
      status: 'streaming',
      createdAt: staleAt,
      lastHeartbeatAt: staleAt,
      activePhase: 'tool_running',
      activeToolName: 'slow_tool',
    });

    await expect(chatService.getStreamingState(sessionId)).resolves.toEqual({ streaming: false });

    const msg = await db.collection('chat_messages').findOne({ _id: inserted.insertedId });
    expect(msg?.status).toBe('interrupted');
    expect(msg?.interruptedReason).toBe('streaming_status_check');
    expect(msg?.error).toContain('interrupted before it could finish');
    expect(msg?.completedAt).toBeInstanceOf(Date);
    expect(msg?.activePhase).toBeUndefined();
    expect(msg?.activeToolName).toBeUndefined();
  });

  it('does not interrupt a fresh streaming message inside the creation grace window', async () => {
    const sessionId = new ObjectId().toString();
    await insertSession(sessionId);
    const inserted = await db.collection('chat_messages').insertOne({
      sessionId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: new Date(),
      activePhase: 'thinking',
    });

    await chatService.getStreamingState(sessionId);

    const msg = await db.collection('chat_messages').findOne({ _id: inserted.insertedId });
    expect(msg?.status).toBe('streaming');
  });

  it('reconciles stale streaming messages before returning a session', async () => {
    const sessionId = new ObjectId().toString();
    const staleAt = new Date(Date.now() - 60_000);
    await insertSession(sessionId);
    await db.collection('chat_messages').insertOne({
      sessionId,
      role: 'assistant',
      content: 'partial answer',
      status: 'streaming',
      createdAt: staleAt,
      lastHeartbeatAt: staleAt,
      activePhase: 'thinking',
    });

    const session = await chatService.getSession(sessionId);

    expect(session?.streaming).toBe(false);
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0]?.status).toBe('interrupted');
    expect(session?.messages[0]?.interruptedReason).toBe('session_load');
  });
});
