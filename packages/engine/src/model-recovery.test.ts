import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  classifyFailure,
  buildRecoveryState,
  defaultMaxRecoveryAttempts,
  sanitizeErrorSummary,
} from './model-recovery.js';

describe('classifyFailure', () => {
  // ── Recoverable Categories ────────────────────────────────────────────

  it('classifies 5xx HTTP status as provider_server_error', () => {
    const err = { status: 503, message: 'Service Unavailable' };
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('provider_server_error');
  });

  it('classifies "internal server error" message as provider_server_error', () => {
    const err = new Error('Internal Server Error from provider');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('provider_server_error');
  });

  it('classifies "bad gateway" message as provider_server_error', () => {
    const err = new Error('Bad Gateway: upstream provider returned 502');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('provider_server_error');
  });

  it('classifies "service unavailable" message as provider_server_error', () => {
    const err = new Error('service unavailable - provider is down');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('provider_server_error');
  });

  it('classifies 429 status as rate_limit_exhausted', () => {
    const err = { status: 429, message: 'Too Many Requests' };
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('rate_limit_exhausted');
  });

  it('classifies "rate limit" message as rate_limit_exhausted', () => {
    const err = new Error('rate limit exceeded for claude-sonnet-4-6');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('rate_limit_exhausted');
  });

  it('classifies "quota exhausted" message as rate_limit_exhausted', () => {
    const err = new Error('API quota exhausted: 10000 tokens per minute');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('rate_limit_exhausted');
  });

  it('classifies "tokens per minute" message as rate_limit_exhausted', () => {
    const err = new Error('200000 tokens per minute limit exceeded');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('rate_limit_exhausted');
  });

  it('classifies "session limit" message as session_limit_exhausted', () => {
    const err = new Error('session limit reached - max 5 concurrent sessions');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('session_limit_exhausted');
  });

  it('classifies "max sessions" message as session_limit_exhausted', () => {
    const err = new Error('max sessions exceeded for this API key');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('session_limit_exhausted');
  });

  it('classifies "insufficient balance" as insufficient_balance', () => {
    const err = new Error('insufficient balance - please add credits');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('insufficient_balance');
  });

  it('classifies "payment required" as insufficient_balance', () => {
    const err = new Error('payment required - account on hold');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('insufficient_balance');
  });

  it('classifies "billing error" as insufficient_balance', () => {
    const err = new Error('billing error - insufficient credits');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('insufficient_balance');
  });

  it('classifies "model not found" as model_unavailable', () => {
    const err = new Error('Model not found: claude-3-opus-20240229');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('model_unavailable');
  });

  it('classifies "model unavailable" as model_unavailable', () => {
    const err = new Error('model unavailable - deprecated');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('model_unavailable');
  });

  it('classifies "unknown model" as model_unavailable', () => {
    const err = new Error('unknown model: gpt-5-ultra');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('model_unavailable');
  });

  it('classifies 401 authentication failure as provider_auth_failed', () => {
    const err = new Error('Failed to authenticate. API Error: 401 Authentication Fails');
    const r = classifyFailure(err, { provider: 'deepseek', model: 'deepseek-v4-flash' });
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('provider_auth_failed');
    expect(r.failedProvider).toBe('deepseek');
    expect(r.failedModel).toBe('deepseek-v4-flash');
  });

  it('classifies invalid API key as provider_auth_failed', () => {
    const err = new Error('Your API key is invalid');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('provider_auth_failed');
  });

  it('classifies invalid model as model_unavailable', () => {
    const err = new Error('invalid model: deepseek-v4-flash');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('model_unavailable');
  });

  it('classifies provider supported-model-name mismatch as model_unavailable', () => {
    const err = new Error('API Error: 400 The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed deepseek-v4-flash-2.');
    const r = classifyFailure(err, { provider: 'deepseek', model: 'deepseek-v4-flash-2' });
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('model_unavailable');
    expect(r.failedProvider).toBe('deepseek');
    expect(r.failedModel).toBe('deepseek-v4-flash-2');
  });

  it('uses diagnostic evidence attached to an Error when the thrown message is generic', () => {
    const err = new Error('_RETRY_EXHAUSTED Agent call failed after 2 attempts. Last error: Claude Code process exited with code 1.');
    (err as Error & { diagnosticEvidence?: string }).diagnosticEvidence =
      '[claude-cli stderr] Failed to authenticate. API Error: 401 Authentication Fails, Your api key: live-secret-token is invalid';
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('provider_auth_failed');
    expect(r.sanitizedSummary).not.toContain('live-secret-token');
  });

  it('classifies ETIMEDOUT code as transient_connectivity', () => {
    const err = new Error('connect ETIMEDOUT 142.250.80.46:443');
    (err as any).code = 'ETIMEDOUT';
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('transient_connectivity');
  });

  it('classifies ECONNREFUSED code as transient_connectivity', () => {
    const err = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8080' };
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('transient_connectivity');
  });

  it('classifies "[transient]" + "network" as transient_connectivity', () => {
    const err = new Error('[transient] network error after retry');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('transient_connectivity');
  });

  it('classifies _RETRY_EXHAUSTED + timeout as transient_connectivity', () => {
    const err = new Error('_RETRY_EXHAUSTED connection timeout after 3 attempts');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('transient_connectivity');
  });

  it('includes ctx provider/model in classification result', () => {
    const err = { status: 429 };
    const r = classifyFailure(err, { provider: 'claude', model: 'claude-sonnet-4-6' });
    expect(r.recoverable).toBe(true);
    expect(r.failedProvider).toBe('claude');
    expect(r.failedModel).toBe('claude-sonnet-4-6');
  });

  // ── Non-recoverable Categories ───────────────────────────────────────

  it('classifies "validation failed" as validation_failure (non-recoverable)', () => {
    const err = new Error('output validation failed: missing required field');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(false);
    expect(r.category).toBe('validation_failure');
  });

  it('classifies "schema mismatch" as validation_failure (non-recoverable)', () => {
    const err = new Error('schema mismatch in response');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(false);
    expect(r.category).toBe('validation_failure');
  });

  it('classifies exact "Execution cancelled" as cancellation (non-recoverable)', () => {
    const err = new Error('Execution cancelled');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(false);
    expect(r.category).toBe('cancellation');
  });

  it('classifies unknown errors as task_failure (non-recoverable)', () => {
    const err = new Error('Something went wrong in the agent logic');
    const r = classifyFailure(err);
    expect(r.recoverable).toBe(false);
    expect(r.category).toBe('task_failure');
  });

  it('classifies string errors as task_failure (non-recoverable)', () => {
    const r = classifyFailure('plain string error');
    expect(r.recoverable).toBe(false);
    expect(r.category).toBe('task_failure');
  });

  it('classifies null/undefined as task_failure (non-recoverable)', () => {
    const r = classifyFailure(null);
    expect(r.recoverable).toBe(false);
    expect(r.category).toBe('task_failure');
  });
});

describe('sanitizeErrorSummary', () => {
  it('redacts sk- secret keys', () => {
    const input = 'API key sk-ant-api03-abc123def456ghij789klmnop failed';
    const result = sanitizeErrorSummary(input);
    expect(result).toContain('sk-<REDACTED>');
    expect(result).not.toContain('sk-ant-api03');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test-token.value';
    const result = sanitizeErrorSummary(input);
    expect(result).toContain('Bearer <REDACTED>');
    expect(result).not.toContain('eyJhbGciOiJI');
  });

  it('redacts env-style KEY=value secrets', () => {
    const input = 'OPENAI_API_KEY=sk-proj-xyz123 in config';
    const result = sanitizeErrorSummary(input);
    expect(result).toContain('OPENAI_API_KEY=<REDACTED>');
    expect(result).not.toContain('sk-proj-xyz123');
  });

  it('trims to 500 chars', () => {
    const input = 'x'.repeat(1000);
    const result = sanitizeErrorSummary(input);
    expect(result.length).toBeLessThanOrEqual(503); // allow for '...'
  });

  it('returns "Unknown error" for empty input', () => {
    expect(sanitizeErrorSummary('')).toBe('Unknown error');
  });

  it('preserves human-readable content', () => {
    const input = 'Rate limit exceeded for model claude-sonnet-4-6';
    const result = sanitizeErrorSummary(input);
    expect(result).toBe(input);
  });
});

describe('defaultMaxRecoveryAttempts', () => {
  afterEach(() => {
    delete process.env.ALLEN_MAX_RECOVERY_ATTEMPTS;
  });

  it('returns 3 by default', () => {
    delete process.env.ALLEN_MAX_RECOVERY_ATTEMPTS;
    expect(defaultMaxRecoveryAttempts()).toBe(3);
  });

  it('reads env override when valid', () => {
    process.env.ALLEN_MAX_RECOVERY_ATTEMPTS = '5';
    expect(defaultMaxRecoveryAttempts()).toBe(5);
  });

  it('ignores invalid env values and returns 3', () => {
    process.env.ALLEN_MAX_RECOVERY_ATTEMPTS = 'not-a-number';
    expect(defaultMaxRecoveryAttempts()).toBe(3);
  });

  it('ignores zero and returns 3', () => {
    process.env.ALLEN_MAX_RECOVERY_ATTEMPTS = '0';
    expect(defaultMaxRecoveryAttempts()).toBe(3);
  });

  it('ignores negative values and returns 3', () => {
    process.env.ALLEN_MAX_RECOVERY_ATTEMPTS = '-1';
    expect(defaultMaxRecoveryAttempts()).toBe(3);
  });
});

describe('buildRecoveryState', () => {
  it('populates basic fields from classification', () => {
    const cls = classifyFailure(new Error('rate limit'), { provider: 'claude', model: 'sonnet' });
    const state = buildRecoveryState({ nodeName: 'my-node', classification: cls, isParallelBranch: false });
    expect(state.nodeName).toBe('my-node');
    expect(state.failedProvider).toBe('claude');
    expect(state.failedModel).toBe('sonnet');
    expect(state.failureCategory).toBe('rate_limit_exhausted');
    expect(state.attempt).toBe(1);
    expect(state.maxAttempts).toBe(3);
    expect(state.isParallelBranch).toBe(false);
    expect(state.siblingBranches).toBeUndefined();
    expect(state.overrideHistory).toEqual([]);
  });

  it('populates siblings/joinPolicy when isParallelBranch=true', () => {
    const cls = classifyFailure(new Error('model not found'), { provider: 'claude', model: 'sonnet' });
    const state = buildRecoveryState({
      nodeName: 'branch-b',
      classification: cls,
      isParallelBranch: true,
      siblingBranches: ['branch-a', 'branch-c'],
      joinPolicy: 'wait-all',
    });
    expect(state.isParallelBranch).toBe(true);
    expect(state.siblingBranches).toEqual(['branch-a', 'branch-c']);
    expect(state.joinPolicy).toBe('wait-all');
  });

  it('uses custom maxAttempts when provided', () => {
    const cls = classifyFailure(new Error('timeout'));
    const state = buildRecoveryState({ nodeName: 'x', classification: cls, isParallelBranch: false, maxAttempts: 5 });
    expect(state.maxAttempts).toBe(5);
  });
});
