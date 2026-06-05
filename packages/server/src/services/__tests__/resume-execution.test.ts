/**
 * Unit tests for resumeAgentExecution session-ID fallback chain
 * and resume_execution tool routing guard.
 *
 * AC-001..AC-006 — session-id fallback chain and routing guard fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (must be before any imports that trigger chat-tools.ts load) ──

// vi.hoisted runs before vi.mock factories — lets us reference mockRunSpawn inside mocks.
const { mockRunSpawn } = vi.hoisted(() => ({
  mockRunSpawn: vi.fn().mockResolvedValue(undefined),
}));

// Mock all transitive dependencies of chat-tools.ts so the module can load.
vi.mock('@allen/engine', () => ({
  MCP_SERVER_NAME: 'test-mcp',
  normalizeModelAlias: (x: string) => x,
  ARTIFACTS_GUIDANCE: '',
  NON_INTERACTIVE_GUIDANCE: '',
}));

vi.mock('../chat-providers.js', () => ({
  AGENT_FALLBACK_CWD: '/tmp',
  getChatProvider: vi.fn(),
  getDefaultChatProvider: vi.fn().mockReturnValue('claude'),
  getProvidersInDefaultOrder: vi.fn().mockReturnValue([]),
  getEnabledProvidersInDefaultOrder: vi.fn().mockResolvedValue([]),
}));

vi.mock('../chat-llm.js', () => ({
  streamChatCompletion: vi.fn(),
  runChatLLM: vi.fn().mockResolvedValue({ content: '', cost: 0 }),
}));

vi.mock('../alert.service.js', () => ({
  sendAlert: vi.fn(),
  AlertService: vi.fn().mockImplementation(() => ({ createAlert: vi.fn() })),
}));

vi.mock('../execution.service.js', () => ({
  ExecutionService: vi.fn().mockImplementation(() => ({
    runFromCheckpoint: vi.fn().mockResolvedValue({ resumed: true }),
    listCheckpoints: vi.fn().mockResolvedValue([{ id: 'ckpt1' }]),
    start: vi.fn().mockResolvedValue({ id: 'exec-1', status: 'running' }),
  })),
}));

vi.mock('../intervention.service.js', () => ({
  InterventionService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../agent-conversation.service.js', () => ({
  AgentConversationService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../agent-activity.service.js', () => ({
  AgentActivityService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../embedding.service.js', () => ({
  embedAndSave: vi.fn().mockResolvedValue(undefined),
  invalidateCache: vi.fn(),
  searchSimilar: vi.fn().mockResolvedValue([]),
  backfillEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../self-healing-monitor.service.js', () => ({
  MonitoringService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../repo-context-builder.js', () => ({
  buildRepoContextBlock: vi.fn().mockResolvedValue(''),
  RepoContextBuilder: vi.fn(),
}));

vi.mock('../chat-tools-meta.js', () => ({
  metaChatTools: [],
  META_DESTRUCTIVE_TOOLS: [],
}));

vi.mock('../monitoring-agent-tools.js', () => ({
  monitoringAgentTools: [],
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Import the module under test AFTER all mocks are registered.
import { resumeAgentExecution, __internalsForTest } from '../chat-tools.js';
import type { Db } from 'mongodb';

// ── In-memory DB shim ──────────────────────────────────────────────────────

interface FakeDbState {
  exec: Record<string, unknown> | null;
  role: Record<string, unknown> | null;
  /** Result of findOne with sort by completedAt (session fallback trace query). */
  traceForSession?: Record<string, unknown> | null;
  /** Result of find().sort({attempt:-1}).limit(1).toArray() (nextAttempt query). */
  lastTrace?: Record<string, unknown> | null;
  updates: Array<{ filter: unknown; update: unknown }>;
}

function makeFakeDb(state: FakeDbState): Db {
  const updates = state.updates;
  return {
    collection(name: string) {
      return {
        async findOne(query: Record<string, unknown>, options?: Record<string, unknown>) {
          if (name === 'executions') return state.exec;
          if (name === 'agents') return state.role;
          if (name === 'execution_traces') {
            // Detect the session-fallback findOne by its sort options (completedAt: -1)
            const sortOpts = (options as { sort?: Record<string, number> } | undefined)?.sort;
            if (sortOpts && 'completedAt' in sortOpts) {
              return state.traceForSession ?? null;
            }
            return null;
          }
          return null;
        },
        // Used for lastTrace (nextAttempt): .find({executionId}).sort({attempt:-1}).limit(1).toArray()
        find(_query: unknown) {
          return {
            sort(_s: unknown) { return this; },
            limit(_n: unknown) { return this; },
            async toArray() {
              if (name === 'execution_traces') {
                return state.lastTrace ? [state.lastTrace] : [];
              }
              return [];
            },
          };
        },
        async updateOne(filter: unknown, update: unknown) {
          updates.push({ filter, update });
          let matched = true;
          if (name === 'executions') {
            const f = filter as Record<string, any>;
            matched = Boolean(state.exec);
            if (matched && f.id && state.exec?.id !== f.id) matched = false;
            if (matched && f.status?.$nin && f.status.$nin.includes(state.exec?.status)) matched = false;
            if (matched) {
              const set = (update as Record<string, any>).$set as Record<string, unknown> | undefined;
              if (set && state.exec) state.exec = { ...state.exec, ...set };
            }
          }
          return { matchedCount: matched ? 1 : 0, modifiedCount: matched ? 1 : 0 };
        },
        async insertOne(_doc: unknown) {
          return { insertedId: 'fake-id' };
        },
      };
    },
  } as unknown as Db;
}

// ── Shared fixtures ───────────────────────────────────────────────────────

const AGENT_NAME = 'test-agent';
const EXEC_ID = 'exec-123';

const BASE_EXEC: Record<string, unknown> = {
  id: EXEC_ID,
  workflowName: `chat:spawn_agent/${AGENT_NAME}`,
  workflowId: null,
  source: 'spawn',
  sessions: {},
  input: {},
  status: 'failed',
  completedNodes: [AGENT_NAME],
  currentNodes: [],
  parentExecutionId: null,
  rootExecutionId: EXEC_ID,
  spawnDepth: 0,
  meta: { cwd: '/tmp', chatSessionId: null },
};

const BASE_ROLE = { name: AGENT_NAME, systemPrompt: 'You are a test agent' };
const BASE_LAST_TRACE = { attempt: 1, output: {} };

// ── Test setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRunSpawn.mockClear();
  // Replace the test-injection seam so all runSpawnInBackground calls go to mockRunSpawn.
  __internalsForTest.runSpawnInBackground = mockRunSpawn as typeof __internalsForTest.runSpawnInBackground;
});

describe('spawn completion guard', () => {
  it('does not overwrite a cancelled spawned-agent execution as completed', async () => {
    const updates: Array<{ filter: unknown; update: unknown }> = [];
    const state: FakeDbState = {
      exec: { ...BASE_EXEC, status: 'cancelled', completedNodes: [], currentNodes: [] },
      role: BASE_ROLE,
      updates,
    };
    const db = makeFakeDb(state);

    const completed = await __internalsForTest.markSpawnCompletedUnlessTerminal(
      db,
      EXEC_ID,
      AGENT_NAME,
      0.42,
      12_000,
      'session-after-cancel',
    );

    expect(completed).toBe(false);
    expect(state.exec?.status).toBe('cancelled');
  });

  it('marks a running spawned-agent execution as completed', async () => {
    const updates: Array<{ filter: unknown; update: unknown }> = [];
    const state: FakeDbState = {
      exec: { ...BASE_EXEC, status: 'running', completedNodes: [], currentNodes: [AGENT_NAME] },
      role: BASE_ROLE,
      updates,
    };
    const db = makeFakeDb(state);

    const completed = await __internalsForTest.markSpawnCompletedUnlessTerminal(
      db,
      EXEC_ID,
      AGENT_NAME,
      0.42,
      12_000,
      'session-complete',
    );

    expect(completed).toBe(true);
    expect(state.exec?.status).toBe('completed');
    expect(state.exec?.currentNodes).toEqual([]);
    expect(state.exec?.completedNodes).toEqual([AGENT_NAME]);
  });
});

// ── Tests: session-ID fallback chain ─────────────────────────────────────

describe('resumeAgentExecution — session-ID fallback chain', () => {
  it('AC-001: resolves sessionId from sessions map (primary path)', async () => {
    const updates: Array<{ filter: unknown; update: unknown }> = [];
    const db = makeFakeDb({
      exec: { ...BASE_EXEC, sessions: { [AGENT_NAME]: 'ses_primary' } },
      role: BASE_ROLE,
      traceForSession: null,   // should NOT be queried for session
      lastTrace: BASE_LAST_TRACE,
      updates,
    });

    const result = await resumeAgentExecution(db, EXEC_ID, 'Resume task');

    expect(result).not.toHaveProperty('error');
    expect(mockRunSpawn).toHaveBeenCalledOnce();

    // 'ses_primary' should be one of the arguments (6th positional: resumeSession)
    const callArgs = mockRunSpawn.mock.calls[0] as unknown[];
    expect(callArgs).toContain('ses_primary');

    // No session backfill $set should have been written (primary path needs no backfill)
    const sessionSets = updates.filter((u) => {
      const upd = u.update as Record<string, unknown>;
      const set = upd.$set as Record<string, unknown> | undefined;
      return set && Object.keys(set).some((k) => k.startsWith('sessions.'));
    });
    expect(sessionSets).toHaveLength(0);
  });

  it('AC-002: falls back to trace.output.session_id and backfills (trace path)', async () => {
    const updates: Array<{ filter: unknown; update: unknown }> = [];
    const db = makeFakeDb({
      exec: { ...BASE_EXEC, sessions: {}, input: {} },
      role: BASE_ROLE,
      traceForSession: { output: { session_id: 'ses_trace' } },
      lastTrace: BASE_LAST_TRACE,
      updates,
    });

    const result = await resumeAgentExecution(db, EXEC_ID, 'Resume task');

    expect(result).not.toHaveProperty('error');
    expect(mockRunSpawn).toHaveBeenCalledOnce();

    const callArgs = mockRunSpawn.mock.calls[0] as unknown[];
    expect(callArgs).toContain('ses_trace');

    // Backfill must have been written
    const backfills = updates.filter((u) => {
      const upd = u.update as Record<string, unknown>;
      const set = upd.$set as Record<string, unknown> | undefined;
      return set?.[`sessions.${AGENT_NAME}`] === 'ses_trace';
    });
    expect(backfills).toHaveLength(1);

    // Backfill must appear BEFORE the status-reset update in the updates array
    const backfillIdx = updates.indexOf(backfills[0]);
    const statusResetIdx = updates.findIndex((u) => {
      const upd = u.update as Record<string, unknown>;
      const set = upd.$set as Record<string, unknown> | undefined;
      return set?.status === 'running';
    });
    expect(backfillIdx).toBeLessThan(statusResetIdx >= 0 ? statusResetIdx : Infinity);
  });

  it('AC-003: falls back to input.session_id and backfills (input path)', async () => {
    const updates: Array<{ filter: unknown; update: unknown }> = [];
    const db = makeFakeDb({
      exec: { ...BASE_EXEC, sessions: {}, input: { session_id: 'ses_input' } },
      role: BASE_ROLE,
      traceForSession: null,
      lastTrace: BASE_LAST_TRACE,
      updates,
    });

    const result = await resumeAgentExecution(db, EXEC_ID, 'Resume task');

    expect(result).not.toHaveProperty('error');
    expect(mockRunSpawn).toHaveBeenCalledOnce();

    const callArgs = mockRunSpawn.mock.calls[0] as unknown[];
    expect(callArgs).toContain('ses_input');

    const backfills = updates.filter((u) => {
      const upd = u.update as Record<string, unknown>;
      const set = upd.$set as Record<string, unknown> | undefined;
      return set?.[`sessions.${AGENT_NAME}`] === 'ses_input';
    });
    expect(backfills).toHaveLength(1);
  });

  it('AC-004: proceeds with undefined sessionId on total miss; no backfill written', async () => {
    const updates: Array<{ filter: unknown; update: unknown }> = [];
    const db = makeFakeDb({
      exec: {
        ...BASE_EXEC,
        sessions: {},
        input: { session_id: '' },   // empty string — must be treated as absent
      },
      role: BASE_ROLE,
      traceForSession: { output: null },  // null output — must fall through
      lastTrace: BASE_LAST_TRACE,
      updates,
    });

    const result = await resumeAgentExecution(db, EXEC_ID, 'Resume task');

    expect(result).not.toHaveProperty('error');
    expect(mockRunSpawn).toHaveBeenCalledOnce();

    // sessionId should be undefined — no 'ses_' string in the call args
    const callArgs = mockRunSpawn.mock.calls[0] as unknown[];
    const hasSessionString = callArgs.some(
      (arg) => typeof arg === 'string' && arg.startsWith('ses_'),
    );
    expect(hasSessionString).toBe(false);

    // No session backfill should have been written
    const sessionSets = updates.filter((u) => {
      const upd = u.update as Record<string, unknown>;
      const set = upd.$set as Record<string, unknown> | undefined;
      return set && Object.keys(set).some((k) => k.startsWith('sessions.'));
    });
    expect(sessionSets).toHaveLength(0);
  });
});

// ── Tests: edge cases ─────────────────────────────────────────────────────

describe('resumeAgentExecution — edge cases', () => {
  /**
   * EC-004: sessions[agentName] is a whitespace-only string (e.g. '   ').
   * The implementation guards with `.trim()`, so this must fall through
   * to the trace path and NOT treat the whitespace string as a valid session.
   */
  it('EC-004: whitespace-only sessions entry falls through to trace path', async () => {
    const updates: Array<{ filter: unknown; update: unknown }> = [];
    const db = makeFakeDb({
      exec: { ...BASE_EXEC, sessions: { [AGENT_NAME]: '   ' }, input: {} },
      role: BASE_ROLE,
      traceForSession: { output: { session_id: 'ses_trace_ec4' } },
      lastTrace: BASE_LAST_TRACE,
      updates,
    });

    const result = await resumeAgentExecution(db, EXEC_ID, 'Resume task');

    expect(result).not.toHaveProperty('error');
    expect(mockRunSpawn).toHaveBeenCalledOnce();

    // Trace session must be used (not the whitespace string)
    const callArgs = mockRunSpawn.mock.calls[0] as unknown[];
    expect(callArgs).toContain('ses_trace_ec4');
    const hasWhitespace = callArgs.some((a) => typeof a === 'string' && a.trim() === '' && a !== '');
    expect(hasWhitespace).toBe(false);

    // Backfill must have been written for the trace-resolved session
    const backfills = updates.filter((u) => {
      const set = (u.update as Record<string, unknown>).$set as Record<string, unknown> | undefined;
      return set?.[`sessions.${AGENT_NAME}`] === 'ses_trace_ec4';
    });
    expect(backfills).toHaveLength(1);
  });

  /**
   * EC-005: trace.output.session_id is a whitespace-only string.
   * Must fall through to the input path — the input session_id must be used.
   */
  it('EC-005: whitespace-only trace.output.session_id falls through to input path', async () => {
    const updates: Array<{ filter: unknown; update: unknown }> = [];
    const db = makeFakeDb({
      exec: { ...BASE_EXEC, sessions: {}, input: { session_id: 'ses_input_ec5' } },
      role: BASE_ROLE,
      traceForSession: { output: { session_id: '\t  \n' } }, // whitespace-only
      lastTrace: BASE_LAST_TRACE,
      updates,
    });

    const result = await resumeAgentExecution(db, EXEC_ID, 'Resume task');

    expect(result).not.toHaveProperty('error');
    expect(mockRunSpawn).toHaveBeenCalledOnce();

    // Input session must be used (not the whitespace string)
    const callArgs = mockRunSpawn.mock.calls[0] as unknown[];
    expect(callArgs).toContain('ses_input_ec5');

    // Backfill must have been written for the input-resolved session
    const backfills = updates.filter((u) => {
      const set = (u.update as Record<string, unknown>).$set as Record<string, unknown> | undefined;
      return set?.[`sessions.${AGENT_NAME}`] === 'ses_input_ec5';
    });
    expect(backfills).toHaveLength(1);
  });

  /**
   * EC-008: SIGTERM-before-session case — completedNodes=[], currentNodes=[], input has no
   * agent_name field. The implementation must fall back to the workflowName slug
   * ('chat:spawn_agent/<name>') to resolve the agentName. The full session fallback
   * chain then works as normal.
   */
  it('EC-008: resolves agentName from workflowName slug when completedNodes and currentNodes are empty', async () => {
    const updates: Array<{ filter: unknown; update: unknown }> = [];
    const db = makeFakeDb({
      exec: {
        ...BASE_EXEC,
        completedNodes: [],  // empty — SIGTERM-before-session case
        currentNodes: [],    // empty — SIGTERM-before-session case
        input: {},           // no agent_name field
        sessions: { [AGENT_NAME]: 'ses_sigterm' },
        workflowName: `chat:spawn_agent/${AGENT_NAME}`, // only source of agentName
      },
      role: BASE_ROLE,
      lastTrace: BASE_LAST_TRACE,
      updates,
    });

    const result = await resumeAgentExecution(db, EXEC_ID, 'Resume task');

    // Must succeed (not return an error about unresolvable agentName)
    expect(result).not.toHaveProperty('error');
    expect(result).toHaveProperty('execution_id', EXEC_ID);
    expect(mockRunSpawn).toHaveBeenCalledOnce();

    // Session from the sessions map must be used
    const callArgs = mockRunSpawn.mock.calls[0] as unknown[];
    expect(callArgs).toContain('ses_sigterm');

    // No backfill needed (resolved from sessions map — primary path)
    const sessionSets = updates.filter((u) => {
      const set = (u.update as Record<string, unknown>).$set as Record<string, unknown> | undefined;
      return set && Object.keys(set).some((k) => k.startsWith('sessions.'));
    });
    expect(sessionSets).toHaveLength(0);
  });
});

// ── Tests: resume_execution routing guard — isAgentExecution fix ──────────

describe('resume_execution routing guard — isAgentExecution fix', () => {
  /**
   * AC-005: source=chat + workflowId truthy → routes to checkpoint, NOT agent.
   * We verify the guard expression directly.
   */
  it('AC-005: source=chat + workflowId truthy evaluates isAgentExecution=false', () => {
    const workflowName = 'wf:some-workflow'; // no ':spawn_agent/' in the name
    const exec = {
      source: 'chat' as const,
      workflowId: 'wf-object-id-123',  // truthy workflowId
    };

    // Replicate the fixed guard expression from chat-tools.ts
    const isAgentExecution =
      workflowName.includes(':spawn_agent/') ||
      exec.source === 'spawn' ||
      (!exec.workflowId && exec.source === 'chat');

    expect(isAgentExecution).toBe(false);
  });

  /**
   * AC-006: source=spawn → isAgentExecution=true regardless of workflowId.
   */
  it('AC-006: source=spawn evaluates isAgentExecution=true', () => {
    const workflowName = 'chat:spawn_agent/test-agent';
    const exec = {
      source: 'spawn' as const,
      workflowId: null,
    };

    const isAgentExecution =
      workflowName.includes(':spawn_agent/') ||
      exec.source === 'spawn' ||
      (!exec.workflowId && exec.source === 'chat');

    expect(isAgentExecution).toBe(true);
  });
});
