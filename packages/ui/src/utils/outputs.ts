/**
 * Outputs normalisation helpers — used by any UI component that renders or
 * edits a node's `outputs` field.
 *
 * The canonical on-disk shape is `Record<string, string>` (key → description).
 * These helpers defensively accept the legacy array form too, so a UI that
 * loads an older workflow YAML doesn't crash with
 * "outputs.join is not a function" (regression bug from 2026-04-13).
 */

export type OutputsSpec = Record<string, string> | string[] | undefined | null;

/** Return the list of output keys from either array or object form. */
export function outputsAsKeys(spec: unknown): string[] {
  if (!spec) return [];
  if (Array.isArray(spec)) return spec as string[];
  if (typeof spec === 'object') return Object.keys(spec as Record<string, unknown>);
  return [];
}

/**
 * Merge a new comma-separated list of keys into the existing outputs spec,
 * preserving any existing descriptions and setting new keys to empty string.
 * Always returns the canonical object form.
 */
export function mergeOutputsFromKeys(
  current: unknown,
  commaSeparatedKeys: string,
): Record<string, string> {
  const keys = commaSeparatedKeys.split(',').map((s) => s.trim()).filter(Boolean);
  const existingMap: Record<string, string> = Array.isArray(current)
    ? Object.fromEntries((current as string[]).map((k) => [k, '']))
    : current && typeof current === 'object'
      ? { ...(current as Record<string, string>) }
      : {};
  const next: Record<string, string> = {};
  for (const k of keys) next[k] = existingMap[k] ?? '';
  return next;
}
