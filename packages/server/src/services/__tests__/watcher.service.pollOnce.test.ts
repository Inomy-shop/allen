import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WatcherService, type ExecutionWatcherDoc } from '../watcher.service.js';

describe('WatcherService.pollOnce() — state transitions', () => {
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

  const baseWatcherDoc: Partial<ExecutionWatcherDoc> = {
    executionId: 'exec-1',
    chatSessionId: 'session-1',
    triggerSentForState: null,
    updateSeq: 5,
    watcherStatus: 'active',
    executionState: 'running',
    executionType: 'agent',
    rootExecutionId: null,
  };

  // ── AC9: waiting_for_input → watcherStatus=waiting, send trigger ──────

  it('flips watcherStatus to waiting and sends trigger when execution is waiting_for_input (AC9)', async () => {
    const startTime = Date.now() - 60_000;

    chainable.findOne
      // AC15 guard: executions findOne for meta.imported check → null (not imported)
      .mockResolvedValueOnce(null)
      // pollOnce execution lookup
      .mockResolvedValueOnce({
        status: 'waiting_for_input',
        workflowName: 'test-workflow',
        currentNodes: [],
        completedNodes: [],
        startedAt: new Date(startTime),
        meta: {},
      })
      // sendHiddenTrigger execution lookup
      .mockResolvedValueOnce({
        status: 'waiting_for_input',
        workflowName: 'test-workflow',
        currentNodes: [],
      });

    // logs toArray + child execs toArray
    chainable.toArray
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.pollOnce(baseWatcherDoc as ExecutionWatcherDoc);

    // ── Step 7: pollOnce updateOne ──
    // Should have updated watcherStatus to 'waiting' and executionState to 'waiting_for_input'
    expect(chainable.updateOne).toHaveBeenCalledWith(
      { executionId: 'exec-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          executionState: 'waiting_for_input',
          watcherStatus: 'waiting',
          updateSeq: 6,
        }),
      }),
    );

    // ── Step 9: chatService.appendWatcherTrigger called ──
    expect(mockChatService.appendWatcherTrigger).toHaveBeenCalledTimes(1);
    const triggerCall = mockChatService.appendWatcherTrigger.mock.calls[0];
    expect(triggerCall[0]).toBe('session-1');
    // The trigger type for waiting_for_input is 'watcher_waiting_for_input'
    expect(triggerCall[1]).toBe('watcher_waiting_for_input');
    expect(triggerCall[2]).toEqual(
      expect.objectContaining({
        executionId: 'exec-1',
        status: 'waiting_for_input',
        workflowName: 'test-workflow',
      }),
    );

    // ── Step 9: triggerSentForState set to 'waiting_for_input' ──
    // The second updateOne call is from sendHiddenTrigger
    const allUpdates = chainable.updateOne.mock.calls;
    const triggerStateUpdate = allUpdates[allUpdates.length - 1];
    expect(triggerStateUpdate[1].$set.triggerSentForState).toBe('waiting_for_input');

    // ── broadcastToSession was called ──
    expect(mockChatService.broadcastToSession).toHaveBeenCalledWith(
      'session-1',
      'watcher_update',
      expect.objectContaining({ executionId: 'exec-1', updateSeq: 6 }),
    );
  });

  // ── AC5/AC9: completed → watcherStatus=resolved, send trigger ─────────

  it('flips watcherStatus to resolved and sends completed trigger when execution completes (AC5/AC9)', async () => {
    const startTime = Date.now() - 120_000;

    // pollOnce execution lookup
    chainable.findOne
      .mockResolvedValueOnce({
        status: 'completed',
        workflowName: 'test-workflow',
        currentNodes: [],
        completedNodes: [],
        startedAt: new Date(startTime),
        meta: {},
      })
      // sendHiddenTrigger execution lookup
      .mockResolvedValueOnce({
        status: 'completed',
        workflowName: 'test-workflow',
        currentNodes: [],
      });

    // logs toArray + childExecs toArray
    chainable.toArray
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.pollOnce(baseWatcherDoc as ExecutionWatcherDoc);

    // Watcher status should be 'resolved'
    expect(chainable.updateOne).toHaveBeenCalledWith(
      { executionId: 'exec-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          executionState: 'completed',
          watcherStatus: 'resolved',
          updateSeq: 6,
        }),
      }),
    );

    // Trigger sent for 'completed'
    expect(mockChatService.appendWatcherTrigger).toHaveBeenCalledTimes(1);
    const triggerCall = mockChatService.appendWatcherTrigger.mock.calls[0];
    expect(triggerCall[1]).toBe('watcher_completed');

    // triggerSentForState set
    const allUpdates = chainable.updateOne.mock.calls;
    const triggerStateUpdate = allUpdates[allUpdates.length - 1];
    expect(triggerStateUpdate[1].$set.triggerSentForState).toBe('completed');
  });

  // ── AC5/AC9: failed → watcherStatus=resolved, send trigger ────────────

  it('flips watcherStatus to resolved and sends failed trigger when execution fails (AC5/AC9)', async () => {
    const startTime = Date.now() - 120_000;

    // pollOnce execution lookup
    chainable.findOne
      .mockResolvedValueOnce({
        status: 'failed',
        workflowName: 'test-workflow',
        currentNodes: [],
        completedNodes: [],
        startedAt: new Date(startTime),
        errorMessage: 'Something went wrong',
        meta: {},
      })
      // sendHiddenTrigger execution lookup
      .mockResolvedValueOnce({
        status: 'failed',
        workflowName: 'test-workflow',
        currentNodes: [],
        errorMessage: 'Something went wrong',
      });

    chainable.toArray
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.pollOnce(baseWatcherDoc as ExecutionWatcherDoc);

    // Watcher status should be 'resolved'
    expect(chainable.updateOne).toHaveBeenCalledWith(
      { executionId: 'exec-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          executionState: 'failed',
          watcherStatus: 'resolved',
          updateSeq: 6,
        }),
      }),
    );

    // Trigger sent for 'failed'
    expect(mockChatService.appendWatcherTrigger).toHaveBeenCalledTimes(1);
    const triggerCall = mockChatService.appendWatcherTrigger.mock.calls[0];
    expect(triggerCall[1]).toBe('watcher_failed');

    // triggerSentForState set
    const allUpdates = chainable.updateOne.mock.calls;
    const triggerStateUpdate = allUpdates[allUpdates.length - 1];
    expect(triggerStateUpdate[1].$set.triggerSentForState).toBe('failed');
  });

  it('flips watcherStatus to resolved and sends cancelled trigger when execution is cancelled (AC5/AC9)', async () => {
    const startTime = Date.now() - 120_000;

    chainable.findOne
      .mockResolvedValueOnce({
        status: 'cancelled',
        workflowName: 'test-workflow',
        currentNodes: [],
        completedNodes: [],
        startedAt: new Date(startTime),
        meta: {},
      })
      .mockResolvedValueOnce({
        status: 'cancelled',
        workflowName: 'test-workflow',
        currentNodes: [],
      });

    chainable.toArray
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.pollOnce(baseWatcherDoc as ExecutionWatcherDoc);

    expect(chainable.updateOne).toHaveBeenCalledWith(
      { executionId: 'exec-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          executionState: 'cancelled',
          watcherStatus: 'resolved',
          updateSeq: 6,
        }),
      }),
    );

    expect(mockChatService.appendWatcherTrigger).toHaveBeenCalledTimes(1);
    const triggerCall = mockChatService.appendWatcherTrigger.mock.calls[0];
    expect(triggerCall[1]).toBe('watcher_cancelled');

    const allUpdates = chainable.updateOne.mock.calls;
    const triggerStateUpdate = allUpdates[allUpdates.length - 1];
    expect(triggerStateUpdate[1].$set.triggerSentForState).toBe('cancelled');
  });

  // ── AC9/AC15: streaming suppresses duplicate wake-up ──────────────────

  it('suppresses the trigger and marks terminal state handled when streaming is active (AC9)', async () => {
    mockChatService.isStreaming.mockReturnValue(true);

    const startTime = Date.now() - 120_000;

    chainable.findOne
      // AC15 guard: executions findOne for meta.imported check → null (not imported)
      .mockResolvedValueOnce(null)
      // pollOnce execution lookup
      .mockResolvedValueOnce({
        status: 'completed',
        workflowName: 'test-workflow',
        currentNodes: [],
        completedNodes: [],
        startedAt: new Date(startTime),
        meta: {},
      });

    chainable.toArray
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.pollOnce(baseWatcherDoc as ExecutionWatcherDoc);

    // The active Assistant owns the user update; watcher resolves without
    // retrying a duplicate hidden trigger later.
    expect(chainable.updateOne).toHaveBeenCalledWith(
      { executionId: 'exec-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          executionState: 'completed',
          watcherStatus: 'resolved',
          triggerSentForState: 'completed',
          updateSeq: 6,
        }),
      }),
    );

    // appendWatcherTrigger should NOT have been called
    expect(mockChatService.appendWatcherTrigger).not.toHaveBeenCalled();

    // Only one updateOne call (pollOnce update; no triggerSentForState update)
    expect(chainable.updateOne).toHaveBeenCalledTimes(1);
  });

  it('suppresses the trigger and marks waiting_for_input handled when streaming is active', async () => {
    mockChatService.isStreaming.mockReturnValue(true);

    const startTime = Date.now() - 120_000;

    chainable.findOne
      // AC15 guard: executions findOne for meta.imported check → null (not imported)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'waiting_for_input',
        workflowName: 'test-workflow',
        currentNodes: [],
        completedNodes: [],
        startedAt: new Date(startTime),
        meta: {},
      });

    chainable.toArray
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.pollOnce(baseWatcherDoc as ExecutionWatcherDoc);

    expect(chainable.updateOne).toHaveBeenCalledWith(
      { executionId: 'exec-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          executionState: 'waiting_for_input',
          watcherStatus: 'waiting',
          triggerSentForState: 'waiting_for_input',
          updateSeq: 6,
        }),
      }),
    );

    expect(mockChatService.appendWatcherTrigger).not.toHaveBeenCalled();
    expect(chainable.updateOne).toHaveBeenCalledTimes(1);
  });

  // ── AC5: running → no trigger, just updates nextPollAt ────────────────

  it('does NOT call appendWatcherTrigger when execution is still running (AC5)', async () => {
    const startTime = Date.now() - 60_000;

    chainable.findOne
      // AC15 guard: executions findOne for meta.imported check → null (not imported)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'running',
        workflowName: 'test-workflow',
        currentNodes: ['node-a'],
        completedNodes: ['node-0'],
        startedAt: new Date(startTime),
        meta: {},
      });

    chainable.toArray
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.pollOnce(baseWatcherDoc as ExecutionWatcherDoc);

    // updateOne was called for the status text update
    expect(chainable.updateOne).toHaveBeenCalledTimes(1);
    expect(chainable.updateOne).toHaveBeenCalledWith(
      { executionId: 'exec-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          executionState: 'running',
          updateSeq: 6,
        }),
      }),
    );

    // No trigger for running state
    expect(mockChatService.appendWatcherTrigger).not.toHaveBeenCalled();
  });
});
