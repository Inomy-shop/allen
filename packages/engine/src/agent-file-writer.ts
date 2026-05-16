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

# Artifacts — MANDATORY for plans, designs, reports, and summaries

You MUST call the \`allen_save_artifact\` MCP tool whenever you produce any of the following kinds of content. This is not optional — the engine does NOT auto-capture your JSON outputs as files. If you don't call this tool, the document you generated will only exist as a JSON string in execution state and will not be browsable by the user.

## When to call \`allen_save_artifact\` (always — every run)

Call it once per document. Save BEFORE you emit your final JSON output block, in the same turn.

- **Product Requirements Documents (PRD)** — save the full markdown: \`allen_save_artifact("prd/requirements.md", <the PRD content>, content_type="markdown")\`
- **High-Level Architecture / Design (HLA / HLD)** — \`allen_save_artifact("hla/architecture.md", <the HLA content>, content_type="markdown")\`
- **Technical Design Documents (TDD)** — \`allen_save_artifact("tdd/technical-design.md", <the TDD content>, content_type="markdown")\`
- **Implementation plans / file-level plans** — \`allen_save_artifact("plans/implementation-plan.md", <plan>, content_type="markdown")\` and also save the structured version as JSON: \`allen_save_artifact("plans/implementation-plan.json", <plan json>, content_type="json")\`
- **Investigation / research reports** — \`allen_save_artifact("reports/<topic>.md", <report>, content_type="markdown")\`
- **QA / test reports / validator verdicts** — \`allen_save_artifact("reports/qa-verdict.md", <report>, content_type="markdown")\`
- **Code review notes** — \`allen_save_artifact("reports/code-review.md", <review>, content_type="markdown")\`
- **Run summaries** — \`allen_save_artifact("summary/summary.md", <summary>, content_type="markdown")\`
- **Structured data exports** — CSV, JSON configs, YAML: pick the matching content_type (csv / json / yaml / code).
- **Any other standalone document the user should be able to review later** — scratch notes, investigation logs, decision records.

## Format rules

- Use the file extension that matches the content: \`.md\` for markdown, \`.json\` for JSON, \`.csv\` for CSV, \`.txt\` for plain text, \`.yaml\` for YAML, source-file extensions for code.
- Pass \`content_type\` explicitly when the extension might be ambiguous.
- Use sub-paths to group related files: \`plans/<name>.md\`, \`reports/<name>.md\`, \`tdd/<name>.md\`.
- \`overwrite: true\` is safe on retry — subsequent attempts replace the prior artifact.

## What the tool does for you

- Files are routed automatically to the run that spawned you (workflow execution / chat session / agent run) — you do NOT pass a root id. The MCP reads it from env.
- Files render inline in the Allen UI by extension: markdown → prose with headings, JSON → pretty-printed tree, CSV → table, text/code → monospace.
- Each artifact gets a public URL — \`allen_save_artifact\` returns an object shaped like \`{ artifactId, url, publicUrl, rootType, rootId, filename, sizeBytes, overwritten }\`. Copy the **publicUrl** field (full \`http://host/api/artifacts/<id>/content\` — human-clickable and WebFetch-able) into your JSON output so downstream nodes can link to it: \`{"prd_artifact_url": "<publicUrl from allen_save_artifact>"}\`. Do NOT use the bare \`url\` field (relative path only) or \`artifactId\` (opaque id).

## What you should STILL emit in your structured output

The artifact is the user-facing rendered document. Your structured JSON output (PRD as a data object, plan as an array of changes, etc.) is what downstream workflow nodes consume via templating. Both are required:
1. Call \`allen_save_artifact\` with the rendered markdown.
2. Also emit the structured JSON in your output block.
They're not redundant — the markdown is for humans, the JSON is for downstream agents.

## Sub-agents

When you spawn sub-agents via \`spawn_agent\`, INCLUDE THIS INSTRUCTION in their prompt. Their artifacts inherit your root, so the user sees the whole spawn tree's files in one Artifacts panel.

## \`upload_file\` vs \`allen_save_artifact\`

Prefer \`allen_save_artifact\` for anything belonging to this run. Use \`upload_file\` only when you need a one-off file that leaves Allen (e.g., Slack attachments, email).
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

/**
 * Guidance appended to every NON-CHAT agent run (workflow node, direct agent
 * call, repo scanner, materialized CLI subagent). These contexts have no live
 * user reading the turn output and no delegation thread surface, so the
 * interactive tools (ask_user / delegate_to_agent + their wait/ask/answer
 * companions) cannot resolve and would block or no-op. The agent's authored
 * system prompt and the runtime-injected org chart may both encourage
 * delegation; this block goes LAST so the model takes it as the active rule.
 *
 * In chat (chat.service.ts) this guidance is intentionally NOT applied — that
 * path keeps delegate_to_agent / ask_user available because the user is
 * actively reading.
 */
export const NON_INTERACTIVE_GUIDANCE = `

# Non-interactive execution — DO NOT use chat-only tools

You are running in a non-interactive context (workflow node, direct agent call, or scan). There is no live user reading your output and no chat thread to surface a delegation through. The following tools WILL NOT WORK here and you MUST NOT call them — they will block, hang, or be silently dropped:

- \`ask_user\` (and any \`*ask_user*\` alias)
- \`delegate_to_agent\`, \`wait_for_delegation\`, \`ask_delegator\`, \`answer_delegator\`

If you need information you don't have: include the gap in your final structured output (e.g. \`"missing": "<what you need>"\`) and finish the turn — the workflow / caller will handle it.

If you need work done by another agent: use \`spawn_agent(agent_name, task)\` (one-shot, returns when the spawned agent finishes). Do NOT call \`delegate_to_agent\`.

This rule overrides any earlier instruction in this prompt that tells you to delegate or ask the user.
`;

/** Sentinel for idempotent injection of NON_INTERACTIVE_GUIDANCE. */
const NON_INTERACTIVE_GUIDANCE_SENTINEL = 'Non-interactive execution — DO NOT use chat-only tools';

/**
 * Append NON_INTERACTIVE_GUIDANCE idempotently. Use at every non-chat agent
 * call site (node-executor for Claude SDK + CLI, codex-executor, repo
 * scanner, renderAgentFile). Chat (chat.service.ts) intentionally does NOT
 * call this — the user is live there and delegation/ask_user are valid.
 */
export function withNonInteractiveGuidance(systemPrompt: string | undefined): string {
  const s = systemPrompt ?? '';
  return s.includes(NON_INTERACTIVE_GUIDANCE_SENTINEL) ? s : `${s}${NON_INTERACTIVE_GUIDANCE}`;
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
  /**
   * Optional list of `mcp__<server>__<tool>` names available in the runtime
   * (Allen, Linear, Postgres, GitHub, etc.). When the agent has an explicit
   * `tools` allowlist, Claude Code treats it as a hard cap — any MCP tool
   * NOT in the list is invisible to the model, even if its server is
   * registered. We append these names to the allowlist so every registered
   * MCP tool is reachable by the agent. Pass the discovered tool list from
   * `loadMcpTools(db)` (server side) or from any equivalent caller-side
   * discovery; missing or empty array → no extra injection (the allowlist
   * stays as the author wrote it).
   */
  mcpToolNames?: string[];
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
  // skips a duplicate append in that case. Same for the non-interactive
  // guidance — materialized CLI subagents are spawned outside chat (workflow
  // / direct agent CLI), so ask_user / delegate_to_agent must be off-limits.
  const sourceSystem = withNonInteractiveGuidance(withArtifactsGuidance(agent.system));

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
  // if (expandedTools.length > 0) {
    const seen = new Set(expandedTools);
    // Always-on artifact tools — agents are told to call these in
    // ARTIFACTS_GUIDANCE, so without injection the allowlist would
    // silently strip them.
    for (const t of ARTIFACT_MCP_TOOLS) if (!seen.has(t)) { expandedTools.push(t); seen.add(t); }
    // Caller-supplied list of every registered MCP tool name. Without
    // this, an authored allowlist (e.g. `tools: [Read, Write, Bash]`)
    // hides every mcp__linear__*, mcp__postgres__*, etc. — the agent
    // then says "I don't have Linear API access" even though the MCP
    // is loaded and connected. Inject them so the allowlist becomes
    // "the author's tools + every MCP tool the runtime discovered".
    for (const t of agent.mcpToolNames ?? []) {
      if (typeof t === 'string' && t.startsWith('mcp__') && !seen.has(t)) {
        expandedTools.push(t);
        seen.add(t);
      }
    }
  // }
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
