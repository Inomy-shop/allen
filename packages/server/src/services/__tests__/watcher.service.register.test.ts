import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WatcherService } from '../watcher.service.js';
import type { ExecutionWatcherDoc } from '../watcher.service.js';

describe('WatcherService.register()', () => {
  let mockDb: any;
  let mockChatService: any;
  let service: WatcherService;
  let chainable: any;

  beforeEach(() => {
    chainable = {
      findOne: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn().mockResolvedValue({ insertedId: { toHexString: () => 'mock-id' } }),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      find: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    mockDb = {
      collection: vi.fn().mockReturnValue(chainable),
    };

    mockChatService = {
      isStreaming: vi.fn().mockReturnValue(false),
      broadcastToSession: vi.fn().mockReturnValue(1),
      appendWatcherTrigger: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
    };
    service = new WatcherService(mockDb as any, mockChatService as any);
  });

  const baseOptions = {
    executionId: 'exec-1',
    chatSessionId: 'session-1',
    executionType: 'workflow' as const,
    originatingMessageId: 'msg-1',
    userId: 'user-1',
    rootExecutionId: null,
    slackTeamId: 'team-1',
    slackChannelId: 'channel-1',
    slackThreadTs: 'ts-1',
  };

  // ── AC1 + AC2: fresh registration with correct ownership ──────────────

  it('inserts a new execution_watchers doc with correct ownership fields for workflow executionType', async () => {
    // First findOne: execution status check → running
    // Second findOne: existing watcher check → null (no existing)
    chainable.findOne
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce(null);

    const result = await service.register(baseOptions);

    expect(result.alreadyExisted).toBe(false);
    expect(result.watcherId).toBeTruthy();

    const insertCall = chainable.insertOne.mock.calls[0][0] as ExecutionWatcherDoc;
    expect(insertCall.executionId).toBe('exec-1');
    expect(insertCall.chatSessionId).toBe('session-1');
    expect(insertCall.originatingMessageId).toBe('msg-1');
    expect(insertCall.userId).toBe('user-1');
    expect(insertCall.executionType).toBe('workflow');
    expect(insertCall.rootExecutionId).toBeNull();
    expect(insertCall.slackTeamId).toBe('team-1');
    expect(insertCall.slackChannelId).toBe('channel-1');
    expect(insertCall.slackThreadTs).toBe('ts-1');
    // Lifecycle fields
    expect(insertCall.watcherStatus).toBe('active');
    expect(insertCall.triggerSentForState).toBeNull();
    expect(insertCall.updateSeq).toBe(0);
    expect(insertCall.lastPolledAt).toBeInstanceOf(Date);
    expect(insertCall.lastCheckedAt).toBeInstanceOf(Date);
    expect(insertCall.nextPollAt).toBeInstanceOf(Date);
    expect(insertCall.createdAt).toBeInstanceOf(Date);
    expect(insertCall.updatedAt).toBeInstanceOf(Date);
    expect(insertCall.watcherId).toBeTruthy();
  });

  // ── AC2: idempotent — existing active watcher ─────────────────────────

  it('returns existing doc without insert when watcher already exists with active status', async () => {
    const existingDoc = {
      watcherId: 'existing-id',
      executionId: 'exec-1',
      chatSessionId: 'session-1',
      watcherStatus: 'active' as const,
      updateSeq: 3,
    };

    chainable.findOne
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce(existingDoc);

    const result = await service.register(baseOptions);

    expect(result.alreadyExisted).toBe(true);
    expect(result.watcherId).toBe('existing-id');
    expect(chainable.insertOne).not.toHaveBeenCalled();
    expect(chainable.updateOne).not.toHaveBeenCalled();
  });

  // ── AC2: idempotent — existing waiting watcher ────────────────────────

  it('returns existing doc without insert when watcher already exists with waiting status', async () => {
    const existingDoc = {
      watcherId: 'waiting-id',
      executionId: 'exec-1',
      chatSessionId: 'session-1',
      watcherStatus: 'waiting' as const,
      updateSeq: 3,
    };

    chainable.findOne
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce(existingDoc);

    const result = await service.register(baseOptions);

    expect(result.alreadyExisted).toBe(true);
    expect(result.watcherId).toBe('waiting-id');
    expect(chainable.insertOne).not.toHaveBeenCalled();
    expect(chainable.updateOne).not.toHaveBeenCalled();
  });

  // ── AC3 / AC11: agent executionType ───────────────────────────────────

  it('registers successfully with executionType: agent (AC3 / AC11)', async () => {
    chainable.findOne
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce(null);

    const result = await service.register({
      ...baseOptions,
      executionType: 'agent',
    });

    expect(result.alreadyExisted).toBe(false);
    const insertCall = chainable.insertOne.mock.calls[0][0] as ExecutionWatcherDoc;
    expect(insertCall.executionType).toBe('agent');
  });

  // ── AC3 / AC11: lead executionType ────────────────────────────────────

  it('registers successfully with executionType: lead (AC3 / AC11)', async () => {
    chainable.findOne
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce(null);

    const result = await service.register({
      ...baseOptions,
      executionType: 'lead',
    });

    expect(result.alreadyExisted).toBe(false);
    const insertCall = chainable.insertOne.mock.calls[0][0] as ExecutionWatcherDoc;
    expect(insertCall.executionType).toBe('lead');
  });
});
