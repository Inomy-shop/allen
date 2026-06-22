/**
 * Unit tests for CodexAppServerRuntime.steer() logic and normalizeCodexRuntimeUsage.
 *
 * All logic is reproduced inline as pure functions to avoid importing source
 * files that transitively import @allen/engine (no built dist/ directory).
 *
 * Keep in sync with codex-app-server-runtime.ts.
 */

import { describe, expect, it, vi } from 'vitest';

// ── Inline reproduction of normalizeCodexRuntimeUsage ──

function inlineNormalizeCodexRuntimeUsage(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const turn = (record.last && typeof record.last === 'object' && !Array.isArray(record.last)
    ? record.last
    : record) as Record<string, unknown>;
  const input_tokens = turn.input_tokens ?? turn.inputTokens;
  const output_tokens = turn.output_tokens ?? turn.outputTokens;
  const cached_input_tokens = turn.cached_input_tokens ?? turn.cachedInputTokens;
  return {
    inputNonCachedTokens: typeof input_tokens === 'number' && typeof cached_input_tokens === 'number'
      ? input_tokens - cached_input_tokens
      : typeof input_tokens === 'number'
        ? input_tokens
        : 0,
    inputCachedTokens: typeof cached_input_tokens === 'number' ? cached_input_tokens : 0,
    outputTokens: typeof output_tokens === 'number' ? output_tokens : 0,
  };
}

describe('normalizeCodexRuntimeUsage', () => {
  it('uses app-server last turn usage instead of cumulative totals', () => {
    expect(inlineNormalizeCodexRuntimeUsage({
      total: {
        input_tokens: 10_000,
        cached_input_tokens: 4_000,
        output_tokens: 1_000,
      },
      last: {
        input_tokens: 1_500,
        cached_input_tokens: 500,
        output_tokens: 200,
      },
    })).toEqual({
      inputCachedTokens: 500,
      inputNonCachedTokens: 1_000,
      outputTokens: 200,
    });
  });

  it('accepts camelCase app-server usage fields', () => {
    expect(inlineNormalizeCodexRuntimeUsage({
      last: {
        inputTokens: 2_000,
        cachedInputTokens: 250,
        outputTokens: 300,
      },
    })).toEqual({
      inputCachedTokens: 250,
      inputNonCachedTokens: 1_750,
      outputTokens: 300,
    });
  });
});

// ── Inline reproduction of steer() logic ──

interface CodexSteerState {
  currentTurn?: unknown;
  activeTurnId?: string;
  closed: boolean;
  request?: (method: string, params: unknown) => Promise<unknown>;
}

function steerCodexState(
  state: CodexSteerState,
  text: string,
  makeRequest: (method: string, params: unknown) => void,
): boolean {
  if (!state.currentTurn) return false;
  if (!state.activeTurnId) return false;
  if (state.closed) return false;

  makeRequest('turn/steer', {
    threadId: 'thread-xyz',
    expectedTurnId: state.activeTurnId,
    input: [{ type: 'text', text, text_elements: [] }],
  });

  return true;
}

// ── Tests ──

describe('CodexAppServerRuntime.steer logic', () => {
  it('returns false when no active turn', () => {
    const state: CodexSteerState = { closed: false };
    const request = vi.fn();
    expect(steerCodexState(state, 'hello', request)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('returns false when active turn exists but no activeTurnId', () => {
    const state: CodexSteerState = { currentTurn: {}, closed: false };
    const request = vi.fn();
    expect(steerCodexState(state, 'hello', request)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('returns true and issues a turn/steer JSON-RPC call when active turn and turnId exist', () => {
    const state: CodexSteerState = {
      currentTurn: { input: { db: {}, chatSessionId: 'test' } },
      activeTurnId: 'turn-abc123',
      closed: false,
    };
    const request = vi.fn();

    const result = steerCodexState(state, 'steer this', request);

    expect(result).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thread-xyz',
      expectedTurnId: 'turn-abc123',
      input: [{ type: 'text', text: 'steer this', text_elements: [] }],
    });
  });

  it('records the correct expectedTurnId', () => {
    const state: CodexSteerState = {
      currentTurn: {},
      activeTurnId: 'turn-def456',
      closed: false,
    };
    const request = vi.fn();

    steerCodexState(state, 'some text', request);

    expect(request).toHaveBeenCalledWith('turn/steer', expect.objectContaining({
      expectedTurnId: 'turn-def456',
    }));
  });

  it('after turn/completed clears activeTurnId, steer returns false', () => {
    const state: CodexSteerState = {
      currentTurn: undefined,
      activeTurnId: undefined,
      closed: false,
    };
    const request = vi.fn();

    expect(steerCodexState(state, 'hello', request)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('returns false when runtime is closed', () => {
    const state: CodexSteerState = {
      currentTurn: {},
      activeTurnId: 'turn-abc',
      closed: true,
    };
    const request = vi.fn();

    expect(steerCodexState(state, 'hello', request)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
