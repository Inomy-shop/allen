/**
 * Provider payload normalization for chat tool activity.
 *
 * Claude streams native tool arguments in two phases (an empty tool_use start,
 * followed by the completed assistant block), while Codex reports file edits as
 * fileChange items. These helpers keep the persisted chat record provider-neutral
 * without throwing away the source code or diff payload.
 */

export function mergeToolArguments(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): { args: Record<string, unknown>; changed: boolean } {
  if (Object.keys(incoming).length === 0) return { args: current, changed: false };
  const args = { ...current, ...incoming };
  return { args, changed: JSON.stringify(args) !== JSON.stringify(current) };
}

export function parseClaudeToolResult(content: unknown): Record<string, unknown> {
  let raw = '';
  if (Array.isArray(content)) {
    raw = content.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && 'text' in item) {
        return String((item as { text?: unknown }).text ?? '');
      }
      return typeof item === 'string' ? item : JSON.stringify(item ?? '');
    }).join('');
  } else if (typeof content === 'string') {
    raw = content;
  } else if (content && typeof content === 'object') {
    if ('text' in content) raw = String((content as { text?: unknown }).text ?? '');
    else return content as Record<string, unknown>;
  } else {
    raw = String(content ?? '');
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { raw };
  }
}

export function codexFileChanges(item: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap((change) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return [];
    const record = change as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path : '';
    if (!path) return [];
    const kind = record.kind && typeof record.kind === 'object' && !Array.isArray(record.kind)
      ? record.kind as Record<string, unknown>
      : {};
    const normalized: Record<string, unknown> = {
      path,
      status: typeof kind.type === 'string' ? kind.type : 'update',
      diff: typeof record.diff === 'string' ? record.diff : '',
    };
    if (typeof kind.move_path === 'string' && kind.move_path) normalized.movePath = kind.move_path;
    return [normalized];
  });
}
