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
  runChatLLM: vi.fn().mockResolvedValue({ content: '', cost: 0 }),
}));

vi.mock('./chat-providers.js', () => ({
  getDefaultChatProvider: vi.fn().mockReturnValue('claude'),
  getProvidersInDefaultOrder: vi.fn().mockReturnValue([]),
  AGENT_FALLBACK_CWD: '/tmp',
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
  MonitoringService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('./execution.service.js', () => ({
  ExecutionService: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue({ id: 'exec-1', status: 'running' }),
  })),
}));

vi.mock('./linear.service.js', () => ({
  LinearService: vi.fn().mockImplementation(() => ({ getIssue: vi.fn() })),
}));

// Import after all mocks
import { ChatService } from './chat.service.js';

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
      sort: () => ({
        limit: () => ({
          toArray: async () => stores[name] ?? [],
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
        title: 'Daily Status Prep',
        source: 'automation',
        automationKey: 'daily-status-prep',
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
