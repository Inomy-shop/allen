import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { WatcherService } from '../watcher.service.js';
import type { ExecutionWatcherDoc } from '../watcher.service.js';

describe('WatcherService dedup (triggerSentForState)', () => {
  let mockDb: any;
  let mockChatService: any;
  let service: WatcherService;

  beforeEach(() => {
    mockDb = {
      collection: vi.fn().mockReturnThis(),
      find: vi.fn().mockReturnThis(),
      findOne: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn().mockResolvedValue({ insertedId: { toHexString: () => 'mock-id' } }),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    // Make mockDb.collection return itself for chainable calls
    const chainable = {
      findOne: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn().mockResolvedValue({ insertedId: { toHexString: () => 'mock-id' } }),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      find: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    mockDb.collection.mockReturnValue(chainable);

    mockChatService = {
      isStreaming: vi.fn().mockReturnValue(false),
      broadcastToSession: vi.fn().mockReturnValue(1),
      appendWatcherTrigger: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
    };
    service = new WatcherService(mockDb as any, mockChatService as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sendHiddenTrigger is idempotent when triggerSentForState matches', async () => {
    const watcherDoc: Pick<ExecutionWatcherDoc, 'executionId' | 'chatSessionId' | 'executionState' | 'triggerSentForState' | 'updateSeq' | 'executionType' | 'rootExecutionId'> = {
      executionId: 'exec-1',
      chatSessionId: 'session-1',
      executionState: 'completed',
      triggerSentForState: 'completed', // Already sent
      updateSeq: 5,
      executionType: 'agent',
      rootExecutionId: null,
    };

    // Mock findOne for executions to return a doc
    const chainable = mockDb.collection();
    chainable.findOne.mockResolvedValue({ status: 'completed', workflowName: 'test' });

    await service.sendHiddenTrigger(watcherDoc, 'completed');

    // appendWatcherTrigger should NOT have been called
    expect(mockChatService.appendWatcherTrigger).not.toHaveBeenCalled();
    // updateOne should NOT have been called to set triggerSentForState
    // (the previous triggerSentForState already matches)
    expect(chainable.updateOne).not.toHaveBeenCalled();
  });

  it('sendHiddenTrigger proceeds when triggerSentForState is null', async () => {
    const watcherDoc: Pick<ExecutionWatcherDoc, 'executionId' | 'chatSessionId' | 'executionState' | 'triggerSentForState' | 'updateSeq' | 'executionType' | 'rootExecutionId'> = {
      executionId: 'exec-2',
      chatSessionId: 'session-1',
      executionState: 'failed',
      triggerSentForState: null, // Not sent yet
      updateSeq: 5,
      executionType: 'agent',
      rootExecutionId: null,
    };

    const chainable = mockDb.collection();
    // Mock findOne for execution_logs returns empty
    chainable.findOne
      .mockResolvedValueOnce({ status: 'failed', workflowName: 'test', currentNodes: ['agent-1'] })
      .mockResolvedValueOnce(null); // execution_traces returns null

    await service.sendHiddenTrigger(watcherDoc, 'failed');

    // appendWatcherTrigger should have been called
    expect(mockChatService.appendWatcherTrigger).toHaveBeenCalledTimes(1);
    // updateOne should have been called to set triggerSentForState
    expect(chainable.updateOne).toHaveBeenCalled();
  });

  it('sendHiddenTrigger proceeds when triggerSentForState is a different state', async () => {
    const watcherDoc: Pick<ExecutionWatcherDoc, 'executionId' | 'chatSessionId' | 'executionState' | 'triggerSentForState' | 'updateSeq' | 'executionType' | 'rootExecutionId'> = {
      executionId: 'exec-3',
      chatSessionId: 'session-1',
      executionState: 'completed',
      triggerSentForState: 'cancelled', // Previously sent for cancelled
      updateSeq: 5,
      executionType: 'agent',
      rootExecutionId: null,
    };

    const chainable = mockDb.collection();
    chainable.findOne
      .mockResolvedValueOnce({ status: 'completed', workflowName: 'test', currentNodes: ['agent-1'] })
      .mockResolvedValueOnce(null);

    await service.sendHiddenTrigger(watcherDoc, 'completed');

    // appendWatcherTrigger should have been called
    expect(mockChatService.appendWatcherTrigger).toHaveBeenCalledTimes(1);
  });
});
