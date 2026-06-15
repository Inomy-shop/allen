/**
 * Unit tests for ChatService.appendAutomationMessage()
 *
 * Tests:
 *  1. Successfully inserts a message and updates session stats
 *  2. Throws "Session not found" for an invalid ObjectId
 *  3. Throws "Session not found" when session does not exist in DB
 *  4. Rejects an invalid role value
 *  5. Rejects empty content
 *  6. Rejects content exceeding 1 MB
 *  7. Throws "Not an automation session" when session.source !== 'automation'
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectId } from 'mongodb';

// ── Mock transitive dependencies that chat.service.ts imports ───────────────

vi.mock('./chat-llm.js', () => ({
  PROVIDERS: [],
  runChatLLM: vi.fn().mockResolvedValue({
    text: 'Watcher update delivered.',
    costUsd: 0,
    tokenUsage: null,
    model: 'test-model',
    sessionId: 'llm-session-1',
    trace: [],
  }),
}));

vi.mock('./chat-providers.js', () => ({
  getDefaultChatProvider: vi.fn().mockReturnValue('claude'),
  getDefaultChatModel: vi.fn().mockReturnValue('test-model'),
  getTitleGenProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'test-model' }),
  getEnabledProvidersFromRegistry: vi.fn().mockResolvedValue([]),
  getEnabledProvidersInDefaultOrder: vi.fn().mockResolvedValue([]),
  isClaudeCompatibleProvider: vi.fn().mockReturnValue(false),
  isClaudeFamilyProvider: vi.fn().mockReturnValue(true),
}));

vi.mock('./agent-settings.js', () => ({
  resolveAgentSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock('./alert.service.js', () => ({
  AlertService: vi.fn().mockImplementation(() => ({ createAlert: vi.fn() })),
}));

vi.mock('./chat-tools.js', () => ({
  registerActiveSession: vi.fn(),
  unregisterActiveSession: vi.fn(),
  waitForBackgroundTasks: vi.fn().mockResolvedValue(undefined),
  executeChatTool: vi.fn().mockResolvedValue({}),
  resolveActiveSession: vi.fn().mockReturnValue(null),
}));

vi.mock('./embedding.service.js', () => ({
  searchSimilar: vi.fn().mockResolvedValue([]),
  backfillEmbeddings: vi.fn().mockResolvedValue(undefined),
  invalidateCache: vi.fn(),
}));

vi.mock('./org-context.js', () => ({
  buildOrgContextBlock: vi.fn().mockReturnValue(''),
}));

vi.mock('./self-healing-monitor.service.js', () => ({
  MonitoringService: vi.fn().mockImplementation(() => ({
    handleEvent: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./execution.service.js', () => ({
  ExecutionService: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue({ id: 'exec-1', status: 'running' }),
  })),
}));

vi.mock('./linear.service.js', () => ({
  LinearService: vi.fn().mockImplementation(() => ({ getIssue: vi.fn() })),
}));

vi.mock('./model-cost.service.js', () => ({
  resolveCostUsd: vi.fn().mockResolvedValue({ amount: 0 }),
}));

vi.mock('./cost-rollup.service.js', () => ({
  CostRollupService: vi.fn().mockImplementation(() => ({ refreshSessionCost: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('./context/core/chat-context-packet.service.js', () => ({
  ChatContextPacketService: vi.fn().mockImplementation(() => ({
    buildChatContextPacket: vi.fn().mockResolvedValue(null),
    recordChatContextUsage: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Import after all mocks
import { ChatService } from './chat.service.js';
import { runChatLLM } from './chat-llm.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOid() {
  return new ObjectId();
}

function makeDb(
  sessions: Record<string, unknown>[] = [],
  messages: Record<string, unknown>[] = [],
) {
  const stores: Record<string, Record<string, unknown>[]> = {
    chat_sessions: sessions,
    chat_messages: messages,
    agents: [],
  };

  const makeCollection = (name: string) => ({
    find: (_q: Record<string, unknown>) => ({
      toArray: async () => stores[name] ?? [],
      sort: () => ({
        toArray: async () => stores[name] ?? [],
        limit: () => ({
          toArray: async () => stores[name] ?? [],
          next: async () => (stores[name] ?? [])[0] ?? null,
        }),
      }),
    }),
    findOne: async (query: Record<string, unknown>) => {
      const col = stores[name] ?? [];
      return (
        col.find((doc) =>
          Object.entries(query).every(([k, v]) => {
            const dv = (doc as any)[k];
            // ObjectId comparison
            if (v instanceof ObjectId) return String(dv) === String(v);
            return dv === v;
          }),
        ) ?? null
      );
    },
    insertOne: async (doc: Record<string, unknown>) => {
      const col = (stores[name] = stores[name] ?? []);
      const withId = { _id: makeOid(), ...doc };
      col.push(withId);
      return { insertedId: (withId as any)._id };
    },
    updateOne: async (
      _query: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      const col = stores[name] ?? [];
      const idx = col.findIndex((doc) =>
        Object.entries(_query).every(([k, v]) => {
          const dv = (doc as any)[k];
          if (v instanceof ObjectId) return String(dv) === String(v);
          return dv === v;
        }),
      );
      if (idx >= 0) {
        const u = update as any;
        if (u.$set) stores[name][idx] = { ...stores[name][idx], ...u.$set };
        if (u.$inc) {
          const doc = stores[name][idx] as any;
          for (const [k, delta] of Object.entries(u.$inc as Record<string, number>)) {
            doc[k] = (doc[k] ?? 0) + delta;
          }
        }
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    createIndex: vi.fn().mockResolvedValue('index_name'),
  });

  return {
    stores,
    collection: (name: string) => makeCollection(name),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ChatService.appendAutomationMessage()', () => {
  let sessionId: string;
  let db: ReturnType<typeof makeDb>;
  let service: ChatService;

  beforeEach(() => {
    const oid = makeOid();
    sessionId = String(oid);
    db = makeDb([
      {
        _id: oid,
        title: 'Sample Automation',
        source: 'automation',
        automationKey: 'sample-automation',
        status: 'active',
        messageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    service = new ChatService(db as any);
  });

  it('inserts a message and increments session messageCount', async () => {
    const { messageId } = await service.appendAutomationMessage(
      sessionId,
      'assistant',
      '# Daily Briefing\nAll systems nominal.',
    );

    expect(messageId).toBeTruthy();
    const messages = db.stores.chat_messages;
    expect(messages).toHaveLength(1);
    const msg = messages[0] as any;
    expect(msg.sessionId).toBe(sessionId);
    expect(msg.role).toBe('assistant');
    expect(msg.content).toContain('Daily Briefing');
    expect(msg.status).toBe('completed');
    expect(msg.senderSource).toBe('system');

    const session = db.stores.chat_sessions[0] as any;
    expect(session.messageCount).toBe(1);
  });

  it('throws "Session not found" for an invalid ObjectId string', async () => {
    await expect(
      service.appendAutomationMessage('not-a-valid-oid', 'assistant', 'hello'),
    ).rejects.toThrow('Session not found');
  });

  it('throws "Session not found" when the session does not exist in DB', async () => {
    const unknownId = String(makeOid());
    await expect(
      service.appendAutomationMessage(unknownId, 'assistant', 'hello'),
    ).rejects.toThrow('Session not found');
  });

  it('rejects an invalid role', async () => {
    await expect(
      // @ts-expect-error intentional bad role
      service.appendAutomationMessage(sessionId, 'system', 'hello'),
    ).rejects.toThrow('role must be one of: user, assistant');
  });

  it('rejects empty content', async () => {
    await expect(
      service.appendAutomationMessage(sessionId, 'assistant', '   '),
    ).rejects.toThrow('content is required');
  });

  it('rejects content exceeding 1 MB', async () => {
    const largeContent = 'x'.repeat(1_000_001);
    await expect(
      service.appendAutomationMessage(sessionId, 'assistant', largeContent),
    ).rejects.toThrow(/content exceeds maximum length/i);
  });

  it('throws "Not an automation session" when session.source is not "automation"', async () => {
    const oid = makeOid();
    const dbWithUiSession = makeDb([
      {
        _id: oid,
        title: 'Regular chat',
        titleSource: 'user',
        source: 'ui',
        status: 'active',
        messageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const svc = new ChatService(dbWithUiSession as any);
    await expect(
      svc.appendAutomationMessage(String(oid), 'assistant', 'hello'),
    ).rejects.toThrow('Not an automation session');
  });
});

describe('ChatService.appendWatcherTrigger()', () => {
  let sessionId: string;
  let db: ReturnType<typeof makeDb>;
  let service: ChatService;

  beforeEach(() => {
    vi.mocked(runChatLLM).mockClear();
    const oid = makeOid();
    sessionId = String(oid);
    db = makeDb([
      {
        _id: oid,
        title: 'Regular chat',
        titleSource: 'user',
        source: 'ui',
        status: 'active',
        provider: 'claude',
        model: 'test-model',
        messageCount: 0,
        totalCostUsd: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    service = new ChatService(db as any);
  });

  it('inserts a hidden trigger and wakes the assistant when the session is idle', async () => {
    const triggerContext = {
      executionId: 'exec-1',
      executionType: 'agent',
      workflowName: null,
      agentName: 'reviewer',
      currentNode: null,
      status: 'completed',
      recentMilestones: [],
      relevantArtifactUrls: [],
      finalResponse: 'Done',
      errorMessage: null,
      inputRequest: null,
      validNextActions: ['view_execution_details'],
    };

    const { messageId } = await service.appendWatcherTrigger(
      sessionId,
      'watcher_completed',
      triggerContext,
    );

    expect(messageId).toBeTruthy();

    await vi.waitFor(() => {
      const assistant = db.stores.chat_messages.find((m: any) => m.role === 'assistant') as any;
      expect(assistant?.status).toBe('completed');
      expect(assistant?.content).toBe('Watcher update delivered.');
    });

    const hiddenTrigger = db.stores.chat_messages.find((m: any) => m.hidden) as any;
    expect(hiddenTrigger).toMatchObject({
      sessionId,
      role: 'user',
      status: 'completed',
      senderSource: 'system',
      hidden: true,
      triggerType: 'watcher_completed',
      triggerContext,
    });
    expect(hiddenTrigger.content).toContain('[watcher:watcher_completed]');
    expect(hiddenTrigger.content).toContain('"executionId": "exec-1"');

    expect(runChatLLM).toHaveBeenCalledTimes(1);
    const llmArgs = vi.mocked(runChatLLM).mock.calls[0][1] as any;
    expect(llmArgs.messages.at(-1).content).toContain('[watcher:watcher_completed]');
    expect(llmArgs.messages.at(-1).content).toContain('"finalResponse": "Done"');

    const session = db.stores.chat_sessions[0] as any;
    expect(session.messageCount).toBe(2);
  });
});
