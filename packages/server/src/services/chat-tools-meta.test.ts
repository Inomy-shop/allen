/**
 * Regression tests for ENG-1524: Remove caller-agent allowlist checks from
 * Allen mutation tools.
 *
 * These tests verify that mutation tools (create_workflow, create_agent,
 * create_team, update_workflow, update_agent, delete_agent, etc.) no longer
 * reject callers based on agent identity. Any agent that has the tools
 * available may call them.
 *
 * Also verifies that destructive safeguards (confirm=true) still function
 * and that update_agent no longer blocks non-spawnTargets field updates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted by vitest) ─────────────────────────────────────────

// Mock active-session resolution. Mocking different caller contexts proves
// the mutation tools don't gate on caller identity.
vi.mock('./chat-tools.js', () => ({
  resolveActiveSession: vi.fn().mockReturnValue(undefined),
}));

// Mock TeamService so team operations don't need a real MongoDB connection.
vi.mock('./team.service.js', () => ({
  TeamService: vi.fn(),
}));

// Mock WorkflowService so workflow operations don't need a real MongoDB
// connection or @allen/engine's validateWorkflow.
vi.mock('./workflow.service.js', () => ({
  WorkflowService: vi.fn(),
}));

// Mock SkillService so skill operations don't need a real MongoDB connection.
vi.mock('./skill.service.js', () => ({
  SkillService: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { resolveActiveSession } from './chat-tools.js';
import { TeamService } from './team.service.js';
import { WorkflowService } from './workflow.service.js';
import { SkillService } from './skill.service.js';
import { metaChatTools } from './chat-tools-meta.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Find a tool in metaChatTools by name. Throws if not found. */
function getTool(name: string) {
  const tool = metaChatTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in metaChatTools`);
  return tool;
}

/**
 * Minimal in-memory db mock.
 *
 * Supports findOne, insertOne, updateOne, deleteOne on agents and teams.
 * Callers control the initial state via the `collections` argument.
 */
function makeMockDb(collections: Record<string, Record<string, unknown>[]> = {}): any {
  const store: Record<string, Record<string, unknown>[]> = {
    agents: [],
    teams: [],
    workflows: [],
    ...collections,
  };

  function findOne(collName: string, query: Record<string, unknown>): Record<string, unknown> | null {
    const docs = store[collName] ?? [];
    return docs.find((doc) => {
      return Object.entries(query).every(([k, v]) => doc[k] === v);
    }) ?? null;
  }

  return {
    collection: (collName: string) => ({
      findOne: async (query: Record<string, unknown>) => findOne(collName, query),
      insertOne: async (doc: Record<string, unknown>) => {
        const id = `id-${collName}-${Date.now()}`;
        const fullDoc = { _id: id, ...doc };
        (store[collName] = store[collName] ?? []).push(fullDoc);
        return { insertedId: id };
      },
      updateOne: async (query: Record<string, unknown>, update: Record<string, unknown>) => {
        const idx = (store[collName] ?? []).findIndex((doc) =>
          Object.entries(query).every(([k, v]) => doc[k] === v),
        );
        if (idx >= 0 && (update as any).$set) {
          store[collName][idx] = { ...store[collName][idx], ...(update as any).$set };
        }
        return { modifiedCount: idx >= 0 ? 1 : 0 };
      },
      deleteOne: async (query: Record<string, unknown>) => {
        const idx = (store[collName] ?? []).findIndex((doc) =>
          Object.entries(query).every(([k, v]) => doc[k] === v),
        );
        if (idx >= 0) store[collName].splice(idx, 1);
        return { deletedCount: idx >= 0 ? 1 : 0 };
      },
    }),
  };
}

/** Configure TeamService mock to provide canned team-service behaviour. */
function configureTeamService(overrides: Partial<{
  getByName: (name: string) => Promise<unknown>;
  create: () => Promise<unknown>;
  promoteToLead: () => Promise<void>;
  update: (name: string, updates: unknown) => Promise<unknown>;
  delete: (name: string) => Promise<void>;
  list: () => Promise<unknown[]>;
  listMembers: (name: string) => Promise<unknown[]>;
  getBlueprint: (name: string) => Promise<unknown>;
}> = {}) {
  const instance = {
    getByName: overrides.getByName ?? vi.fn().mockResolvedValue(null),
    create: overrides.create ?? vi.fn().mockResolvedValue({
      name: 'test-team',
      displayName: 'Test Team',
      leadAgentName: 'test-lead',
      parentTeamName: undefined,
    }),
    promoteToLead: overrides.promoteToLead ?? vi.fn().mockResolvedValue(undefined),
    update: overrides.update ?? vi.fn().mockResolvedValue({ name: 'test-team', displayName: 'Updated Team' }),
    delete: overrides.delete ?? vi.fn().mockResolvedValue(undefined),
    list: overrides.list ?? vi.fn().mockResolvedValue([]),
    listMembers: overrides.listMembers ?? vi.fn().mockResolvedValue([]),
    getBlueprint: overrides.getBlueprint ?? vi.fn().mockResolvedValue(null),
  };
  vi.mocked(TeamService).mockImplementation(() => instance as any);
  return instance;
}

/** Configure WorkflowService mock to provide canned workflow-service behaviour. */
function configureWorkflowService(overrides: Partial<{
  validate: () => Promise<unknown>;
  create: () => Promise<unknown>;
  getById: (id: string) => Promise<unknown>;
  getByName: (name: string) => Promise<unknown>;
  update: (id: string, body: unknown) => Promise<unknown>;
}> = {}) {
  const instance = {
    validate: overrides.validate ?? vi.fn().mockResolvedValue({ valid: true, errors: [], warnings: [] }),
    create: overrides.create ?? vi.fn().mockResolvedValue({
      _id: 'wf-001',
      name: 'test-workflow',
      version: 1,
      validation: { valid: true, errors: [], warnings: [] },
    }),
    getById: overrides.getById ?? vi.fn().mockResolvedValue({
      _id: 'wf-001',
      name: 'test-workflow',
      createdBy: 'workflow-builder',
      version: 2,
    }),
    getByName: overrides.getByName ?? vi.fn().mockResolvedValue(null),
    update: overrides.update ?? vi.fn().mockResolvedValue({
      _id: 'wf-001',
      name: 'test-workflow',
      version: 3,
      validation: { valid: true, errors: [], warnings: [] },
    }),
  };
  vi.mocked(WorkflowService).mockImplementation(() => instance as any);
  return instance;
}

/** Configure SkillService mock to provide canned skill-service behaviour. */
function configureSkillService(overrides: Partial<{
  getById: (id: string) => Promise<unknown>;
  getByName: (name: string) => Promise<unknown>;
  update: (id: string, input: unknown) => Promise<unknown>;
}> = {}) {
  const instance = {
    getById: overrides.getById ?? vi.fn().mockResolvedValue(null),
    getByName: overrides.getByName ?? vi.fn().mockResolvedValue(null),
    update: overrides.update ?? vi.fn().mockResolvedValue({
      _id: 'skill-001',
      name: 'test-skill',
      version: 3,
      displayName: 'Test Skill',
    }),
  };
  vi.mocked(SkillService).mockImplementation(() => instance as any);
  return instance;
}

// ── Caller-context scenarios to test ─────────────────────────────────────────

const CALLER_SCENARIOS = [
  {
    label: 'assistant (no agent context)',
    setup: () => vi.mocked(resolveActiveSession).mockReturnValue(undefined),
  },
  {
    label: 'non-builder agent "codebase-navigator"',
    setup: () =>
      vi.mocked(resolveActiveSession).mockReturnValue({
        chatSessionId: 'sess-1',
        parentMessageId: 'msg-1',
        currentAgent: 'codebase-navigator',
        broadcastEvent: vi.fn(),
        pendingBackgroundTasks: 0,
      }),
  },
  {
    label: 'previously-restricted "workflow-builder-agent"',
    setup: () =>
      vi.mocked(resolveActiveSession).mockReturnValue({
        chatSessionId: 'sess-2',
        parentMessageId: 'msg-2',
        currentAgent: 'workflow-builder-agent',
        broadcastEvent: vi.fn(),
        pendingBackgroundTasks: 0,
      }),
  },
  {
    label: 'previously-restricted "team-builder-agent"',
    setup: () =>
      vi.mocked(resolveActiveSession).mockReturnValue({
        chatSessionId: 'sess-3',
        parentMessageId: 'msg-3',
        currentAgent: 'team-builder-agent',
        broadcastEvent: vi.fn(),
        pendingBackgroundTasks: 0,
      }),
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('chat-tools-meta — allowlist removal (ENG-1524)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── create_workflow ─────────────────────────────────────────────────────────

  describe('create_workflow', () => {
    const tool = getTool('create_workflow');

    for (const scenario of CALLER_SCENARIOS) {
      it(`succeeds from ${scenario.label}`, async () => {
        scenario.setup();
        configureWorkflowService();
        const db = makeMockDb();

        const result = await tool.execute(
          { parsed: { name: 'test-workflow', nodes: [], edges: [] } },
          db,
        );

        // Must NOT be a permission-denied error
        expect(result).not.toMatchObject({ error: expect.stringContaining('Permission denied') });
        expect(result).toMatchObject({ success: true });
      });
    }
  });

  // ── update_workflow ─────────────────────────────────────────────────────────

  describe('update_workflow', () => {
    const tool = getTool('update_workflow');

    for (const scenario of CALLER_SCENARIOS) {
      it(`succeeds from ${scenario.label}`, async () => {
        scenario.setup();
        configureWorkflowService({
          getById: vi.fn().mockResolvedValue({
            _id: 'wf-001',
            name: 'test-workflow',
            createdBy: 'workflow-builder',
            version: 2,
          }),
          update: vi.fn().mockResolvedValue({
            _id: 'wf-001',
            name: 'test-workflow',
            version: 3,
            validation: { valid: true },
          }),
        });
        const db = makeMockDb();

        const result = await tool.execute(
          {
            id: 'wf-001',
            parsed: { name: 'test-workflow', nodes: [], edges: [] },
          },
          db,
        );

        expect(result).not.toMatchObject({ error: expect.stringContaining('Permission denied') });
        expect(result).toMatchObject({ success: true });
      });
    }

    it('still refuses system-seeded workflows', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue(undefined);
      configureWorkflowService({
        getById: vi.fn().mockResolvedValue({
          _id: 'wf-system',
          name: 'seeded-workflow',
          createdBy: 'system',
          version: 1,
        }),
      });
      const db = makeMockDb();

      const result = await tool.execute(
        { id: 'wf-system', parsed: { name: 'seeded-workflow', nodes: [], edges: [] } },
        db,
      );

      expect(result).toMatchObject({ error: expect.stringContaining('system-seeded') });
    });
  });

  // ── update_skill ────────────────────────────────────────────────────────────

  describe('update_skill', () => {
    const tool = getTool('update_skill');

    for (const scenario of CALLER_SCENARIOS) {
      it(`succeeds from ${scenario.label}`, async () => {
        scenario.setup();
        configureSkillService({
          getById: vi.fn().mockResolvedValue({
            _id: 'skill-001',
            name: 'test-skill',
            version: 2,
            displayName: 'Test Skill',
          }),
          update: vi.fn().mockResolvedValue({
            _id: 'skill-001',
            name: 'test-skill',
            version: 3,
            displayName: 'Updated Display Name',
          }),
        });
        const db = makeMockDb();

        const result = await tool.execute(
          { id: 'skill-001', displayName: 'Updated Display Name' },
          db,
        );

        expect(result).not.toMatchObject({ error: expect.stringContaining('Permission denied') });
        expect(result).toMatchObject({ success: true });
      });
    }

    it('returns error when skill not found by id', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue(undefined);
      configureSkillService({
        getById: vi.fn().mockResolvedValue(null),
      });
      const db = makeMockDb();

      const result = await tool.execute({ id: 'nonexistent-id' }, db);

      expect(result).toMatchObject({ error: 'Skill not found' });
    });

    it('returns error when skill not found by name', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue(undefined);
      configureSkillService({
        getByName: vi.fn().mockResolvedValue(null),
      });
      const db = makeMockDb();

      const result = await tool.execute({ name: 'nonexistent-skill' }, db);

      expect(result).toMatchObject({ error: 'Skill not found' });
    });

    it('returns error when no updatable fields supplied', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue(undefined);
      configureSkillService({
        getById: vi.fn().mockResolvedValue({
          _id: 'skill-001',
          name: 'test-skill',
          version: 2,
          displayName: 'Test Skill',
        }),
      });
      const db = makeMockDb();

      const result = await tool.execute({ id: 'skill-001' }, db);

      expect(result).toMatchObject({ error: 'No updatable fields supplied' });
    });

    it('successfully partially updates a skill', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue(undefined);
      const mockUpdate = vi.fn().mockResolvedValue({
        _id: 'skill-001',
        name: 'test-skill',
        version: 3,
        displayName: 'Updated Skill',
      });
      configureSkillService({
        getById: vi.fn().mockResolvedValue({
          _id: 'skill-001',
          name: 'test-skill',
          version: 2,
          displayName: 'Original Skill',
        }),
        update: mockUpdate,
      });
      const db = makeMockDb();

      const result = await tool.execute(
        { id: 'skill-001', displayName: 'Updated Skill', description: 'A new description' },
        db,
      );

      // Verify update was called with correct id
      expect(mockUpdate).toHaveBeenCalledWith('skill-001', expect.objectContaining({
        displayName: 'Updated Skill',
        description: 'A new description',
      }));
      // Verify version bump observed in response
      expect(result).toMatchObject({
        success: true,
        skill: {
          _id: 'skill-001',
          name: 'test-skill',
          version: 3,
          displayName: 'Updated Skill',
        },
      });
    });

    it('propagates validation errors', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue(undefined);
      configureSkillService({
        getById: vi.fn().mockResolvedValue({
          _id: 'skill-001',
          name: 'test-skill',
          version: 2,
          displayName: 'Test Skill',
        }),
        update: vi.fn().mockRejectedValue(new Error('Skill "test-skill" already exists')),
      });
      const db = makeMockDb();

      const result = await tool.execute(
        { id: 'skill-001', new_name: 'duplicate-name' },
        db,
      );

      // Error is returned, not thrown
      expect(result).toMatchObject({ error: 'Skill "test-skill" already exists' });
    });
  });

  // ── create_agent ────────────────────────────────────────────────────────────

  describe('create_agent', () => {
    const tool = getTool('create_agent');

    for (const scenario of CALLER_SCENARIOS) {
      it(`succeeds from ${scenario.label}`, async () => {
        scenario.setup();
        configureTeamService({
          // Team 'test-team' exists
          getByName: vi.fn().mockResolvedValue({
            name: 'test-team',
            displayName: 'Test Team',
            isBuiltIn: false,
          }),
        });
        // No existing agent named 'new-agent'; no existing lead in 'test-team'
        const db = makeMockDb({
          agents: [],
        });

        const result = await tool.execute(
          {
            name: 'new-agent',
            displayName: 'New Agent',
            teamName: 'test-team',
            teamRole: 'member',
            system: 'You are a test agent.',
            provider: 'claude-cli',
          },
          db,
        );

        expect(result).not.toMatchObject({ error: expect.stringContaining('Permission denied') });
        expect(result).toMatchObject({ success: true });
      });
    }
  });

  // ── update_agent ────────────────────────────────────────────────────────────

  describe('update_agent', () => {
    const tool = getTool('update_agent');

    for (const scenario of CALLER_SCENARIOS) {
      it(`succeeds from ${scenario.label}`, async () => {
        scenario.setup();
        configureTeamService();
        const db = makeMockDb({
          agents: [
            {
              name: 'my-agent',
              displayName: 'My Agent',
              isBuiltIn: false,
              teamName: 'test-team',
              teamRole: 'member',
            },
          ],
        });

        const result = await tool.execute(
          { name: 'my-agent', displayName: 'Updated Agent' },
          db,
        );

        expect(result).not.toMatchObject({ error: expect.stringContaining('Permission denied') });
        expect(result).toMatchObject({ success: true });
      });
    }

    it('allows updating fields other than spawnTargets (old agent-builder restriction removed)', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue({
        chatSessionId: 'sess-ab',
        parentMessageId: 'msg-ab',
        currentAgent: 'agent-builder-agent',
        broadcastEvent: vi.fn(),
        pendingBackgroundTasks: 0,
      });
      configureTeamService();
      const db = makeMockDb({
        agents: [
          {
            name: 'editable-agent',
            isBuiltIn: false,
            teamName: 'engineering',
            teamRole: 'member',
          },
        ],
      });

      // In the old code, agent-builder-agent could ONLY update spawnTargets.
      // Now any field should be accepted — update system + model + displayName.
      const result = await tool.execute(
        {
          name: 'editable-agent',
          displayName: 'Renamed Agent',
          system: 'New system prompt.',
          model: 'opus',
        },
        db,
      );

      expect(result).not.toMatchObject({
        error: expect.stringContaining('can only update spawnTargets'),
      });
      expect(result).toMatchObject({
        success: true,
        updated: expect.arrayContaining(['displayName', 'system', 'model']),
      });
    });

    it('allows updating built-in agents', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue(undefined);
      configureTeamService();
      const db = makeMockDb({
        agents: [
          {
            name: 'engineering-lead',
            displayName: 'Engineering Lead',
            isBuiltIn: true,
            teamName: 'engineering',
            teamRole: 'lead',
            spawnTargets: ['frontend-developer'],
          },
        ],
      });

      const result = await tool.execute(
        {
          name: 'engineering-lead',
          spawnTargets: ['frontend-developer', 'ui-copywriter'],
          system: 'Updated built-in lead prompt.',
        },
        db,
      );

      expect(result).not.toMatchObject({ error: expect.stringContaining('built-in') });
      expect(result).toMatchObject({
        success: true,
        updated: expect.arrayContaining(['spawnTargets', 'system']),
      });
    });
  });

  // ── delete_agent ────────────────────────────────────────────────────────────

  describe('delete_agent', () => {
    const tool = getTool('delete_agent');

    for (const scenario of CALLER_SCENARIOS) {
      it(`succeeds from ${scenario.label} when confirm=true`, async () => {
        scenario.setup();
        configureTeamService();
        const db = makeMockDb({
          agents: [
            {
              name: 'disposable-agent',
              isBuiltIn: false,
              teamName: 'test-team',
              teamRole: 'member',
            },
          ],
          teams: [{ name: 'test-team', isBuiltIn: false }],
        });

        const result = await tool.execute(
          { name: 'disposable-agent', confirm: true },
          db,
        );

        expect(result).not.toMatchObject({ error: expect.stringContaining('Permission denied') });
        expect(result).toMatchObject({ success: true, deleted: 'disposable-agent' });
      });
    }

    it('still requires confirm=true (destructive safeguard preserved)', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue(undefined);
      configureTeamService();
      const db = makeMockDb({
        agents: [{ name: 'safe-agent', isBuiltIn: false }],
      });

      const result = await tool.execute({ name: 'safe-agent', confirm: false }, db);

      // Must NOT succeed — confirm is required
      expect(result).toMatchObject({ error: expect.stringContaining('confirm') });
      expect(result).not.toMatchObject({ success: true });
    });

    it('still refuses to delete built-in agents', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue(undefined);
      configureTeamService();
      const db = makeMockDb({
        agents: [{ name: 'built-in-agent', isBuiltIn: true }],
      });

      const result = await tool.execute({ name: 'built-in-agent', confirm: true }, db);

      expect(result).toMatchObject({ error: expect.stringContaining('built-in') });
    });
  });

  // ── create_team ─────────────────────────────────────────────────────────────

  describe('create_team', () => {
    const tool = getTool('create_team');

    for (const scenario of CALLER_SCENARIOS) {
      it(`succeeds from ${scenario.label}`, async () => {
        scenario.setup();
        configureTeamService({
          // No existing team named 'new-team'
          getByName: vi.fn().mockResolvedValue(null),
        });
        // Lead agent exists in agents collection
        const db = makeMockDb({
          agents: [{ name: 'test-lead', teamName: 'new-team', teamRole: 'lead' }],
        });

        const result = await tool.execute(
          {
            name: 'new-team',
            displayName: 'New Team',
            leadAgentName: 'test-lead',
          },
          db,
        );

        expect(result).not.toMatchObject({ error: expect.stringContaining('Permission denied') });
        expect(result).toMatchObject({ success: true });
      });
    }
  });

  // ── delete_team ─────────────────────────────────────────────────────────────

  describe('delete_team', () => {
    const tool = getTool('delete_team');

    it('still requires confirm=true (destructive safeguard preserved)', async () => {
      vi.mocked(resolveActiveSession).mockReturnValue(undefined);
      configureTeamService();
      const db = makeMockDb();

      const result = await tool.execute({ name: 'some-team', confirm: false }, db);

      expect(result).toMatchObject({ error: expect.stringContaining('confirm') });
      expect(result).not.toMatchObject({ success: true });
    });

    for (const scenario of CALLER_SCENARIOS) {
      it(`succeeds from ${scenario.label} when confirm=true`, async () => {
        scenario.setup();
        configureTeamService({
          // delete resolves successfully
          delete: vi.fn().mockResolvedValue(undefined),
        });
        const db = makeMockDb();

        const result = await tool.execute({ name: 'old-team', confirm: true }, db);

        expect(result).not.toMatchObject({ error: expect.stringContaining('Permission denied') });
        // Tool either returns success or a domain error (e.g. "team has members")
        // but must NOT be a permission error
        if ('error' in result) {
          expect(result.error as string).not.toContain('Permission denied');
        }
      });
    }
  });

  // ── update_team ─────────────────────────────────────────────────────────────

  describe('update_team', () => {
    const tool = getTool('update_team');

    for (const scenario of CALLER_SCENARIOS) {
      it(`succeeds from ${scenario.label}`, async () => {
        scenario.setup();
        configureTeamService({
          update: vi.fn().mockResolvedValue({ name: 'my-team', displayName: 'My Team' }),
        });
        const db = makeMockDb();

        const result = await tool.execute({ name: 'my-team', displayName: 'My Team' }, db);

        expect(result).not.toMatchObject({ error: expect.stringContaining('Permission denied') });
        expect(result).toMatchObject({ success: true });
      });
    }
  });
});
