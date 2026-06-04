export function sanitizeChatAssistantResponse(candidate: unknown): string {
  if (typeof candidate !== 'string') return '';
  let text = candidate;
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = stripTrailingRepoContextUsageMarker(text).replace(/\s+$/g, '');
    text = stripTrailingRepoContextUsageJsonFence(text).replace(/\s+$/g, '');
    text = stripTrailingRepoContextUsageJsonObject(text).replace(/\s+$/g, '');
    text = stripTrailingRepoContextUsageSection(text).replace(/\s+$/g, '');
  }
  return text;
}

function stripTrailingRepoContextUsageMarker(text: string): string {
  return text.replace(
    /(?:\n\s*)*(?:repo[_\s-]*context[_\s-]*usage|repocontextusage)\s*:\s*no\s+repo\s+context\s+used\.?\s*$/i,
    '',
  );
}

function stripTrailingRepoContextUsageJsonFence(text: string): string {
  const match = text.match(/(?:\n\s*)```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (!match?.[1]) return text;
  return isStandaloneRepoContextUsageJson(match[1])
    ? text.slice(0, match.index).replace(/\s+$/g, '')
    : text;
}

function stripTrailingRepoContextUsageJsonObject(text: string): string {
  const starts = [...text.matchAll(/(?:^|\n)\s*\{/g)].map((match) => match.index ?? 0);
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const start = starts[i];
    const candidate = text.slice(start).trim();
    if (!candidate.endsWith('}')) continue;
    if (isStandaloneRepoContextUsageJson(candidate)) {
      return text.slice(0, start).replace(/\s+$/g, '');
    }
  }
  return text;
}

function stripTrailingRepoContextUsageSection(text: string): string {
  const marker = /(?:^|\n)\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:`{1,3})?(?:repo[_\s-]*context[_\s-]*usage|repocontextusage)\b[\s\S]*$/i;
  const match = text.match(marker);
  if (!match || match.index == null) return text;
  return text.slice(0, match.index).replace(/\s+$/g, '');
}

function isStandaloneRepoContextUsageJson(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed as Record<string, unknown>);
    return keys.length === 1 && keys[0] === 'repo_context_usage';
  } catch {
    return false;
  }
}
