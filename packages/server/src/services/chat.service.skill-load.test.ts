/**
 * Unit tests for the `/skill <name>` load command in chat.
 *
 *  - parseSkillLoadCommand(): command detection
 *  - ChatService.resolveSkillLoad(): registry resolution, slug normalization,
 *    disabled-skill rejection, suggestions for unknown skills
 *  - ChatService.sendMessage(): valid load persists the original content with
 *    a skillLoad marker and swaps the LLM content for the canonical
 *    instruction; unknown/disabled skills 400 BEFORE anything is persisted
 *  - /skill is never handed to the provider-CLI slash dispatch, even when a
 *    provider command named "/skill" exists
 *
 * Uses mongodb-memory-server (like skill.service.test.ts) so SkillService
 * queries run against a real MongoDB instance.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

// ── Mock transitive dependencies that chat.service.ts imports ───────────────

vi.mock('./chat-llm.js', () => ({
  PROVIDERS: [],
  runChatLLM: vi.fn().mockResolvedValue({
    text: 'Loaded the skill.',
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
  resolveAgentSettings: vi.fn().mockReturnValue({}),
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
  CostRollupService: vi.fn().mockImplementation(() => ({
    refreshSessionCost: vi.fn().mockResolvedValue(undefined),
    getChatSessionCost: vi.fn().mockResolvedValue(null),
    getChatSessionsCostBatch: vi.fn().mockResolvedValue(new Map()),
  })),
}));

vi.mock('./context/core/chat-context-packet.service.js', () => ({
  ChatContextPacketService: vi.fn().mockImplementation(() => ({
    buildChatContextPacket: vi.fn().mockResolvedValue(null),
    recordChatContextUsage: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Provider-CLI slash catalog: include a dispatchable "/skill" command to prove
// the guard wins even when a provider command with that name exists.
vi.mock('./slash-commands.js', () => ({
  listSlashCommands: vi.fn().mockReturnValue([
    { name: '/skill', description: 'provider skill cmd', provider: 'claude', source: 'user', kind: 'command', dispatchable: true },
    { name: '/compact', description: 'Compact history', provider: 'claude', source: 'builtin', kind: 'builtin', dispatchable: true },
  ]),
}));

vi.mock('./chat-runtime-manager.js', () => ({
  runPersistentChatSlashCommand: vi.fn().mockResolvedValue({
    text: 'slash dispatched',
    costUsd: 0,
    tokenUsage: null,
    sessionId: 'llm-session-1',
    trace: [],
  }),
  steerPersistentChat: vi.fn().mockResolvedValue(false),
}));

// Import after all mocks
import {
  ChatService,
  parseSkillLoadCommand,
  buildSkillLoadInstruction,
  resolveProviderSlashCommand,
} from './chat.service.js';
import { runChatLLM } from './chat-llm.js';
import { runPersistentChatSlashCommand } from './chat-runtime-manager.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    writeHead: vi.fn(),
    write: vi.fn(),
    on: vi.fn(),
  };
  return res as unknown as Response & typeof res;
}

describe('/skill load command', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let service: ChatService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('chat-skill-load-test');
    service = new ChatService(db);
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    vi.mocked(runChatLLM).mockClear();
    vi.mocked(runPersistentChatSlashCommand).mockClear();
    await db.collection('skills').deleteMany({});
    await db.collection('chat_sessions').deleteMany({});
    await db.collection('chat_messages').deleteMany({});
    await db.collection('skills').insertMany([
      {
        name: 'prd-authoring',
        displayName: 'PRD Authoring',
        description: 'Author PRDs',
        enabled: true,
        priority: 50,
        body: 'When to use: authoring PRDs.',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        name: 'disabled-skill',
        displayName: 'Disabled Skill',
        description: 'Not available',
        enabled: false,
        priority: 50,
        body: 'When to use: never.',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  });

  async function seedSession(): Promise<string> {
    const oid = new ObjectId();
    await db.collection('chat_sessions').insertOne({
      _id: oid,
      title: 'Skill chat',
      titleSource: 'user', // skip auto-title so runChatLLM is only the turn call
      status: 'active',
      provider: 'claude',
      model: 'test-model',
      messageCount: 0,
      totalCostUsd: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return String(oid);
  }

  // ── parseSkillLoadCommand ──────────────────────────────────────────────────

  describe('parseSkillLoadCommand()', () => {
    it('parses "/skill <name>"', () => {
      expect(parseSkillLoadCommand('/skill prd-authoring')).toBe('prd-authoring');
      expect(parseSkillLoadCommand('  /skill prd-authoring  ')).toBe('prd-authoring');
    });

    it('preserves the raw (un-normalized) name', () => {
      expect(parseSkillLoadCommand('/skill PRD-Authoring')).toBe('PRD-Authoring');
    });

    it('rejects non-skill content', () => {
      expect(parseSkillLoadCommand('/skill')).toBeNull();
      expect(parseSkillLoadCommand('/skill two words')).toBeNull();
      expect(parseSkillLoadCommand('/skills prd-authoring')).toBeNull();
      expect(parseSkillLoadCommand('hello /skill prd-authoring')).toBeNull();
      expect(parseSkillLoadCommand('regular message')).toBeNull();
    });
  });

  // ── resolveSkillLoad ───────────────────────────────────────────────────────

  describe('ChatService.resolveSkillLoad()', () => {
    it('returns null for regular messages', async () => {
      expect(await service.resolveSkillLoad('what is up?')).toBeNull();
      expect(await service.resolveSkillLoad('/compact')).toBeNull();
    });

    it('resolves an enabled skill with marker fields and canonical instruction', async () => {
      const result = await service.resolveSkillLoad('/skill prd-authoring');
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(true);
      if (result!.ok) {
        expect(result!.skillLoad).toEqual({ name: 'prd-authoring', displayName: 'PRD Authoring' });
        expect(result!.llmContent).toBe(buildSkillLoadInstruction('PRD Authoring', 'prd-authoring'));
        expect(result!.llmContent).toContain("loaded the skill 'PRD Authoring' (prd-authoring)");
        expect(result!.llmContent).toContain('get_skill');
        expect(result!.llmContent).toContain('most recently loaded takes precedence');
      }
    });

    it('slug-normalizes the name like SkillService.getByName ("PRD-Authoring" → "prd-authoring")', async () => {
      const result = await service.resolveSkillLoad('/skill PRD-Authoring');
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.skillLoad.name).toBe('prd-authoring');
      }
    });

    it('rejects an unknown skill with suggestions', async () => {
      const result = await service.resolveSkillLoad('/skill prd-authorin');
      expect(result?.ok).toBe(false);
      if (result && !result.ok) {
        expect(result.error).toContain('Unknown skill "prd-authorin"');
        expect(result.suggestions).toContain('prd-authoring');
        expect(result.suggestions.length).toBeLessThanOrEqual(3);
      }
    });

    it('rejects a disabled skill', async () => {
      const result = await service.resolveSkillLoad('/skill disabled-skill');
      expect(result?.ok).toBe(false);
      if (result && !result.ok) {
        expect(result.error).toContain('"disabled-skill" is disabled');
      }
    });
  });

  // ── sendMessage integration ────────────────────────────────────────────────

  describe('ChatService.sendMessage() with /skill', () => {
    it('persists the original content with a skillLoad marker and sends the instruction to the LLM', async () => {
      const sessionId = await seedSession();
      const res = makeRes();

      await service.sendMessage(sessionId, '/skill prd-authoring', res);

      // Wait for the fire-and-forget runLLM turn to complete
      await vi.waitFor(async () => {
        const assistant = await db.collection('chat_messages').findOne({ sessionId, role: 'assistant' });
        expect(assistant?.status).toBe('completed');
      });

      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());

      const userMsg = await db.collection('chat_messages').findOne({ sessionId, role: 'user' });
      expect(userMsg?.content).toBe('/skill prd-authoring');
      expect(userMsg?.skillLoad).toEqual({ name: 'prd-authoring', displayName: 'PRD Authoring' });

      const instruction = buildSkillLoadInstruction('PRD Authoring', 'prd-authoring');
      expect(runChatLLM).toHaveBeenCalledTimes(1);
      const llmArgs = vi.mocked(runChatLLM).mock.calls[0][1] as { messages: Array<{ role: string; content: string }> };
      const lastUser = llmArgs.messages.at(-1)!;
      expect(lastUser.role).toBe('user');
      expect(lastUser.content).toContain(instruction);
      expect(lastUser.content).not.toContain('/skill prd-authoring');

      // Never handed to the provider-CLI slash dispatch
      expect(runPersistentChatSlashCommand).not.toHaveBeenCalled();
    });

    it('returns 400 with suggestions for an unknown skill BEFORE persisting anything', async () => {
      const sessionId = await seedSession();
      const res = makeRes();

      await service.sendMessage(sessionId, '/skill nope-not-real', res);

      expect(res.status).toHaveBeenCalledWith(400);
      const payload = res.json.mock.calls[0][0] as { error: string; suggestions: string[] };
      expect(payload.error).toContain('Unknown skill "nope-not-real"');
      expect(Array.isArray(payload.suggestions)).toBe(true);
      expect(payload.suggestions.length).toBeLessThanOrEqual(3);

      expect(res.writeHead).not.toHaveBeenCalled();
      expect(await db.collection('chat_messages').countDocuments({ sessionId })).toBe(0);
      const session = await db.collection('chat_sessions').findOne({ _id: new ObjectId(sessionId) });
      expect(session?.messageCount).toBe(0);
      expect(runChatLLM).not.toHaveBeenCalled();
    });

    it('returns 400 for a disabled skill', async () => {
      const sessionId = await seedSession();
      const res = makeRes();

      await service.sendMessage(sessionId, '/skill disabled-skill', res);

      expect(res.status).toHaveBeenCalledWith(400);
      const payload = res.json.mock.calls[0][0] as { error: string };
      expect(payload.error).toContain('"disabled-skill" is disabled');
      expect(await db.collection('chat_messages').countDocuments({ sessionId })).toBe(0);
    });
  });

  // ── provider-CLI slash dispatch exclusion ──────────────────────────────────

  describe('resolveProviderSlashCommand()', () => {
    it('never dispatches "/skill <name>" to the provider CLI, even when a "/skill" command exists', () => {
      expect(resolveProviderSlashCommand('/skill prd-authoring', 'claude')).toBeNull();
      expect(resolveProviderSlashCommand('/skill anything-at-all', 'codex')).toBeNull();
    });

    it('still dispatches other provider slash commands', () => {
      const resolved = resolveProviderSlashCommand('/compact', 'claude');
      expect(resolved).not.toBeNull();
      expect(resolved?.name).toBe('/compact');
    });
  });
});
