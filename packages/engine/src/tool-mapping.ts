/**
 * Tool-name translation between Allen's DB schema and provider-specific tool
 * identifiers. Allen agents historically stored `role.tools` as a mix of:
 *   - real Claude Code tool names (`Read`, `Bash`, `Grep`, ...)
 *   - MCP tool references (`mcp__server__tool` or `mcp__server`)
 *   - generic category tags (`filesystem`, `terminal`, `git`, `web`) — a
 *     legacy format that doesn't correspond to any real tool name, so we
 *     expand these to the concrete Claude tool set they imply.
 *
 * Codex intentionally ignores `role.tools` today (see codex-executor.ts),
 * so no Codex translator exists here yet. If tool restriction ever lands
 * on the Codex path, add a parallel CODEX_GENERIC_TOOL_MAP + expandToCodexTools.
 */

const CLAUDE_GENERIC_TOOL_MAP: Record<string, string[]> = {
  // Filesystem: read + write + search. Deliberately broad — generic
  // "filesystem" is Allen's legacy catch-all for file access.
  filesystem: ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep'],
  // Terminal / shell. Also covers BashOutput + KillShell since agents that
  // ask for "terminal" typically expect to monitor/kill long-running shells.
  terminal: ['Bash', 'BashOutput', 'KillShell'],
  // Git operations happen through bash in Claude Code — there is no separate
  // git tool. Map for legacy agent records that listed "git" explicitly.
  git: ['Bash'],
  // Web fetch + search.
  web: ['WebFetch', 'WebSearch'],
  // Aliases seen in a handful of agents.
  shell: ['Bash', 'BashOutput', 'KillShell'],
  bash: ['Bash', 'BashOutput', 'KillShell'],
  fs: ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep'],
};

/**
 * Expand Allen's raw tools list into concrete Claude Code tool names.
 *
 * - Generic categories → expanded per the map above.
 * - Real Claude tool names (Read, Bash, Task, etc.) → pass through.
 * - MCP references (`mcp__server__tool`, `mcp__server`) → pass through.
 * - Unknown tokens → pass through (let Claude Code decide).
 *
 * Order is preserved where possible; duplicates are collapsed.
 * Returns an empty array when the input is empty, so callers can decide
 * whether to emit the frontmatter `tools:` line or omit it (omitting means
 * "all tools" in Claude Code's model).
 */
export function expandToClaudeTools(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of raw) {
    const trimmed = (name ?? '').trim();
    if (!trimmed) continue;
    const expansion = CLAUDE_GENERIC_TOOL_MAP[trimmed.toLowerCase()];
    const pieces = expansion ?? [trimmed];
    for (const piece of pieces) {
      if (!seen.has(piece)) {
        seen.add(piece);
        out.push(piece);
      }
    }
  }
  return out;
}
