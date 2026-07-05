export function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => (typeof item === 'string' ? item : null))
      .filter((item): item is string => !!item && item.trim().length > 0)
      .map(item => item.trim());
  }

  if (typeof value === 'string') {
    return value
      .split(/[\n,]+/)
      .map(item => item.trim())
      .filter(item => item.length > 0);
  }

  return [];
}

export function stringListIncludes(value: unknown, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return normalizeStringList(value).some(item => item.toLowerCase().includes(normalizedQuery));
}
