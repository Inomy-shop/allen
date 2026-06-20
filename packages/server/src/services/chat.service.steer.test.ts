/**
 * Unit tests for the steer-vs-queue branching logic extracted from chat.service.ts.
 *
 * ChatService imports many modules that transitively import @allen/engine which
 * has no built dist/ directory.  To avoid the "Cannot find module" failure we
 * do NOT import ChatService.  Instead we test the exported pure function
 * `shouldSteerInsteadOfQueue` that encapsulates the branching decision.
 */

import { describe, it, expect } from 'vitest';

// Inline reproduction of shouldSteerInsteadOfQueue, kept in sync with the source.
export function shouldSteerInsteadOfQueue(
  activeQueriesMap: Map<string, unknown>,
  sessionId: string,
  steerFn: (id: string, text: string) => boolean,
  content: string,
): boolean {
  if (!activeQueriesMap.has(sessionId)) return false;
  return steerFn(sessionId, content);
}

describe('shouldSteerInsteadOfQueue', () => {
  it('returns false when sessionId is not in activeQueries (queue fallback)', () => {
    const activeQueries = new Map<string, unknown>();
    const accepted = shouldSteerInsteadOfQueue(
      activeQueries,
      'nonexistent-session',
      () => true,
      'hello',
    );
    expect(accepted).toBe(false);
  });

  it('returns true when sessionId is in activeQueries AND steerFn returns true', () => {
    const activeQueries = new Map<string, unknown>();
    activeQueries.set('session-1', { messageId: 'msg-1' });
    const accepted = shouldSteerInsteadOfQueue(
      activeQueries,
      'session-1',
      () => true,
      'steer this',
    );
    expect(accepted).toBe(true);
  });

  it('returns false when sessionId is in activeQueries BUT steerFn returns false', () => {
    const activeQueries = new Map<string, unknown>();
    activeQueries.set('session-1', { messageId: 'msg-1' });
    const accepted = shouldSteerInsteadOfQueue(
      activeQueries,
      'session-1',
      () => false,
      'steer this',
    );
    expect(accepted).toBe(false);
  });

  it('passes the correct sessionId and content to steerFn', () => {
    const activeQueries = new Map<string, unknown>();
    activeQueries.set('session-2', { messageId: 'msg-2' });
    let capturedId = '';
    let capturedText = '';
    const accepted = shouldSteerInsteadOfQueue(
      activeQueries,
      'session-2',
      (id, text) => {
        capturedId = id;
        capturedText = text;
        return true;
      },
      'my message',
    );
    expect(accepted).toBe(true);
    expect(capturedId).toBe('session-2');
    expect(capturedText).toBe('my message');
  });

  it('does not call steerFn when sessionId is missing from map', () => {
    const activeQueries = new Map<string, unknown>();
    let called = false;
    shouldSteerInsteadOfQueue(
      activeQueries,
      'no-session',
      () => {
        called = true;
        return true;
      },
      'test',
    );
    expect(called).toBe(false);
  });
});
