/**
 * Unit tests for DesignRoutingService.dispatch() — REQ-031 / REQ-013 meta tagging
 * and the 401-regression fix (BV-002).
 *
 * BV-001: dispatchWorkflow() stamps meta.sourceSurface='design_tab' and
 *         meta.designSessionId on the execution record.
 * BV-002: dispatchAgent() sends an Authorization: Bearer header so the
 *         /api/chat/spawn-agent endpoint does not return 401, and uses the
 *         correct snake_case field name `agent_name` in the request body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chat-llm to prevent actual LLM spawning in tests.
vi.mock('./chat-llm.js', () => ({
  runChatLLM: vi.fn().mockImplementation(async (_db: unknown, options: any) => {
    options.onText('Mocked LLM design assistant response.');
    return { text: 'Mocked LLM design assistant response.', costUsd: 0, durationMs: 100, model: 'mock', provider: 'mock', trace: [] };
  }),
}));

// Mock chat-providers to avoid real provider selection.
vi.mock('./chat-providers.js', () => ({
  getDefaultChatProvider: vi.fn().mockReturnValue('codex'),
}));

// Mock the dynamic import of ExecutionService so we don't need the real one
// (which imports @allen/engine and mongodb as values).
vi.mock('./execution.service.js', () => ({
  ExecutionService: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue({ id: 'exec-abc-123' }),
  })),
}));

// Mock buildInternalApiHeaders so tests don't need real JWT signing.
vi.mock('./cron.service.js', () => ({
  buildInternalApiHeaders: vi.fn().mockReturnValue({
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-internal-token',
  }),
}));

import { buildInternalApiHeaders } from './cron.service.js';
import { DesignRoutingService } from './design-routing.service.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const workflowDecision = {
  mode: 'workflow' as const,
  resolvedBy: 'auto' as const,
  workflowName: 'source-prd-to-ui-designs-variations',
  reason: 'New design request',
  outputMode: 'spec_only' as const,
};

const dispatchOptions = {
  prompt: 'Design a new nav bar',
  designRepoPath: 'packages/ui',
  designSessionId: 'session-001',
  messageId: 'msg-001',
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DesignRoutingService.dispatch — REQ-031 sourceSurface tagging', () => {
  let updateOneSpy: ReturnType<typeof vi.fn>;
  let findOneSpy: ReturnType<typeof vi.fn>;
  let service: DesignRoutingService;

  beforeEach(() => {
    updateOneSpy = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    findOneSpy = vi.fn().mockResolvedValue({ _id: 'wf-id-001', name: 'source-prd-to-ui-designs-variations' });

    const mockDb = {
      collection: (name: string) => {
        if (name === 'workflows') return { findOne: findOneSpy };
        if (name === 'executions') return { updateOne: updateOneSpy };
        return {};
      },
    } as any;

    service = new DesignRoutingService(mockDb);
  });

  // Provide both required paths so validation passes and dispatch proceeds.
  const fullDispatchOptions = { ...dispatchOptions, sourceRepoPath: '/repos/source-app' };

  it('stamps meta.sourceSurface=design_tab on the execution record (REQ-031)', async () => {
    await service.dispatch(workflowDecision, fullDispatchOptions);

    expect(updateOneSpy).toHaveBeenCalledWith(
      { id: 'exec-abc-123' },
      expect.objectContaining({
        $set: expect.objectContaining({ 'meta.sourceSurface': 'design_tab' }),
      }),
    );
  });

  it('stamps meta.designSessionId on the execution record (REQ-013)', async () => {
    await service.dispatch(workflowDecision, fullDispatchOptions);

    expect(updateOneSpy).toHaveBeenCalledWith(
      { id: 'exec-abc-123' },
      expect.objectContaining({
        $set: expect.objectContaining({ 'meta.designSessionId': 'session-001' }),
      }),
    );
  });

  it('uses the executionId returned by ExecutionService.start() as the filter key', async () => {
    await service.dispatch(workflowDecision, fullDispatchOptions);

    const [filter] = updateOneSpy.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(filter.id).toBe('exec-abc-123');
  });

  it('returns the executionId from the start() result', async () => {
    const result = await service.dispatch(workflowDecision, fullDispatchOptions);
    expect(result.executionId).toBe('exec-abc-123');
  });
});

// ── BV-002: dispatchAgent 401-regression tests ─────────────────────────────

const agentDecision = {
  mode: 'agent' as const,
  resolvedBy: 'auto' as const,
  agentName: 'frontend-developer',
  reason: 'Design chat',
  outputMode: 'spec_only' as const,
};

describe('DesignRoutingService.dispatch (agent) — BV-002 auth header regression', () => {
  let updateOneSpy: ReturnType<typeof vi.fn>;
  let service: DesignRoutingService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateOneSpy = vi.fn().mockResolvedValue({ modifiedCount: 1 });

    const mockDb = {
      collection: (name: string) => {
        if (name === 'executions') return { updateOne: updateOneSpy };
        return {};
      },
    } as any;

    service = new DesignRoutingService(mockDb);

    // Intercept globalThis.fetch
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ executionId: 'agent-run-xyz' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('calls buildInternalApiHeaders() to obtain auth credentials (BV-002)', async () => {
    await service.dispatch(agentDecision, dispatchOptions);
    expect(buildInternalApiHeaders).toHaveBeenCalled();
  });

  it('includes Authorization header in the spawn-agent request (BV-002)', async () => {
    await service.dispatch(agentDecision, dispatchOptions);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Bearer /);
  });

  it('sends agent_name (snake_case) not agentName in the request body (BV-002)', async () => {
    await service.dispatch(agentDecision, dispatchOptions);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.agent_name).toBe('frontend-developer');
    expect(body).not.toHaveProperty('agentName');
  });

  it('throws DESIGN_DISPATCH_FAILED with message containing status when server returns 401', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: 'unauthorized' })),
    });

    await expect(service.dispatch(agentDecision, dispatchOptions)).rejects.toMatchObject({
      message: expect.stringContaining('401'),
      code: 'DESIGN_DISPATCH_FAILED',
    });
  });

  it('stamps meta.sourceSurface=design_tab on the agent execution record', async () => {
    await service.dispatch(agentDecision, dispatchOptions);

    expect(updateOneSpy).toHaveBeenCalledWith(
      { id: 'agent-run-xyz' },
      expect.objectContaining({
        $set: expect.objectContaining({ 'meta.sourceSurface': 'design_tab' }),
      }),
    );
  });

  it('returns agentRunId from the spawn response', async () => {
    const result = await service.dispatch(agentDecision, dispatchOptions);
    expect(result.agentRunId).toBe('agent-run-xyz');
  });

  it('parses execution_id (snake_case) from spawn response (BV-003)', async () => {
    // The spawn-agent endpoint returns execution_id (snake_case), not executionId
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ execution_id: 'agent-run-snake-case' }),
    });

    const result = await service.dispatch(agentDecision, dispatchOptions);
    expect(result.agentRunId).toBe('agent-run-snake-case');
  });
});

// ── New: DesignRouter integration tests ───────────────────────────────────

describe('DesignRoutingService.resolveRoute with prompt (new router)', () => {
  it('resolves hello to direct mode', async () => {
    const mockDb = { collection: () => ({}) } as any;
    const svc = new DesignRoutingService(mockDb);
    const session = { outputMode: 'spec_only', hasExistingOutputs: false } as any;
    const decision = await svc.resolveRoute(session, undefined, 'hello');
    expect(decision.mode).toBe('direct');
  });

  it('resolves "implement a button" without existing context to workflow', async () => {
    const mockDb = { collection: () => ({}) } as any;
    const svc = new DesignRoutingService(mockDb);
    const session = { outputMode: 'spec_only', hasExistingOutputs: false } as any;
    const decision = await svc.resolveRoute(session, undefined, 'implement a button component');
    expect(decision.mode).toBe('workflow');
    expect(decision.workflowName).toBe('source-prd-to-ui-designs-variations');
  });

  it('resolves "generate multiple design options" to workflow', async () => {
    const mockDb = { collection: () => ({}) } as any;
    const svc = new DesignRoutingService(mockDb);
    const session = { outputMode: 'spec_only', hasExistingOutputs: false } as any;
    const decision = await svc.resolveRoute(session, undefined, 'generate multiple design options for my landing page');
    expect(decision.mode).toBe('workflow');
    expect(decision.workflowName).toBe('source-prd-to-ui-designs-variations');
  });

  it('full_workflow override routes substantive prompt to workflow', async () => {
    const mockDb = { collection: () => ({}) } as any;
    const svc = new DesignRoutingService(mockDb);
    const session = { outputMode: 'spec_only' } as any;
    // Conversational prompts (e.g. 'hello') bypass the override and go direct.
    // Only substantive design prompts should honour the override.
    const decision = await svc.resolveRoute(session, 'full_workflow', 'build a dashboard UI');
    expect(decision.mode).toBe('workflow');
  });
});

// ── New: dispatch direct mode ─────────────────────────────────────────────

describe('DesignRoutingService.dispatch (direct mode)', () => {
  it('returns directResponse using LLM (not canned response)', async () => {
    const mockDb = { collection: () => ({}) } as any;
    const svc = new DesignRoutingService(mockDb);
    const directDecision = {
      mode: 'direct' as const,
      resolvedBy: 'auto' as const,
      reason: 'Design question',
      outputMode: 'spec_only' as const,
    };

    const result = await svc.dispatch(directDecision, {
      prompt: 'What is a design system?',
      designSessionId: 'sess-direct',
      messageId: 'msg-direct',
    });

    expect(result.directResponse).toBeDefined();
    expect(typeof result.directResponse).toBe('string');
    expect(result.directResponse!.length).toBeGreaterThan(5);
  });

  it('returns instant fallback response for empty/short prompt without LLM call', async () => {
    const mockDb = { collection: () => ({}) } as any;
    const svc = new DesignRoutingService(mockDb);
    const directDecision = {
      mode: 'direct' as const,
      resolvedBy: 'auto' as const,
      reason: 'Empty prompt',
      outputMode: 'spec_only' as const,
    };

    const result = await svc.dispatch(directDecision, {
      prompt: 'hi',
      designSessionId: 'sess-short',
      messageId: 'msg-short',
    });

    expect(result.directResponse).toBeDefined();
    expect(typeof result.directResponse).toBe('string');
  });
});

// ── New: workflow input validation — clarification instead of raw error ────

describe('DesignRoutingService.dispatch — missing workflow inputs', () => {
  let findOneSpy: ReturnType<typeof vi.fn>;
  let updateOneSpy: ReturnType<typeof vi.fn>;
  let service: DesignRoutingService;

  beforeEach(() => {
    findOneSpy = vi.fn().mockResolvedValue({ _id: 'wf-id-001', name: 'source-prd-to-ui-designs-variations' });
    updateOneSpy = vi.fn().mockResolvedValue({ modifiedCount: 1 });

    const mockDb = {
      collection: (name: string) => {
        if (name === 'workflows') return { findOne: findOneSpy };
        if (name === 'executions') return { updateOne: updateOneSpy };
        return {};
      },
    } as any;

    service = new DesignRoutingService(mockDb);
  });

  it('throws DESIGN_MISSING_WORKFLOW_INPUTS when source_repo_path is missing', async () => {
    await expect(
      service.dispatch(workflowDecision, {
        ...dispatchOptions,
        designRepoPath: 'packages/ui',
        // sourceRepoPath is intentionally omitted
      }),
    ).rejects.toMatchObject({
      code: 'DESIGN_MISSING_WORKFLOW_INPUTS',
      missingInputs: expect.arrayContaining(['source_repo_path']),
    });
  });

  it('clarification message contains user-friendly guidance (not raw schema error)', async () => {
    let caughtErr: any;
    try {
      await service.dispatch(workflowDecision, {
        ...dispatchOptions,
        designRepoPath: 'packages/ui',
        // sourceRepoPath omitted
      });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeDefined();
    expect(caughtErr.code).toBe('DESIGN_MISSING_WORKFLOW_INPUTS');
    // Should NOT contain raw schema error text
    expect(caughtErr.clarification).not.toMatch(/Required inputs:/);
    expect(caughtErr.clarification).not.toMatch(/Call get_workflow/);
    // Should contain user-friendly guidance
    expect(caughtErr.clarification).toMatch(/source repo/i);
  });

  it('throws DESIGN_MISSING_WORKFLOW_INPUTS when both source_repo_path and repo_path are missing', async () => {
    await expect(
      service.dispatch(workflowDecision, {
        // Explicitly omit designRepoPath and sourceRepoPath so both inputs are absent
        prompt: dispatchOptions.prompt,
        designSessionId: dispatchOptions.designSessionId,
        messageId: dispatchOptions.messageId,
      }),
    ).rejects.toMatchObject({
      code: 'DESIGN_MISSING_WORKFLOW_INPUTS',
      missingInputs: expect.arrayContaining(['source_repo_path', 'repo_path']),
    });
  });

  it('does NOT throw when both source_repo_path and repo_path are provided', async () => {
    // ExecutionService.start is mocked to return exec-abc-123 in this describe scope
    // (via the vi.mock at top of file)
    const result = await service.dispatch(workflowDecision, {
      ...dispatchOptions,
      designRepoPath: 'packages/ui',
      sourceRepoPath: '/repos/my-app',
    });
    expect(result.executionId).toBe('exec-abc-123');
  });
});
