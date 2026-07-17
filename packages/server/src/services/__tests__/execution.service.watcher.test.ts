import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectId, type Db } from 'mongodb';

const {
  mockEngineRun,
  mockWatcherRegister,
  mockWatcherPoll,
  mockWatcherReactivate,
  mockCountRunningExecutions,
} = vi.hoisted(() => ({
  mockEngineRun: vi.fn(),
  mockWatcherRegister: vi.fn(),
  mockWatcherPoll: vi.fn(),
  mockWatcherReactivate: vi.fn(),
  mockCountRunningExecutions: vi.fn(),
}));

vi.mock('@allen/engine', () => ({
  AllenEngine: vi.fn().mockImplementation(() => ({
    run: mockEngineRun,
    runFromCheckpoint: vi.fn().mockResolvedValue(undefined),
    retryFromNode: vi.fn().mockResolvedValue(undefined),
    pauseExecution: vi.fn(),
    resumeExecution: vi.fn(),
  })),
  StateManager: vi.fn().mockImplementation(() => ({
    countRunningExecutions: mockCountRunningExecutions,
    createExecution: vi.fn().mockResolvedValue(undefined),
    updateExecution: vi.fn().mockResolvedValue(undefined),
    getExecution: vi.fn().mockResolvedValue(null),
  })),
  loadAgents: vi.fn().mockReturnValue({}),
  getBuiltIns: vi.fn().mockReturnValue({}),
  resolveWorkspacesDir: vi.fn().mockReturnValue('/tmp/allen-workspaces-test'),
  aggregateTokenUsage: vi.fn((a, b) => b ?? a ?? null),
}));

vi.mock('../watcher.service.js', () => ({
  WatcherService: vi.fn().mockImplementation(() => ({
    register: mockWatcherRegister,
    pollWatcherByExecutionId: mockWatcherPoll,
    reactivate: mockWatcherReactivate,
  })),
}));

vi.mock('../chat.service.js', () => ({
  ChatService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { ExecutionService } from '../execution.service.js';

const WORKFLOW_ID = new ObjectId().toHexString();
const WORKFLOW_DOC = {
  _id: new ObjectId(WORKFLOW_ID),
  name: 'test-workflow',
  parsed: {
    name: 'test-workflow',
    version: 1,
    nodes: {},
  },
};

function makeDb(): Db {
  return {
    collection(name: string) {
      if (name === 'workflows') {
        return {
          async findOne() {
            return WORKFLOW_DOC;
          },
          find() {
            return {
              async toArray() {
                return [WORKFLOW_DOC];
              },
            };
          },
        };
      }

      if (name === 'agents' || name === 'model_registry') {
        return {
          find() {
            return {
              async toArray() {
                return [];
              },
            };
          },
        };
      }

      if (name === 'repos') {
        return {
          async updateOne() {
            return { matchedCount: 0, modifiedCount: 0 };
          },
        };
      }

      return {
        async findOne() {
          return null;
        },
        find() {
          return {
            sort() { return this; },
            limit() { return this; },
            async toArray() {
              return [];
            },
          };
        },
        async updateOne() {
          return { matchedCount: 0, modifiedCount: 0 };
        },
        async insertOne() {
          return { insertedId: new ObjectId() };
        },
      };
    },
  } as unknown as Db;
}

describe('ExecutionService workflow watcher wakeup', () => {
  beforeEach(() => {
    mockEngineRun.mockReset();
    mockWatcherRegister.mockReset();
    mockWatcherPoll.mockReset();
    mockWatcherReactivate.mockReset();
    mockCountRunningExecutions.mockReset();

    mockWatcherRegister.mockResolvedValue({ watcherId: 'watcher-1', alreadyExisted: false });
    mockWatcherPoll.mockResolvedValue(undefined);
    mockWatcherReactivate.mockResolvedValue(undefined);
    mockCountRunningExecutions.mockResolvedValue(0);
  });

  it('polls the workflow watcher immediately after workflow terminal completion', async () => {
    let resolveRun!: () => void;
    mockEngineRun.mockImplementation(() => new Promise<void>((resolve) => {
      resolveRun = resolve;
    }));

    const service = new ExecutionService(makeDb());
    await service.start(WORKFLOW_ID, { meta: { chatSessionId: 'chat-1' } });

    await vi.waitFor(() => {
      expect(mockWatcherRegister).toHaveBeenCalledWith(expect.objectContaining({
        chatSessionId: 'chat-1',
        executionType: 'workflow',
      }));
    });

    const executionId = mockWatcherRegister.mock.calls[0][0].executionId;
    expect(mockWatcherPoll).not.toHaveBeenCalled();

    resolveRun();

    await vi.waitFor(() => {
      expect(mockWatcherPoll).toHaveBeenCalledWith(executionId);
    });
    expect(mockWatcherRegister.mock.invocationCallOrder[0])
      .toBeLessThan(mockWatcherPoll.mock.invocationCallOrder[0]);
  });
});
