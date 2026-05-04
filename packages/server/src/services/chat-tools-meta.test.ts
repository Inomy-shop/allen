/**
 * ENG-1524 — Regression tests: caller-agent allowlist checks removed from mutation tools.
 *
 * These tests verify that create_workflow, create_agent, and team mutation tools
 * succeed regardless of the calling agent context (assistant, non-builder, etc.)
 * as long as normal validation passes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the chat-tools.js module so getAnyActiveSession is controllable
vi.mock('./chat-tools.js', () => ({
  getAnyActiveSession: vi.fn(),
}));

// Mock WorkflowService
vi.mock('./workflow.service.js', () => ({
  WorkflowService: vi.fn().mockImplementation(() => ({
    validate: vi.fn().mockResolvedValue({ valid: true, errors: [], warnings: [] }),
    create: vi.fn().mockResolvedValue({
      _id: 'wf-id-123',
      name: 'test-workflow',
      version: 1,
      validation: { valid: true, errors: [], warnings: [] },
    }),
    getByName: vi.fn().mockResolvedValue(null),
    getById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({ _id: 'wf-id-123', name: 'test-workflow', version: 2, validation: { valid: true } }),
  })),
}));

// Mock TeamService
vi.mock('./team.service.js', () => ({
  TeamService: vi.fn().mockImplementation(() => ({
    list: vi.fn().mockResolvedValue([]),
    getByName: vi.fn().mockResolvedValue(null),
    listMembers: vi.fn().mockResolvedValue([]),
    getBlueprint: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ name: 'new-team', displayName: 'New Team', leadAgentName: 'lead-agent', parentTeamName: 'executive' }),
    update: vi.fn().mockResolvedValue({ name: 'existing-team', displayName: 'Updated Team' }),
    delete: vi.fn().mockResolvedValue(undefined),
    promoteToLead: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { metaChatTools } from './chat-tools-meta.js';
import { getAnyActiveSession } from './chat-tools.js';

const mockedGetAnyActiveSession = vi.mocked(getAnyActiveSession);

// Build a minimal mock DB
function buildMockDb(overrides: Record<string, unknown> = {}) {
  const agents = new Map<string, unknown>();
  const teams = new Map<string, unknown>();

  return {
    collection: vi.fn((name: string) => {
      if (name === 'agents') {
        return {
          findOne: vi.fn((query: any) => Promise.resolve(agents.get(query.name ?? '') ?? null)),
          insertOne: vi.fn((doc: any) => { agents.set(doc.name, doc); return Promise.resolve({ insertedId: 'new-id' }); }),
          updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
          deleteOne: vi.fn((query: any) => { agents.delete(query.name); return Promise.resolve({ deletedCount: 1 }); }),
          _agents: agents,
        };
      }
      if (name === 'teams') {
        return {
          findOne: vi.fn((query: any) => Promise.resolve(teams.get(query.name ?? '') ?? null)),
          _teams: teams,
        };
      }
      return { findOne: vi.fn().mockResolvedValue(null), insertOne: vi.fn().mockResolvedValue({}), updateOne: vi.fn().mockResolvedValue({}), deleteOne: vi.fn().mockResolvedValue({}) };
    }),
    ...overrides,
  } as any;
}

const minimalWorkflowYaml = `
name: test-workflow
nodes:
  - name: start
    type: agent
    agent: research-agent
    prompt: "Do the thing"
edges: []
`.trim();

describe('ENG-1524: caller-agent allowlist removed from mutation tools', () => {
  const createWorkflow = metaChatTools.find((t) => t.name === 'create_workflow')!;
  const createAgent = metaChatTools.find((t) => t.name === 'create_agent')!;
  const deleteTeam = metaChatTools.find((t) => t.name === 'delete_team')!;
  const updateAgent = metaChatTools.find((t) => t.name === 'update_agent')!;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── create_workflow ──────────────────────────────────────────────────────────

  describe('create_workflow', () => {
    it('succeeds when called from "assistant" context (no active session)', async () => {
      mockedGetAnyActiveSession.mockReturnValue(undefined as any);
      const db = buildMockDb();

      const result = await createWorkflow.execute({ yaml: minimalWorkflowYaml }, db);

      expect(result).not.toHaveProperty('error');
      expect((result as any).success).toBe(true);
    });

    it('succeeds when called from a non-builder agent (e.g. engineering-lead)', async () => {
      mockedGetAnyActiveSession.mockReturnValue({ currentAgent: 'engineering-lead', chatSessionId: 'sess-1', delegationDepth: 0, currentConversationId: null } as any);
      const db = buildMockDb();

      const result = await createWorkflow.execute({ yaml: minimalWorkflowYaml }, db);

      expect(result).not.toHaveProperty('error');
      expect((result as any).success).toBe(true);
    });

    it('returns error when neither yaml nor parsed is provided', async () => {
      mockedGetAnyActiveSession.mockReturnValue(undefined as any);
      const db = buildMockDb();

      const result = await createWorkflow.execute({}, db);

      expect((result as any).error).toMatch(/Provide either/);
    });
  });

  // ── create_agent ─────────────────────────────────────────────────────────────

  describe('create_agent', () => {
    it('succeeds when called from "assistant" context', async () => {
      mockedGetAnyActiveSession.mockReturnValue(undefined as any);
      const db = buildMockDb();

      // Team doesn't exist and we're creating a lead — that's the bootstrap path
      const result = await createAgent.execute({
        name: 'my-new-agent',
        displayName: 'My New Agent',
        teamName: 'my-new-team',
        teamRole: 'lead',
        system: 'You are a helpful assistant.',
        provider: 'claude-cli',
      }, db);

      expect(result).not.toHaveProperty('error');
      expect((result as any).success).toBe(true);
    });

    it('succeeds when called from a non-builder agent', async () => {
      mockedGetAnyActiveSession.mockReturnValue({ currentAgent: 'root-cause-remediation-agent', chatSessionId: 'sess-2', delegationDepth: 1, currentConversationId: 'conv-1' } as any);
      const db = buildMockDb();

      const result = await createAgent.execute({
        name: 'my-new-agent-2',
        displayName: 'My New Agent 2',
        teamName: 'some-new-team',
        teamRole: 'lead',
        system: 'You help.',
        provider: 'claude-cli',
      }, db);

      expect(result).not.toHaveProperty('error');
      expect((result as any).success).toBe(true);
    });

    it('returns error when agent name already exists', async () => {
      mockedGetAnyActiveSession.mockReturnValue(undefined as any);
      const db = buildMockDb();
      // Pre-seed via the shared Map so ALL db.collection('agents') calls see it.
      // (Setting .findOne on a one-shot return object won't be seen by subsequent calls.)
      // Use teamRole:'lead' so we take the bootstrap path (team need not exist for leads)
      // and reach the duplicate-name check at line 289 of chat-tools-meta.ts.
      const agentsMap = (db.collection('agents') as any)._agents as Map<string, unknown>;
      agentsMap.set('duplicate-agent', { name: 'duplicate-agent' });

      const result = await createAgent.execute({
        name: 'duplicate-agent',
        displayName: 'Duplicate',
        teamName: 'some-team',
        teamRole: 'lead',
        system: 'You help.',
        provider: 'claude-cli',
      }, db);

      expect((result as any).error).toMatch(/already exists/);
    });
  });

  // ── delete_team ──────────────────────────────────────────────────────────────

  describe('delete_team', () => {
    it('requires confirm=true regardless of caller', async () => {
      mockedGetAnyActiveSession.mockReturnValue(undefined as any);
      const db = buildMockDb();

      const result = await deleteTeam.execute({ name: 'some-team', confirm: false }, db);

      expect((result as any).error).toMatch(/confirm=true/);
    });

    it('proceeds when confirm=true', async () => {
      mockedGetAnyActiveSession.mockReturnValue(undefined as any);
      const db = buildMockDb();

      const result = await deleteTeam.execute({ name: 'some-team', confirm: true }, db);

      expect(result).not.toHaveProperty('error');
    });
  });

  // ── update_agent (canDelegateTo restriction removed) ─────────────────────────

  describe('update_agent', () => {
    it('allows non-canDelegateTo fields to be updated from any caller', async () => {
      mockedGetAnyActiveSession.mockReturnValue({ currentAgent: 'agent-builder-agent', chatSessionId: 'sess-3', delegationDepth: 1, currentConversationId: 'conv-2' } as any);
      const db = buildMockDb();
      // Pre-seed via the shared Map so ALL db.collection('agents') calls see it.
      // Setting .findOne on a one-shot return object doesn't work because each
      // call to db.collection('agents') creates a new object sharing the same Map closure.
      const agentsMap = (db.collection('agents') as any)._agents as Map<string, unknown>;
      agentsMap.set('target-agent', { name: 'target-agent', isBuiltIn: false });

      const result = await updateAgent.execute({
        name: 'target-agent',
        system: 'Updated system prompt.',
      }, db);

      // Should succeed — the old canDelegateTo-only restriction for agent-builder-agent is gone
      expect(result).not.toHaveProperty('error');
    });
  });
});
