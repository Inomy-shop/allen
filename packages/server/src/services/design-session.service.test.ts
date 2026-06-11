/**
 * Unit tests for DesignSessionService (AC-018)
 *
 * Covers: create, list, findById, createMessage, listMessages
 * Uses a mock db — no express, no supertest, no mongodb value imports.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mongodb so `await import('mongodb')` inside the service resolves cleanly.
// vi.mock calls are hoisted by vitest before any imports, so this always runs first.
vi.mock('mongodb', () => {
  class ObjectId {
    private _hex: string;
    constructor(id?: string) {
      this._hex = id ?? '000000000000000000000000';
    }
    toString() {
      return this._hex;
    }
  }
  return { ObjectId };
});

import { DesignSessionService } from './design-session.service.js';

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeMockDb() {
  const sessionsInsertOne = vi.fn();
  const sessionsFindOne = vi.fn().mockResolvedValue(null);
  const sessionsUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const sessionsToArray = vi.fn().mockResolvedValue([]);

  const messagesInsertOne = vi.fn();
  const messagesUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const messagesToArray = vi.fn().mockResolvedValue([]);

  const sessionsMock = {
    insertOne: sessionsInsertOne,
    findOne: sessionsFindOne,
    updateOne: sessionsUpdateOne,
    deleteOne: vi.fn().mockResolvedValue({}),
    find: vi.fn(() => ({
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: sessionsToArray,
    })),
  };

  const messagesMock = {
    insertOne: messagesInsertOne,
    updateOne: messagesUpdateOne,
    deleteMany: vi.fn().mockResolvedValue({}),
    find: vi.fn(() => ({
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: messagesToArray,
    })),
  };

  const db = {
    collection: vi.fn((name: string) => {
      if (name === 'design_sessions') return sessionsMock;
      if (name === 'design_messages') return messagesMock;
      return {};
    }),
  } as any;

  return {
    db,
    sessionsInsertOne,
    sessionsFindOne,
    sessionsUpdateOne,
    sessionsToArray,
    messagesInsertOne,
    messagesUpdateOne,
    messagesToArray,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DesignSessionService', () => {
  let mocks: ReturnType<typeof makeMockDb>;
  let service: DesignSessionService;

  beforeEach(() => {
    mocks = makeMockDb();
    service = new DesignSessionService(mocks.db);
  });

  // ── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a session with kind=design and sourceSurface=design_tab', async () => {
      const fakeInsertedId = { toString: () => 'session-aabb' };
      mocks.sessionsInsertOne.mockResolvedValue({ insertedId: fakeInsertedId });

      const result = await service.create({
        title: 'My Feature Design',
        designRepoId: 'repo-001',
      });

      expect(result.kind).toBe('design');
      expect(result.sourceSurface).toBe('design_tab');
      expect(result.title).toBe('My Feature Design');
      expect(result.designRepoId).toBe('repo-001');
      expect(result.status).toBe('idle');
    });

    it('defaults outputMode to spec_only when not provided', async () => {
      const fakeInsertedId = { toString: () => 'session-cc' };
      mocks.sessionsInsertOne.mockResolvedValue({ insertedId: fakeInsertedId });

      const result = await service.create({ title: 'T', designRepoId: 'r1' });

      expect(result.outputMode).toBe('spec_only');
    });

    it('respects explicit outputMode=prototype', async () => {
      const fakeInsertedId = { toString: () => 'session-dd' };
      mocks.sessionsInsertOne.mockResolvedValue({ insertedId: fakeInsertedId });

      const result = await service.create({
        title: 'Prototype Session',
        designRepoId: 'r1',
        outputMode: 'prototype',
      });

      expect(result.outputMode).toBe('prototype');
    });

    it('sets timestamps on creation', async () => {
      const fakeInsertedId = { toString: () => 'session-ee' };
      mocks.sessionsInsertOne.mockResolvedValue({ insertedId: fakeInsertedId });

      const before = new Date();
      const result = await service.create({ title: 'T', designRepoId: 'r1' });
      const after = new Date();

      expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(result.lastMessageAt).toBeInstanceOf(Date);
    });
  });

  // ── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns design sessions from the db', async () => {
      const sessions = [
        { kind: 'design', title: 'S1', designRepoId: 'r1', status: 'idle' },
        { kind: 'design', title: 'S2', designRepoId: 'r2', status: 'running' },
      ];
      mocks.sessionsToArray.mockResolvedValue(sessions);

      const result = await service.list({});

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('S1');
      expect(result[1].title).toBe('S2');
    });

    it('returns empty array when no sessions exist', async () => {
      mocks.sessionsToArray.mockResolvedValue([]);

      const result = await service.list({});

      expect(result).toEqual([]);
    });

    it('filters by designRepoId when provided', async () => {
      const sessions = [{ kind: 'design', title: 'S1', designRepoId: 'repo-x' }];
      mocks.sessionsToArray.mockResolvedValue(sessions);

      const result = await service.list({ designRepoId: 'repo-x' });

      expect(result).toHaveLength(1);
      expect(result[0].designRepoId).toBe('repo-x');
    });
  });

  // ── findById ────────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns the session when found', async () => {
      const session = { kind: 'design', title: 'Found Session', designRepoId: 'r1' };
      mocks.sessionsFindOne.mockResolvedValue(session);

      const result = await service.findById('aabbccddeeff001122334455');

      expect(result).not.toBeNull();
      expect(result?.title).toBe('Found Session');
      expect(result?.kind).toBe('design');
    });

    it('returns null when session is not found', async () => {
      mocks.sessionsFindOne.mockResolvedValue(null);

      const result = await service.findById('aabbccddeeff001122334455');

      expect(result).toBeNull();
    });
  });

  // ── createMessage ───────────────────────────────────────────────────────────

  describe('createMessage', () => {
    it('creates a message with role and content', async () => {
      const fakeInsertedId = { toString: () => 'msg-001' };
      mocks.messagesInsertOne.mockResolvedValue({ insertedId: fakeInsertedId });

      const result = await service.createMessage({
        designSessionId: 'session-abc',
        role: 'user',
        content: 'Generate a login screen',
        status: 'completed',
      });

      expect(result.role).toBe('user');
      expect(result.content).toBe('Generate a login screen');
      expect(result.designSessionId).toBe('session-abc');
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it('creates assistant messages', async () => {
      const fakeInsertedId = { toString: () => 'msg-002' };
      mocks.messagesInsertOne.mockResolvedValue({ insertedId: fakeInsertedId });

      const result = await service.createMessage({
        designSessionId: 'session-abc',
        role: 'assistant',
        content: 'Here is your login screen spec...',
        status: 'completed',
      });

      expect(result.role).toBe('assistant');
      expect(result.status).toBe('completed');
    });

    it('updates session lastMessageAt after creating a message', async () => {
      const fakeInsertedId = { toString: () => 'msg-003' };
      mocks.messagesInsertOne.mockResolvedValue({ insertedId: fakeInsertedId });

      await service.createMessage({
        designSessionId: 'session-abc',
        role: 'user',
        content: 'Refine the colors',
        status: 'completed',
      });

      expect(mocks.sessionsUpdateOne).toHaveBeenCalledWith(
        { _id: expect.objectContaining({ _hex: 'session-abc' }) },
        expect.objectContaining({
          $set: expect.objectContaining({ lastMessageAt: expect.any(Date) }),
        }),
      );
    });
  });

  // ── listMessages ────────────────────────────────────────────────────────────

  describe('listMessages', () => {
    it('returns messages for the given session', async () => {
      const msgs = [
        { designSessionId: 's1', role: 'user', content: 'Hi', status: 'completed' },
        { designSessionId: 's1', role: 'assistant', content: 'Hello', status: 'completed' },
      ];
      mocks.messagesToArray.mockResolvedValue(msgs);

      const result = await service.listMessages('s1');

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
    });

    it('returns empty array when session has no messages', async () => {
      mocks.messagesToArray.mockResolvedValue([]);

      const result = await service.listMessages('s1');

      expect(result).toEqual([]);
    });
  });
});
