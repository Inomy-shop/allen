import type { WatcherUIDoc } from '../services/api';

/** Merge REST hydration and SSE updates without allowing a slower response to
 * roll an execution back. Spreading preserves fields omitted by compact SSE
 * payloads (for example watcherId and executionType). */
export function mergeWatcherDocuments(
  current: WatcherUIDoc[],
  incoming: WatcherUIDoc[],
): WatcherUIDoc[] {
  let changed = false;
  const byExecution = new Map(current.map(item => [item.executionId, item]));
  for (const item of incoming) {
    if (!item?.executionId) continue;
    const existing = byExecution.get(item.executionId);
    if (existing && Number(item.updateSeq ?? 0) <= Number(existing.updateSeq ?? 0)) continue;
    byExecution.set(item.executionId, existing ? { ...existing, ...item } : item);
    changed = true;
  }
  return changed ? [...byExecution.values()] : current;
}
