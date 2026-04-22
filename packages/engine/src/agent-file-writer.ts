/**
 * Materializes an Allen agent as a Claude Code subagent markdown file under
 * ~/.claude/agents/allen-<agentName>.md. Used by cli-runner.ts when
 * ALLEN_AGENT_EXECUTION_MODE=cli. The file lives outside any repo, so it's
 * never tracked by git, and is rewritten + cleaned up around every spawn.
 *
 * Concurrency model: two parallel calls for the same agent will write
 * byte-identical bodies, so overwrite-always is safe. The file body depends
 * on `system` and optional frontmatter fields — not on per-execution data —
 * so same-agent concurrent executions don't corrupt each other.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { expandToClaudeTools } from './tool-mapping.js';
import { MCP_SERVER_NAME } from './brand.js';

/**
 * Allen MCP tools the ARTIFACTS_GUIDANCE tells every CLI agent to use. When
 * the agent's authored tools list is non-empty, Claude Code treats it as a
 * hard allowlist — so we must inject these three or the guidance becomes a
 * no-op (agent is told to call a tool it can't see).
 */
const ARTIFACT_MCP_TOOLS: readonly string[] = [
  `mcp__${MCP_SERVER_NAME}__allen_save_artifact`,
  `mcp__${MCP_SERVER_NAME}__allen_list_artifacts`,
  `mcp__${MCP_SERVER_NAME}__allen_get_artifact`,
];

/**
 * Single source of truth for the artifact-save instruction appended to every
 * agent's system prompt. Exported so the SDK / Codex / delegate paths in the
 * server can append it themselves; the CLI path goes through renderAgentFile
 * which appends it idempotently below.
 */
export const ARTIFACTS_GUIDANCE = `

# Artifacts

When you produce a standalone document worth keeping — a plan, design doc, investigation notes, CSV export, JSON config, or any file the user should be able to review later — save it with the \`allen_save_artifact\` MCP tool:

- \`allen_save_artifact(filename, content)\` — files auto-render in the UI based on extension (.md / .json / .csv / .txt / code). No root id needed; the tool files under whichever run spawned you (workflow / chat / agent) via env-var context.
- Prefer \`allen_save_artifact\` over \`upload_file\` for in-conversation/run deliverables. Use \`upload_file\` only for shares destined for outside Allen.
- When you spawn sub-agents via \`spawn_agent\`, INCLUDE THIS INSTRUCTION in their prompt. Their artifacts inherit your root, so the user sees the whole spawn tree's files in one Artifacts panel.
- Don't duplicate auto-captured outputs — workflow outputs whose keys end in \`_markdown\` / \`_json\` / \`_csv\` are saved automatically. Use \`allen_save_artifact\` for artifacts OUTSIDE the declared output schema.
`;

/** Sentinel used by the idempotent injector. Cheap substring check. */
const ARTIFACTS_GUIDANCE_SENTINEL = 'allen_save_artifact';

/**
 * Append ARTIFACTS_GUIDANCE to a system prompt, but only if it isn't already
 * there. Single helper so every agent call site (chat spawn, delegate, workflow
 * Claude-CLI / Claude-SDK / Codex, repo scanner, etc.) gets identical behavior
 * without copy-pasting the sentinel literal.
 */
export function withArtifactsGuidance(systemPrompt: string | undefined): string {
  const s = systemPrompt ?? '';
  return s.includes(ARTIFACTS_GUIDANCE_SENTINEL) ? s : `${s}${ARTIFACTS_GUIDANCE}`;
}

export type MaterializedAgent = {
  /** e.g. "allen-brand-strategist" — pass this to `claude --agent <name>`. */
  subagentName: string;
  /** absolute path to the rendered .md file. */
  path: string;
  /** idempotent unlink — never throws. */
  cleanup: () => void;
};

export type AgentSpec = {
  /** agent's canonical name in the Allen DB. */
  name: string;
  /** one-line description used in the frontmatter. */
  description?: string;
  /** system-prompt body (the agent's persona instructions). */
  system: string;
  /** optional model pin — passed through to the frontmatter. */
  model?: string;
  /** optional tool allowlist — passed through to the frontmatter. */
  tools?: string[];
};

/** Slug the agent name so it forms a valid filename + subagent identifier. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Render the markdown file body (frontmatter + prompt body). */
export function renderAgentFile(agent: AgentSpec): { subagentName: string; body: string } {
  const subagentName = `allen-${slugify(agent.name)}`;
  const description = agent.description ?? `Allen agent: ${agent.name}`;

  // Inject the artifact guidance idempotently. Some callers (chat-tools.ts
  // SDK/Codex paths, node-executor) already concatenate it before handing
  // us the system body; the sentinel check inside withArtifactsGuidance
  // skips a duplicate append in that case.
  const sourceSystem = withArtifactsGuidance(agent.system);

  // A line of three+ dashes in the body would prematurely terminate the YAML
  // frontmatter we're about to emit. Swap it for `***`, an equivalent markdown
  // thematic break, so authored content survives without corrupting the file.
  const safeSystem = sourceSystem.replace(/^-{3,}$/gm, '***');

  // Translate Allen's raw tools list into concrete Claude Code tool names.
  // Generic categories like `filesystem` / `terminal` expand to their real
  // tool sets (Read, Write, Bash, etc.). If no valid tools remain after
  // translation, omit the `tools:` frontmatter entirely — Claude Code reads
  // that as "give this agent access to all tools", which is the right default
  // for agents whose DB record has only legacy or unrecognized tool tokens.
  const expandedTools = expandToClaudeTools(agent.tools);
  // Only inject when an explicit allowlist exists — empty means "all tools",
  // which already includes the Allen MCP. Skip duplicates so we don't bloat
  // the frontmatter on agents that already opted in.
  if (expandedTools.length > 0) {
    const seen = new Set(expandedTools);
    for (const t of ARTIFACT_MCP_TOOLS) if (!seen.has(t)) expandedTools.push(t);
  }
  const frontmatter = [
    '---',
    `name: ${subagentName}`,
    `description: ${JSON.stringify(description)}`,
    ...(agent.model ? [`model: ${agent.model}`] : []),
    ...(expandedTools.length > 0 ? [`tools: ${expandedTools.join(', ')}`] : []),
    '---',
  ].join('\n');

  const body = `${frontmatter}\n\n${safeSystem}\n`;
  return { subagentName, body };
}

/**
 * Write the agent file to ~/.claude/agents/ and return a cleanup handle.
 * Always overwrites. Caller must invoke `cleanup()` in a finally block.
 */
export function writeAgentFile(agent: AgentSpec): MaterializedAgent {
  const { subagentName, body } = renderAgentFile(agent);
  const outDir = resolvePath(homedir(), '.claude', 'agents');
  mkdirSync(outDir, { recursive: true });
  const path = resolvePath(outDir, `${subagentName}.md`);
  writeFileSync(path, body, 'utf8');

  return {
    subagentName,
    path,
    cleanup() {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Idempotent cleanup — never throw from a finally.
      }
    },
  };
}
