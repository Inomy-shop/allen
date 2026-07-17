/**
 * Unit tests for ClaudePersistentRuntime.steer() logic.
 *
 * We reproduce the steer() logic inline as a pure function instead of importing
 * ClaudePersistentRuntime, because that class transitively imports @allen/engine
 * which has no built dist/ directory, causing "Cannot find module" failures.
 *
 * Keep in sync with claude-persistent-runtime.ts.
 */

import { describe, expect, it, vi } from 'vitest';

// ── Inline reproduction of steer() logic ──

interface ClaudeSteerState {
  currentTurn?: unknown;
  steerPending?: boolean;
  proc?: {
    stdin: {
      write: (chunk: string) => void;
      end?: () => void;
    };
  };
}

// `claude -p` will not read a new user message mid-turn, so steering must first
// interrupt the running turn (control_request) then send the new user message.
function steerClaudeState(state: ClaudeSteerState, text: string): boolean {
  if (!state.currentTurn) return false;
  if (!state.proc?.stdin) return false;
  try {
    state.steerPending = true;
    state.proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request_id: 'test-id',
      request: { subtype: 'interrupt' },
    }) + '\n');
    state.proc.stdin.write(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    }) + '\n');
    return true;
  } catch {
    state.steerPending = false;
    return false;
  }
}

// Mirrors the terminal result branch in handleClaudeEvent().
function terminalResultAction(subtype: string | undefined, steerPending: boolean): 'swallow-steer-interrupt' | 'reject' | 'resolve' {
  if (steerPending && subtype === 'error_during_execution') return 'swallow-steer-interrupt';
  if (subtype && subtype !== 'success') return 'reject';
  return 'resolve';
}

// ── Tests ──

describe('ClaudePersistentRuntime.steer logic', () => {
  it('returns false when no active turn exists', () => {
    const state: ClaudeSteerState = {};
    expect(steerClaudeState(state, 'hello')).toBe(false);
  });

  it('interrupts the active turn then writes the steered user message', () => {
    const write = vi.fn();
    const state: ClaudeSteerState = {
      currentTurn: { input: { db: {}, chatSessionId: 'test' } },
      proc: { stdin: { write } },
    };

    const result = steerClaudeState(state, 'test message');

    expect(result).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    const interrupt = write.mock.calls[0][0] as string;
    expect(interrupt).toContain('"type":"control_request"');
    expect(interrupt).toContain('"subtype":"interrupt"');
    const userMsg = write.mock.calls[1][0] as string;
    expect(userMsg).toContain('"type":"user"');
    expect(userMsg).toContain('"text":"test message"');
    expect(userMsg.endsWith('\n')).toBe(true);
    expect(state.steerPending).toBe(true);
  });

  it('does NOT call stdin.end() on successful steer', () => {
    const end = vi.fn();
    const write = vi.fn();
    const state: ClaudeSteerState = {
      currentTurn: { input: { db: {}, chatSessionId: 'test' } },
      proc: { stdin: { write, end } },
    };

    steerClaudeState(state, 'hello');

    expect(end).not.toHaveBeenCalled();
  });

  it('does NOT reassign currentTurn (no new ActiveTurn created)', () => {
    const write = vi.fn();
    const originalTurn = { input: { db: {}, chatSessionId: 'test' } };
    const state: ClaudeSteerState = {
      currentTurn: originalTurn,
      proc: { stdin: { write } },
    };

    steerClaudeState(state, 'hello');

    expect(state.currentTurn).toBe(originalTurn);
  });

  it('returns false when proc.stdin is null while currentTurn exists', () => {
    const state: ClaudeSteerState = {
      currentTurn: { input: { db: {}, chatSessionId: 'test' } },
      // proc is undefined — no stdin to write to
    };

    const result = steerClaudeState(state, 'hello');
    expect(result).toBe(false);
  });

  it('catches write errors and returns false', () => {
    const brokenWrite = vi.fn(() => { throw new Error('stdin closed'); });
    const state: ClaudeSteerState = {
      currentTurn: { input: { db: {}, chatSessionId: 'test' } },
      proc: { stdin: { write: brokenWrite } },
    };

    const result = steerClaudeState(state, 'hello');
    expect(result).toBe(false);
  });
});

describe('ClaudePersistentRuntime terminal result handling', () => {
  it('rejects non-steer error results instead of resolving an empty assistant response', () => {
    expect(terminalResultAction('error_during_execution', false)).toBe('reject');
  });

  it('still swallows the expected steer interrupt result', () => {
    expect(terminalResultAction('error_during_execution', true)).toBe('swallow-steer-interrupt');
  });

  it('resolves successful results', () => {
    expect(terminalResultAction('success', false)).toBe('resolve');
  });
});
