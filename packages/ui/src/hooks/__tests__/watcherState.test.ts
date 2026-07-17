import { describe, expect, it } from 'vitest';
import type { WatcherUIDoc } from '../../services/api';
import { mergeWatcherDocuments } from '../watcherState';

function watcher(executionId: string, updateSeq: number, state: WatcherUIDoc['executionState']): WatcherUIDoc {
  return {
    watcherId: `watcher-${executionId}`,
    executionId,
    executionType: 'agent',
    watcherStatus: state === 'running' ? 'active' : 'resolved',
    executionState: state,
    triggerSentForState: null,
    latestStatusText: state,
    lastCheckedAt: '2026-07-17T00:00:00.000Z',
    updateSeq,
  };
}

describe('mergeWatcherDocuments', () => {
  it('does not let a late initial REST response overwrite a newer SSE state', () => {
    const live = watcher('exec-1', 8, 'completed');
    const staleRest = watcher('exec-1', 6, 'running');
    const current = [live];
    const result = mergeWatcherDocuments(current, [staleRest]);
    expect(result).toBe(current);
    expect(result[0]).toEqual(live);
  });

  it('accepts newer updates and preserves compact-payload metadata', () => {
    const existing = watcher('exec-1', 4, 'running');
    const compact = {
      executionId: 'exec-1', updateSeq: 5, executionState: 'failed', watcherStatus: 'resolved',
      latestStatusText: 'failed', lastCheckedAt: '2026-07-17T00:00:05.000Z', triggerSentForState: 'failed',
    } as WatcherUIDoc;
    expect(mergeWatcherDocuments([existing], [compact])[0]).toMatchObject({
      watcherId: 'watcher-exec-1', executionType: 'agent', updateSeq: 5, executionState: 'failed',
    });
  });

  it('unions distinct watcher records during reconciliation', () => {
    expect(mergeWatcherDocuments([watcher('exec-1', 1, 'running')], [watcher('exec-2', 1, 'running')]))
      .toHaveLength(2);
  });
});
