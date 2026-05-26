import { describe, expect, it } from 'vitest';
import {
  agentContextAttemptCount,
  agentHasContextEvidence,
  agentTraceContextCount,
  agentTraceHasContext,
  findAgentContextAttempt,
} from '../ExecutionDetailPage';

describe('agent execution context affordance', () => {
  it('shows context for hydrated spawned-agent attempts and counts injected refs first', () => {
    const trace = {
      contextAttemptId: 'packet-1',
      contextLifecycleAttempt: {
        refs: [
          { refId: 'selected', lifecycleStatus: 'selected' },
          { refId: 'injected', lifecycleStatus: 'injected', isInjected: true },
        ],
        contextInjection: {
          injectedRefs: [{ refId: 'injected' }],
        },
      },
    };

    expect(agentTraceHasContext(trace)).toBe(true);
    expect(agentTraceContextCount(trace)).toBe(1);
  });

  it('still shows context when only a contextAttemptId was saved', () => {
    const trace = { contextAttemptId: 'packet-legacy' };

    expect(agentTraceHasContext(trace)).toBe(true);
    expect(agentTraceContextCount(trace)).toBe(1);
  });

  it('does not show context for traces without packet evidence', () => {
    expect(agentTraceHasContext({ status: 'completed' })).toBe(false);
    expect(agentTraceContextCount({ status: 'completed' })).toBeNull();
  });

  it('finds context attempts from the execution context usage report', () => {
    const report = {
      nodeAttempts: [
        { contextAttemptId: 'a1', nodeName: 'backend-developer', attempt: 1, refs: [{ refId: 'r1', lifecycleStatus: 'selected' }] },
        { contextAttemptId: 'a2', nodeName: 'qa', attempt: 1 },
      ],
    };
    const attempt = findAgentContextAttempt(report, 'backend-developer', 1);

    expect(attempt?.contextAttemptId).toBe('a1');
    expect(agentContextAttemptCount(attempt)).toBe(1);
    expect(agentHasContextEvidence(null, attempt, false)).toBe(true);
  });

  it('can expose the context button while a repo-backed agent is still waiting for trace hydration', () => {
    expect(agentHasContextEvidence({ status: 'running' }, null, true)).toBe(true);
  });
});
