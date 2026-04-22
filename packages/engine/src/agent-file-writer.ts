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

  // A line of three+ dashes in the body would prematurely terminate the YAML
  // frontmatter we're about to emit. Swap it for `***`, an equivalent markdown
  // thematic break, so authored content survives without corrupting the file.
  const safeSystem = agent.system.replace(/^-{3,}$/gm, '***');

  // Translate Allen's raw tools list into concrete Claude Code tool names.
  // Generic categories like `filesystem` / `terminal` expand to their real
  // tool sets (Read, Write, Bash, etc.). If no valid tools remain after
  // translation, omit the `tools:` frontmatter entirely — Claude Code reads
  // that as "give this agent access to all tools", which is the right default
  // for agents whose DB record has only legacy or unrecognized tool tokens.
  const expandedTools = expandToClaudeTools(agent.tools);
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
