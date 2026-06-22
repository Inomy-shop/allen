import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WatcherService } from '../watcher.service.js';

const mocks = vi.hoisted(() => ({
  broadcastToExecution: vi.fn(),
}));

vi.mock('../stream.service.js', () => ({
  broadcastToExecution: mocks.broadcastToExecution,
}));

describe('WatcherService lifecycle — reactivate() and markReplaced()', () => {
  let mockDb: any;
  let mockChatService: any;
  let service: WatcherService;
  let chainable: any;

  beforeEach(() => {
    mocks.broadcastToExecution.mockReset();
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

  // ── AC9: reactivate ──────────────────────────────────────────────────

  describe('reactivate()', () => {
    it('sets watcherStatus=active, clears triggerSentForState, bumps updateSeq for checkpoint path (AC9)', async () => {
      const existingDoc = {
        watcherId: 'w-1',
        executionId: 'exec-1',
        watcherStatus: 'waiting',
        triggerSentForState: 'waiting_for_input',
        updateSeq: 5,
      };

      chainable.findOne.mockResolvedValueOnce(existingDoc);

      await service.reactivate('exec-1', 'checkpoint');

      expect(chainable.updateOne).toHaveBeenCalledWith(
        { executionId: 'exec-1' },
        expect.objectContaining({
          $set: expect.objectContaining({
            watcherStatus: 'active',
            triggerSentForState: null,
            updateSeq: 6,
          }),
        }),
      );
    });

    it('clears triggerSentForState and resets nextPollAt for agent path (AC9)', async () => {
      const existingDoc = {
        watcherId: 'w-1',
        executionId: 'exec-2',
        watcherStatus: 'waiting',
        triggerSentForState: 'failed',
        updateSeq: 3,
      };

      chainable.findOne.mockResolvedValueOnce(existingDoc);

      await service.reactivate('exec-2', 'agent');

      const setArg = chainable.updateOne.mock.calls[0][1].$set;
      expect(setArg.watcherStatus).toBe('active');
      expect(setArg.triggerSentForState).toBeNull();
      expect(setArg.nextPollAt).toBeInstanceOf(Date);
      expect(setArg.updateSeq).toBe(4);
    });

    it('works for engine resume path', async () => {
      const existingDoc = {
        watcherId: 'w-1',
        executionId: 'exec-3',
        watcherStatus: 'waiting',
        triggerSentForState: 'completed',
        updateSeq: 7,
      };

      chainable.findOne.mockResolvedValueOnce(existingDoc);

      await service.reactivate('exec-3', 'engine');

      const setArg = chainable.updateOne.mock.calls[0][1].$set;
      expect(setArg.watcherStatus).toBe('active');
      expect(setArg.triggerSentForState).toBeNull();
      expect(setArg.updateSeq).toBe(8);
    });

    it('reactivates a watcher that was resolved by chat cancellation', async () => {
      const existingDoc = {
        watcherId: 'w-1',
        executionId: 'exec-4',
        watcherStatus: 'resolved',
        executionState: 'cancelled',
        triggerSentForState: 'cancelled',
        updateSeq: 9,
      };

      chainable.findOne.mockResolvedValueOnce(existingDoc);

      await service.reactivate('exec-4', 'agent');

      const setArg = chainable.updateOne.mock.calls[0][1].$set;
      expect(setArg.watcherStatus).toBe('active');
      expect(setArg.triggerSentForState).toBeNull();
      expect(setArg.nextPollAt).toBeInstanceOf(Date);
      expect(setArg.updateSeq).toBe(10);
    });

    it('is a no-op when the watcher does not exist (no error, no insert)', async () => {
      // chainable.findOne returns null by default → no existing watcher
      // The fallback tries to find execution for chatSessionId;
      // with no execution either, no register() call happens
      chainable.findOne.mockResolvedValueOnce(null);  // watcher not found
      // execution.findOne returns null (default) → no chatSessionId → no register

      await service.reactivate('nonexistent-exec', 'checkpoint');

      expect(chainable.updateOne).not.toHaveBeenCalled();
      expect(chainable.insertOne).not.toHaveBeenCalled();
    });
  });

  // ── AC10: markReplaced ────────────────────────────────────────────────

  describe('markReplaced()', () => {
    it('sets watcherStatus to replaced (AC10)', async () => {
      const existingDoc = {
        watcherId: 'w-1',
        executionId: 'exec-1',
        watcherStatus: 'active',
        updateSeq: 5,
      };

      chainable.findOne.mockResolvedValueOnce(existingDoc);

      await service.markReplaced('exec-1');

      expect(chainable.updateOne).toHaveBeenCalledWith(
        { executionId: 'exec-1' },
        expect.objectContaining({
          $set: expect.objectContaining({
            watcherStatus: 'replaced',
          }),
        }),
      );
    });

    it('does NOT call updateOne when the watcher does not exist (no error)', async () => {
      // chainable.findOne returns null by default
      await service.markReplaced('nonexistent-exec');

      expect(chainable.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('resolveForChatCancellation()', () => {
    it('resolves the watcher immediately and marks cancelled handled without sending a hidden trigger', async () => {
      const existingDoc = {
        watcherId: 'w-1',
        executionId: 'exec-1',
        chatSessionId: 'session-1',
        executionType: 'agent',
        watcherStatus: 'active',
        executionState: 'running',
        triggerSentForState: null,
        updateSeq: 5,
      };

      chainable.findOne.mockResolvedValueOnce(existingDoc);

      await service.resolveForChatCancellation('exec-1');

      expect(chainable.updateOne).toHaveBeenCalledWith(
        { executionId: 'exec-1' },
        expect.objectContaining({
          $set: expect.objectContaining({
            watcherStatus: 'resolved',
            executionState: 'cancelled',
            triggerSentForState: 'cancelled',
            latestStatusText: 'Execution cancelled because the owning chat was interrupted.',
            updateSeq: 6,
          }),
        }),
      );

      const setArg = chainable.updateOne.mock.calls[0][1].$set;
      expect(setArg.nextPollAt).toBeInstanceOf(Date);
      expect(setArg.lastCheckedAt).toBeInstanceOf(Date);

      expect(mockChatService.broadcastToSession).toHaveBeenCalledWith(
        'session-1',
        'watcher_update',
        expect.objectContaining({
          executionId: 'exec-1',
          chatSessionId: 'session-1',
          watcherStatus: 'resolved',
          executionState: 'cancelled',
          triggerSentForState: 'cancelled',
          updateSeq: 6,
        }),
      );
      expect(mocks.broadcastToExecution).toHaveBeenCalledWith(
        'exec-1',
        expect.objectContaining({
          event: 'watcher_update',
          data: expect.objectContaining({
            watcherStatus: 'resolved',
            executionState: 'cancelled',
          }),
        }),
      );
      expect(mockChatService.appendWatcherTrigger).not.toHaveBeenCalled();
    });

    it('is a no-op when there is no watcher for the execution', async () => {
      chainable.findOne.mockResolvedValueOnce(null);

      await service.resolveForChatCancellation('missing-exec');

      expect(chainable.updateOne).not.toHaveBeenCalled();
      expect(mockChatService.broadcastToSession).not.toHaveBeenCalled();
      expect(mockChatService.appendWatcherTrigger).not.toHaveBeenCalled();
    });
  });
});
