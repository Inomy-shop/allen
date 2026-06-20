import { describe, expect, it } from 'vitest';
import {
  buildAgentRetryExhaustedError,
  MAIN_AGENT_CALL_MAX_ATTEMPTS,
  redactAgentRetryDiagnostic,
} from './node-executor.js';
import { classifyFailure } from './model-recovery.js';

describe('agent call retry diagnostics', () => {
  it('uses one retry by default: initial attempt plus one retry', () => {
    expect(MAIN_AGENT_CALL_MAX_ATTEMPTS).toBe(2);
  });

  it('builds a retry-exhausted error with latest diagnostic log evidence', () => {
    const err = buildAgentRetryExhaustedError({
      attempts: MAIN_AGENT_CALL_MAX_ATTEMPTS,
      lastError: new Error('Claude Code process exited with code 1'),
      latestDiagnostics: [
        '[claude-cli stderr] Failed to authenticate. API Error: 401 Authentication Fails, Your api key: live-secret-token is invalid',
      ],
    });

    expect(err.message).toContain('_RETRY_EXHAUSTED');
    expect(err.message).toContain('after 2 attempts');
    expect(err.message).toContain('Latest diagnostic logs');
    expect(err.message).not.toContain('live-secret-token');
    expect((err as Error & { diagnosticEvidence?: string }).diagnosticEvidence).toContain('401 Authentication Fails');
  });

  it('lets model recovery classify auth failures from diagnostic logs when the thrown error is generic', () => {
    const err = buildAgentRetryExhaustedError({
      attempts: MAIN_AGENT_CALL_MAX_ATTEMPTS,
      lastError: new Error('Claude Code process exited with code 1'),
      latestDiagnostics: [
        '[claude-cli stderr] Failed to authenticate. API Error: 401 Authentication Fails, Your api key: live-secret-token is invalid',
      ],
    });

    const result = classifyFailure(err, { provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(result.recoverable).toBe(true);
    expect(result.category).toBe('provider_auth_failed');
    expect(result.failedProvider).toBe('deepseek');
    expect(result.failedModel).toBe('deepseek-v4-flash');
    expect(result.sanitizedSummary).not.toContain('live-secret-token');
  });

  it('does not make a generic code-1 retry exhaustion recoverable without useful diagnostics', () => {
    const err = buildAgentRetryExhaustedError({
      attempts: MAIN_AGENT_CALL_MAX_ATTEMPTS,
      lastError: new Error('Claude Code process exited with code 1'),
      latestDiagnostics: ['[agent-call error] Claude Code process exited with code 1'],
    });

    const result = classifyFailure(err);
    expect(result.recoverable).toBe(false);
    expect(result.category).toBe('task_failure');
  });

  it('redacts generic API key labels in retry diagnostics', () => {
    const redacted = redactAgentRetryDiagnostic('Your api key: live-secret-token is invalid');
    expect(redacted).toContain('api key: <REDACTED>');
    expect(redacted).not.toContain('live-secret-token');
  });
});
