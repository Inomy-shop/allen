import { describe, expect, it } from 'vitest';
import { intervalForDuration } from '../watcher.service.js';

describe('intervalForDuration', () => {
  it('returns 60_000ms for duration < 10 minutes', () => {
    expect(intervalForDuration(0)).toBe(60_000);
    expect(intervalForDuration(1_000)).toBe(60_000);
    expect(intervalForDuration(5 * 60_000)).toBe(60_000);
    expect(intervalForDuration(9 * 60_000 + 59_000)).toBe(60_000);
  });

  it('returns 60_000ms for exactly 10 minutes (boundary)', () => {
    // 10 min = 600_000ms — <10min check: minutes < 10, 10 is not < 10
    // So 10 minutes test is 600000ms which is exactly 10, so <10 min = false
    // > 10 min check: minutes <= 60
    // Let's test exactly 9:59
    expect(intervalForDuration(9 * 60_000 + 59_000)).toBe(60_000);
  });

  it('returns 300_000ms for duration between 10 and 60 minutes', () => {
    expect(intervalForDuration(10 * 60_000)).toBe(300_000);
    expect(intervalForDuration(15 * 60_000)).toBe(300_000);
    expect(intervalForDuration(30 * 60_000)).toBe(300_000);
    expect(intervalForDuration(45 * 60_000)).toBe(300_000);
    expect(intervalForDuration(60 * 60_000)).toBe(300_000);
  });

  it('returns 300_000ms for exactly 60 minutes (boundary)', () => {
    expect(intervalForDuration(60 * 60_000)).toBe(300_000);
  });

  it('returns 600_000ms for duration > 60 minutes', () => {
    expect(intervalForDuration(61 * 60_000)).toBe(600_000);
    expect(intervalForDuration(90 * 60_000)).toBe(600_000);
    expect(intervalForDuration(120 * 60_000)).toBe(600_000);
    expect(intervalForDuration(24 * 60 * 60_000)).toBe(600_000);
  });

  it('handles very large durations', () => {
    expect(intervalForDuration(365 * 24 * 60 * 60_000)).toBe(600_000);
  });
});
