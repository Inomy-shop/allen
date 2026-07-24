import { describe, expect, it } from 'vitest';
import {
  humanizeWorkspaceName,
  sessionActivityState,
  workspaceActivityState,
} from './activity-status';

describe('sessionActivityState', () => {
  const session = { _id: 'chat-1', status: 'active' };

  it('does not treat every persisted active session as running', () => {
    expect(sessionActivityState(session)).toBe('completed');
  });

  it('uses the latest linked execution as the shared activity source', () => {
    expect(sessionActivityState(session, [
      { status: 'completed', startedAt: '2026-07-24T10:00:00Z', meta: { chatSessionId: 'chat-1' } },
      { status: 'waiting_for_input', startedAt: '2026-07-24T11:00:00Z', meta: { chatSessionId: 'chat-1' } },
    ])).toBe('needs-you');
  });

  it('keeps streaming sessions running even without an execution', () => {
    const now = new Date('2026-07-24T12:00:00Z').getTime();
    expect(sessionActivityState({
      ...session,
      streaming: true,
      updatedAt: '2026-07-24T11:55:00Z',
    }, [], now)).toBe('running');
  });

  it('expires stale streaming flags and stale running executions', () => {
    const now = new Date('2026-07-24T12:00:00Z').getTime();
    expect(sessionActivityState({
      ...session,
      streaming: true,
      updatedAt: '2026-07-24T10:00:00Z',
    }, [{
      status: 'running',
      updatedAt: '2026-07-24T10:30:00Z',
      meta: { chatSessionId: 'chat-1' },
    }], now)).toBe('completed');
  });
});

describe('workspaceActivityState', () => {
  const now = new Date('2026-07-24T12:00:00Z').getTime();

  it('marks stale active workspaces idle', () => {
    expect(workspaceActivityState({
      status: 'active',
      updatedAt: '2026-07-24T10:00:00Z',
    }, now)).toBe('idle');
  });

  it('keeps recently updated running workspaces active', () => {
    expect(workspaceActivityState({
      status: 'running',
      updatedAt: '2026-07-24T11:45:00Z',
    }, now)).toBe('active');
  });
});

describe('humanizeWorkspaceName', () => {
  it('turns branch slugs into readable labels', () => {
    expect(humanizeWorkspaceName('ui/redesign-implementation')).toBe('Redesign implementation');
  });

  it('removes generated suffixes from hyphen-style workspace names', () => {
    expect(humanizeWorkspaceName('fix-human-approval-latest-decision-precedenc-ti2uz4'))
      .toBe('Fix human approval latest decision precedenc');
  });

  it('keeps meaningful trailing words that are not generated identifiers', () => {
    expect(humanizeWorkspaceName('feature-payment-retry'))
      .toBe('Feature payment retry');
  });

  it('preserves names that are already human readable', () => {
    expect(humanizeWorkspaceName('UI redesign implementation')).toBe('UI redesign implementation');
  });
});
