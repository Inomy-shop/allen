import { describe, expect, it } from 'vitest';
import {
  isCancelledExecutionStatus,
  isTerminalExecutionStatus,
  normalizeExecutionStatus,
} from './execution-status';

describe('execution status aliases', () => {
  it('normalizes both cancellation spellings to the UI canonical value', () => {
    expect(normalizeExecutionStatus('canceled')).toBe('cancelled');
    expect(normalizeExecutionStatus('cancelled')).toBe('cancelled');
  });

  it('treats both cancellation spellings as terminal', () => {
    expect(isCancelledExecutionStatus('canceled')).toBe(true);
    expect(isCancelledExecutionStatus('cancelled')).toBe(true);
    expect(isTerminalExecutionStatus('canceled')).toBe(true);
    expect(isTerminalExecutionStatus('running')).toBe(false);
  });
});
