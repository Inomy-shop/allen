/**
 * Focused regression test for OrchestratorDispatchAdapter — ENG-1760 Blocker B.
 *
 * Verifies that AllenSpawnOrchestratorDispatchAdapter sends the registered agent
 * name 'context-judge-orchestrator' (not the legacy 'context-judge-orchestrator-agent')
 * in the spawn request body.
 *
 * The distinction matters: Allen's agent registry uses 'context-judge-orchestrator'
 * as the canonical name. Sending the wrong name results in a 404 from the spawn
 * endpoint and the orchestrator never runs.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AllenSpawnOrchestratorDispatchAdapter,
  NullOrchestratorDispatchAdapter,
} from '../../../services/context/judge/orchestrator-dispatch-adapter.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type MockFetchResult = { executionId?: string };

function makeMockFetch(result: MockFetchResult = { executionId: 'exec-test-001' }) {
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};

  const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
    return Promise.resolve({
      json: () => Promise.resolve(result),
    });
  });

  return { mockFetch, getUrl: () => capturedUrl, getBody: () => capturedBody };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AllenSpawnOrchestratorDispatchAdapter — agent name regression (ENG-1760 Blocker B)', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('sends agentName: "context-judge-orchestrator" (registered name)', async () => {
    const { mockFetch, getBody } = makeMockFetch();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const adapter = new AllenSpawnOrchestratorDispatchAdapter('http://test-spawn/spawn');
    await adapter.dispatch({
      runId: 'run-reg-001',
      triggeredBy: 'test',
      global: true,
    });

    const body = getBody();
    expect(body.agentName).toBe('context-judge-orchestrator');
  });

  it('does NOT send agentName: "context-judge-orchestrator-agent" (legacy bug regression)', async () => {
    const { mockFetch, getBody } = makeMockFetch();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const adapter = new AllenSpawnOrchestratorDispatchAdapter('http://test-spawn/spawn');
    await adapter.dispatch({
      runId: 'run-reg-002',
      triggeredBy: 'test',
      global: false,
      repoId: 'repo-001',
    });

    const body = getBody();
    expect(body.agentName).not.toBe('context-judge-orchestrator-agent');
  });

  it('includes runId in the prompt string', async () => {
    const { mockFetch, getBody } = makeMockFetch();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const adapter = new AllenSpawnOrchestratorDispatchAdapter('http://test-spawn/spawn');
    await adapter.dispatch({
      runId: 'run-prompt-check',
      triggeredBy: 'scheduler',
      global: true,
    });

    const body = getBody();
    expect(typeof body.prompt).toBe('string');
    expect(body.prompt as string).toContain('runId=run-prompt-check');
    expect(body.prompt as string).toContain('scheduler');
  });

  it('calls the spawn URL with POST method', async () => {
    const capturedInits: RequestInit[] = [];
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedInits.push(init);
      return Promise.resolve({ json: () => Promise.resolve({ executionId: 'exec-method-check' }) });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const adapter = new AllenSpawnOrchestratorDispatchAdapter('http://test-spawn/spawn');
    await adapter.dispatch({
      runId: 'run-method-check',
      triggeredBy: 'test',
      global: true,
    });

    expect(capturedInits).toHaveLength(1);
    expect(capturedInits[0].method).toBe('POST');
  });

  it('returns queued=true and propagates executionId from spawn response', async () => {
    const { mockFetch } = makeMockFetch({ executionId: 'exec-returned-001' });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const adapter = new AllenSpawnOrchestratorDispatchAdapter('http://test-spawn/spawn');
    const result = await adapter.dispatch({
      runId: 'run-queue-check',
      triggeredBy: 'test',
      global: true,
    });

    expect(result.queued).toBe(true);
    expect(result.executionId).toBe('exec-returned-001');
  });

  it('includes repo-scoped description in prompt for repo runs', async () => {
    const { mockFetch, getBody } = makeMockFetch();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const adapter = new AllenSpawnOrchestratorDispatchAdapter('http://test-spawn/spawn');
    await adapter.dispatch({
      runId: 'run-repo-scope',
      triggeredBy: 'api',
      global: false,
      repoId: 'my-repo-123',
    });

    const prompt = getBody().prompt as string;
    expect(prompt).toContain('my-repo-123');
  });
});

describe('NullOrchestratorDispatchAdapter', () => {
  it('always returns queued=false without making any network calls', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const adapter = new NullOrchestratorDispatchAdapter();
    const result = await adapter.dispatch({
      runId: 'run-null',
      triggeredBy: 'test',
      global: true,
    });

    expect(result.queued).toBe(false);
    expect(result.executionId).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();

    globalThis.fetch = origFetch;
  });
});

const origFetch = globalThis.fetch;
