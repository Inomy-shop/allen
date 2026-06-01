/**
 * Materializes an Allen agent as a Claude Code subagent markdown file under
 * ~/.claude/agents/allen-<agentName>.md. Used by cli-runner.ts when
 * ALLEN_AGENT_EXECUTION_MODE=cli. The file lives outside any repo, so it's
 * never tracked by git, and is rewritten + cleaned up around every spawn.
 *
 * Concurrency model: static calls for the same agent write byte-identical
 * bodies, so overwrite-always is safe. Callers that include per-execution
 * system content must pass materializedNameSuffix so parallel runs do not
 * overwrite each other's dynamic agent file.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { expandToClaudeTools } from './tool-mapping.js';
import { ALLEN_MCP_CLAUDE_TOOL_NAMES } from './allen-mcp-tools.js';

const CLAUDE_TOOL_SEARCH = 'ToolSearch';

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

export const REPO_CONTEXT_LOADING_GUIDANCE = `

<repo_context_loading_protocol priority="mandatory">
  <purpose>
    During analysis, implementation, QA, review, or documentation in a registered repo,
    use the repo context graph as a triage index. Load relevant full bodies before relying
    on repo-specific instructions, knowledge, skills, docs, runbooks, or production notes.
  </purpose>

  <tool_use_rules>
    <rule>First inspect any allen_mandatory_repo_context block in your system instructions. Files inside full_body_context have already been loaded by Allen and are source material for this task.</rule>
    <rule>Provider-native refs in the mandatory context manifest are expected to be loaded by Claude/Codex from the repo's native instruction mechanism; use them as provider-loaded instructions and do not duplicate-load them unless you need to verify contents.</rule>
    <rule>Selected refs and summaries outside full_body_context are relevance hints only, not source material.</rule>
    <rule>Mandatory or baseline refs that are not already present in full_body_context and are not provider-native must be loaded with the Allen MCP loader before analysis, implementation, QA, review, or documentation unless the task is explicitly unrelated; if unrelated, report the ref in context_skipped with the reason.</rule>
    <rule>Before any selected ref, summary, skill, production note, instruction file, doc, or runbook affects reasoning, code, tests, QA, review, or docs, ensure the complete body is available either from allen_mandatory_repo_context or from an Allen MCP body-loader call.</rule>
    <rule>Use command profile context when the task involves tests, validation, package scripts, CI, Docker, deployment, runtime packaging, or dependency behavior. Do not treat command profiles as universally mandatory for unrelated investigation, design, review, or documentation work.</rule>
    <rule>For file-backed instruction files, context files, docs, runbooks, production notes, and selected Cognee refs, call get_repo_context_body, shown by some clients as mcp__allen__get_repo_context_body.</rule>
    <rule>For skills, call get_repo_skill_body, shown by some clients as mcp__allen__get_repo_skill_body.</rule>
    <rule>Do this before making code changes, final recommendations, QA conclusions, or review findings that depend on repo-specific practices.</rule>
    <rule>Do not treat a packet summary as sufficient context. The summary only decides whether the full file body needs to be loaded or whether the system-injected body already covers it.</rule>
  </tool_use_rules>

  <reporting_rules>
    <rule>The repo_context_usage object is audit data used by Allen for deterministic context relevance scoring. Do not use it as a narrative activity log.</rule>
    <rule>Every context_preselected, context_summary_used, context_loaded, context_applied, and context_skipped row MUST be an object with a refId. String rows, path-only rows, and source-code file paths are invalid for repo context usage audit.</rule>
    <rule>Report context_preselected for refs you considered from the injected selection.</rule>
    <rule>Report context_summary_used only for refs whose summaries you inspected for relevance but did not rely on.</rule>
    <rule>Report context_loaded only when you actually called get_repo_context_body/get_repo_skill_body successfully, or when the ref was present in allen_mandatory_repo_context full_body_context.</rule>
    <rule>Report context_applied only when a successfully loaded or system-injected full body changed or confirmed reasoning, code, tests, QA, review, or docs.</rule>
    <rule>Do not report normal source-code Read, Grep, or shell file inspection as context_loaded; those are code inspection, not repo knowledge body loading.</rule>
    <rule>If a relevant ref could not be loaded, report it in context_skipped with the reason instead of claiming it was loaded.</rule>
  </reporting_rules>
  <repo_context_usage_schema>
{
  "repo_context_usage": {
    "module_identified": "module/files you worked on, or null",
    "context_preselected": [{"refId": "Allen-selected knowledge ref id", "source": "runtime_preselected", "reason": "why you considered or ignored it"}],
    "context_summary_used": [{"refId": "Allen-selected knowledge ref id", "reason": "inspected packet summary for relevance only; did not rely on it for final work"}],
    "context_loaded": [{"refId": "knowledge ref id", "kind": "instruction_file|context_file|doc|runbook|production_note|skill|skill_body|context_body|provider_text", "source": "allen_system_injection|get_repo_context_body|get_repo_skill_body", "reason": "why the full body was loaded"}],
    "context_applied": [{"refId": "knowledge ref id", "source": "allen_system_injection|get_repo_context_body|get_repo_skill_body", "summary": "how the loaded full body affected the work"}],
    "context_skipped": [{"refId": "Allen-selected knowledge ref id", "reason": "why not relevant or unavailable"}],
    "validation_performed": ["commands/checks/source files inspected; this is not repo context loading"]
  }
}
  </repo_context_usage_schema>
</repo_context_loading_protocol>
`;

const REPO_CONTEXT_LOADING_GUIDANCE_SENTINEL = '<repo_context_loading_protocol';
const MANDATORY_REPO_CONTEXT_SENTINEL = '<allen_mandatory_repo_context';

export function hasRepoContextLoadingGuidance(systemPrompt: string | undefined): boolean {
  return (systemPrompt ?? '').includes(REPO_CONTEXT_LOADING_GUIDANCE_SENTINEL);
}

export function withRepoContextLoadingGuidance(systemPrompt: string | undefined): string {
  const s = systemPrompt ?? '';
  return hasRepoContextLoadingGuidance(s) ? s : `${REPO_CONTEXT_LOADING_GUIDANCE}${s}`;
}

export function hasMandatoryRepoContext(systemPrompt: string | undefined): boolean {
  return (systemPrompt ?? '').includes(MANDATORY_REPO_CONTEXT_SENTINEL);
}

export function withMandatoryRepoContext(systemPrompt: string | undefined, mandatoryContextBlock?: string): string {
  const s = systemPrompt ?? '';
  const block = mandatoryContextBlock?.trim();
  if (!block || hasMandatoryRepoContext(s)) return s;
  return `${block}\n\n${s}`;
}

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
  /** SHA-256 of the exact rendered markdown body written to disk. */
  sha256: string;
  /** UTF-8 byte length of the exact rendered markdown body. */
  byteLength: number;
  /** Whether the rendered body contains Allen's mandatory repo context block. */
  containsMandatoryRepoContext: boolean;
  /**
   * Exact tool allowlist written into the YAML frontmatter's `tools:` line.
   * Persisted on the node trace as the authoritative record of what the
   * agent file actually contained — independent of the Claude CLI's
   * (race-prone) `system/init` tools array.
   */
  tools: string[];
  /** Timestamp captured immediately after the file body was rendered. */
  createdAt: Date;
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
  /** Allen MCP tool names disabled for this materialized agent. */
  disabledAllenMcpTools?: string[];
  /** Disabled MCP tools by server name, using bare tool names. */
  disabledMcpTools?: Record<string, string[]>;
  /**
   * Per-execution suffix for materialized Claude CLI agent files. Dynamic
   * system prompt content such as Allen mandatory repo context must not be
   * written to the shared allen-<agent>.md filename because parallel runs of
   * the same agent could overwrite each other.
   */
  materializedNameSuffix?: string;
  /**
   * Include Allen's repo-context loading protocol and usage schema in the
   * materialized agent file. This must only be enabled for runs that have an
   * active repo knowledge packet; otherwise global Claude agent files would
   * tell agents to load repo context even when the context provider is off.
   */
  includeRepoContextLoadingGuidance?: boolean;
};

/** Slug the agent name so it forms a valid filename + subagent identifier. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Render the markdown file body (frontmatter + prompt body).
 *
 * Returns `tools` — the exact allowlist that ends up in the `tools:` line of
 * the YAML frontmatter. Callers (writeAgentFile → MaterializedAgent → the
 * cli-runner callback → node-executor's runtimeContext) carry this forward so
 * the trace document can record what we actually wrote to disk, independent
 * of what the Claude CLI's `system/init` message later reports as available.
 *
 * Why both fields matter: the SDK's init `tools` array sometimes lands before
 * MCP `tools/list` completes (observed on engineering-lead, 7 vs 88 mismatch).
 * Comparing `materializedAgentFile.tools` to `toolsAvailable` lets the UI
 * tell that race apart from a real "MCP tool dropped" bug.
 *
 * Returns the empty array when no allowlist is emitted (omitted frontmatter
 * line == Claude treats it as "all tools").
 */
export function renderAgentFile(agent: AgentSpec): { subagentName: string; body: string; tools: string[] } {
  const suffix = agent.materializedNameSuffix ? `-${slugify(agent.materializedNameSuffix)}` : '';
  const subagentName = `allen-${slugify(agent.name)}${suffix}`;
  const description = agent.description ?? `Allen agent: ${agent.name}`;

  // Inject the artifact guidance idempotently. Some callers (chat-tools.ts
  // SDK/Codex paths, node-executor) already concatenate it before handing
  // us the system body; the sentinel check inside withArtifactsGuidance
  // skips a duplicate append in that case. Same for the non-interactive
  // guidance — materialized CLI subagents are spawned outside chat (workflow
  // / direct agent CLI), so ask_user / delegate_to_agent must be off-limits.
  const systemWithArtifacts = withArtifactsGuidance(agent.system);
  const systemWithRepoContext = agent.includeRepoContextLoadingGuidance
    ? withRepoContextLoadingGuidance(systemWithArtifacts)
    : systemWithArtifacts;
  const sourceSystem = withNonInteractiveGuidance(systemWithRepoContext);

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
    // Always-on Allen MCP tools. Workflow / direct agent runs rely on Allen
    // MCP for artifacts, execution lookup, spawning, workflow dispatch, etc.
    // When a Claude agent file has a `tools:` allowlist, every MCP tool that
    // should be callable must be listed explicitly.
    const disabledAllenTools = new Set([
      ...(agent.disabledAllenMcpTools ?? []),
      ...(agent.disabledMcpTools?.allen ?? []),
    ]
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .map((t) => t.startsWith('mcp__') ? t : `mcp__allen__${t}`));
    for (const t of ALLEN_MCP_CLAUDE_TOOL_NAMES) {
      if (!disabledAllenTools.has(t) && !seen.has(t)) {
        expandedTools.push(t);
        seen.add(t);
      }
    }
    // Caller-supplied list of every registered MCP tool name. Without
    // this, an authored allowlist (e.g. `tools: [Read, Write, Bash]`)
    // hides every mcp__linear__*, mcp__postgres__*, etc. — the agent
    // then says "I don't have Linear API access" even though the MCP
    // is loaded and connected. Inject them so the allowlist becomes
    // "the author's tools + every MCP tool the runtime discovered".
    for (const t of agent.mcpToolNames ?? []) {
      if (typeof t === 'string' && t.startsWith('mcp__') && !seen.has(t)) {
        const [, serverName, ...toolParts] = t.split('__');
        const disabledForServer = agent.disabledMcpTools?.[serverName] ?? [];
        const bareToolName = toolParts.join('__');
        if (disabledForServer.includes(bareToolName)) continue;
        expandedTools.push(t);
        seen.add(t);
      }
    }
    if (expandedTools.some((t) => t.startsWith('mcp__')) && !seen.has(CLAUDE_TOOL_SEARCH)) {
      expandedTools.push(CLAUDE_TOOL_SEARCH);
      seen.add(CLAUDE_TOOL_SEARCH);
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
  return { subagentName, body, tools: expandedTools };
}

/**
 * Write the agent file to ~/.claude/agents/ and return a cleanup handle.
 * Always overwrites. Caller must invoke `cleanup()` in a finally block.
 */
export function writeAgentFile(agent: AgentSpec): MaterializedAgent {
  const { subagentName, body, tools } = renderAgentFile(agent);
  const outDir = resolvePath(homedir(), '.claude', 'agents');
  mkdirSync(outDir, { recursive: true });
  const path = resolvePath(outDir, `${subagentName}.md`);
  writeFileSync(path, body, 'utf8');
  const bodyBuffer = Buffer.from(body, 'utf8');

  return {
    subagentName,
    path,
    sha256: createHash('sha256').update(bodyBuffer).digest('hex'),
    byteLength: bodyBuffer.byteLength,
    containsMandatoryRepoContext: hasMandatoryRepoContext(body),
    tools,
    createdAt: new Date(),
    cleanup() {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Idempotent cleanup — never throw from a finally.
      }
    },
  };
}
