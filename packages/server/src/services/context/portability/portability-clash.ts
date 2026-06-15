export type CuratedClashKind = 'entryId' | 'title' | 'path';
export type CuratedAction =
  | { action: 'add' }
  | { action: 'skip_duplicate'; reason: string }
  | { action: 'skip_clash'; clashKind: CuratedClashKind; reason: string };

export type MandatoryClashKind = 'title' | 'sourcePath';
export type MandatoryAction =
  | { action: 'add' }
  | { action: 'skip_duplicate'; reason: string }
  | { action: 'skip_missing_agent'; reason: string }
  | { action: 'skip_clash'; clashKind: MandatoryClashKind; reason: string };

export function classifyCuratedAction(
  existingEntries: Array<Record<string, unknown>>,
  importEntry: Record<string, unknown>,
): CuratedAction {
  // Check entryId clash
  const byEntryId = importEntry.entryId != null
    ? existingEntries.find((e) => e.entryId === importEntry.entryId)
    : undefined;
  if (byEntryId) {
    // Exact duplicate check: compare title + path + curatedContext + retrievalText
    if (
      byEntryId.title === importEntry.title &&
      byEntryId.path === importEntry.path &&
      byEntryId.curatedContext === importEntry.curatedContext &&
      byEntryId.retrievalText === importEntry.retrievalText
    ) {
      return { action: 'skip_duplicate', reason: `Curated entry "${importEntry.title}" already exists with equivalent content` };
    }
    return { action: 'skip_clash', clashKind: 'entryId', reason: `Existing curated entry with same entryId has different content` };
  }
  // Check title clash
  const byTitle = importEntry.title != null
    ? existingEntries.find((e) => e.title === importEntry.title)
    : undefined;
  if (byTitle) {
    if (
      byTitle.path === importEntry.path &&
      byTitle.curatedContext === importEntry.curatedContext &&
      byTitle.retrievalText === importEntry.retrievalText
    ) {
      return { action: 'skip_duplicate', reason: `Curated entry "${importEntry.title}" already exists with equivalent content` };
    }
    return { action: 'skip_clash', clashKind: 'title', reason: `Existing curated entry with same title has different content` };
  }
  // Check path clash
  if (importEntry.path) {
    const byPath = existingEntries.find((e) => e.path === importEntry.path && e.path);
    if (byPath) {
      if (
        byPath.title === importEntry.title &&
        byPath.curatedContext === importEntry.curatedContext &&
        byPath.retrievalText === importEntry.retrievalText
      ) {
        return { action: 'skip_duplicate', reason: `Curated entry with same path already exists with equivalent content` };
      }
      return { action: 'skip_clash', clashKind: 'path', reason: `Existing curated entry with same path has different content` };
    }
  }
  return { action: 'add' };
}

export function classifyMandatoryAction(
  existingMappings: Array<Record<string, unknown>>, // already filtered to same agentName
  agentExists: boolean,
  importMapping: Record<string, unknown>,
): MandatoryAction {
  if (!agentExists) {
    return { action: 'skip_missing_agent', reason: `Agent "${importMapping.agentName}" does not exist in this Allen instance` };
  }
  // Check title clash (per agent)
  const byTitle = importMapping.title != null
    ? existingMappings.find((m) => m.title === importMapping.title)
    : undefined;
  if (byTitle) {
    if (byTitle.contentHash === importMapping.contentHash || byTitle.content === importMapping.content) {
      return { action: 'skip_duplicate', reason: `Mandatory mapping for agent "${importMapping.agentName}" with same title already exists with equivalent content` };
    }
    return { action: 'skip_clash', clashKind: 'title', reason: `Existing mandatory mapping for agent "${importMapping.agentName}" with same title has different content` };
  }
  // Check sourcePath clash (per agent, only when sourcePath is set)
  if (importMapping.sourcePath) {
    const bySourcePath = existingMappings.find((m) => m.sourcePath === importMapping.sourcePath);
    if (bySourcePath) {
      if (bySourcePath.contentHash === importMapping.contentHash || bySourcePath.content === importMapping.content) {
        return { action: 'skip_duplicate', reason: `Mandatory mapping for agent "${importMapping.agentName}" with same sourcePath already exists with equivalent content` };
      }
      return { action: 'skip_clash', clashKind: 'sourcePath', reason: `Existing mandatory mapping for agent "${importMapping.agentName}" with same sourcePath has different content` };
    }
  }
  return { action: 'add' };
}
