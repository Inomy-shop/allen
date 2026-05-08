// packages/ui/src/components/settings/mcp-command.ts
// Pure helpers for MCP command auto-fill logic (PRD REQ-009, REQ-010)

/**
 * Returns the default command for a given entry file path based on extension.
 * AC-015: .py → python3
 * AC-016: .ts / .tsx → npx tsx
 * AC-017: .js / .mjs / .cjs → node
 */
export function commandForExtension(entryPath: string): string {
  const lower = entryPath.toLowerCase();
  if (lower.endsWith('.py')) return 'python3';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'npx tsx';
  return 'node';
}

/**
 * Returns the default command for a discovered MCP candidate.
 * repoRelative is optional — Python branch ignores it; Node branch uses it for .ts/.tsx detection.
 * AC-012: python candidate → python3
 * AC-013: node + .ts → npx tsx
 * AC-014: node + .mjs → node
 */
export function commandForCandidate(c: {
  detectedLanguage: 'python' | 'node';
  repoRelative?: string;
}): string {
  if (c.detectedLanguage === 'python') return 'python3';
  return commandForExtension(c.repoRelative ?? '');
}
