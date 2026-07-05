import { describe, expect, it } from 'vitest';
import { intervalForDuration } from '../watcher.service.js';

describe('intervalForDuration', () => {
  it('returns 10_000ms for new executions', () => {
    expect(intervalForDuration(0)).toBe(10_000);
    expect(intervalForDuration(1_000)).toBe(10_000);
  });

  it('keeps polling every 10 seconds regardless of execution duration', () => {
    expect(intervalForDuration(5 * 60_000)).toBe(10_000);
    expect(intervalForDuration(10 * 60_000)).toBe(10_000);
    expect(intervalForDuration(60 * 60_000)).toBe(10_000);
    expect(intervalForDuration(24 * 60 * 60_000)).toBe(10_000);
  });

  it('handles very large durations without backing off', () => {
    expect(intervalForDuration(365 * 24 * 60 * 60_000)).toBe(10_000);
  });
});
