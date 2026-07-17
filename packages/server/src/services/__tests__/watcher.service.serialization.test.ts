import { describe, expect, it, vi } from 'vitest';
import { serializeWatcherPoll } from '../watcher.service.js';

describe('serializeWatcherPoll', () => {
  it('coalesces concurrent notifications into one serialized trailing poll', async () => {
    const dbKey = {};
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    let calls = 0;
    const poll = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await firstBlocked;
    });

    const first = serializeWatcherPoll(dbKey, 'exec-1', poll);
    const second = serializeWatcherPoll(dbKey, 'exec-1', poll);
    const third = serializeWatcherPoll(dbKey, 'exec-1', poll);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(poll).toHaveBeenCalledTimes(1);
    releaseFirst();
    await first;
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('does not serialize unrelated executions behind each other', async () => {
    const dbKey = {};
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const firstPoll = vi.fn(async () => blocked);
    const secondPoll = vi.fn(async () => undefined);

    const first = serializeWatcherPoll(dbKey, 'exec-1', firstPoll);
    await serializeWatcherPoll(dbKey, 'exec-2', secondPoll);
    expect(secondPoll).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('clears the queue after a failure so a later notification can retry', async () => {
    const dbKey = {};
    await expect(serializeWatcherPoll(dbKey, 'exec-1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const retry = vi.fn(async () => undefined);
    await serializeWatcherPoll(dbKey, 'exec-1', retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
