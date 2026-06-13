#!/usr/bin/env node
/**
 * Allen MCP Server
 * Exposes all 16 built-in chat tools as an MCP server (stdio transport).
 * Both Codex CLI and Claude CLI can connect to this as a native MCP server.
 *
 * Usage: node allen-mcp-server.js
 * Env: ALLEN_API_URL      (default: http://localhost:4023)
 *      ALLEN_PUBLIC_URL   (optional — public-facing base URL for artifact links;
 *                          defaults to ALLEN_API_URL when unset)
 */

// This runs as a standalone process — communicates via stdin/stdout JSON-RPC.
// It calls the Allen API (HTTP) to execute tools instead of importing chat-tools.ts directly.
// This way it works without a database connection — just needs the API server running.

import { BRAND_NAME, MCP_SERVER_NAME } from '@allen/engine';

const API_BASE = process.env.ALLEN_API_URL ?? `http://localhost:${process.env.PORT ?? '4023'}`;
const PUBLIC_BASE = process.env.ALLEN_PUBLIC_URL ?? API_BASE;

// Spawn-tree context — passed in by whoever launched this MCP server (a
// workflow node's claude-cli, or an already-spawned agent's claude-cli).
// These are propagated via env because the Claude Code SDK passes parent
// env to its stdio MCP children. When this process invokes `spawn_agent`,
// we forward them to the HTTP endpoint so chat-tools can record
// parent/root linkage on the newly-created execution row.
const SPAWN_PARENT_EXECUTION_ID = process.env.ALLEN_PARENT_EXECUTION_ID || undefined;
const SPAWN_ARTIFACT_ROOT_TYPE = process.env.ALLEN_ARTIFACT_ROOT_TYPE || undefined;
const SPAWN_ARTIFACT_ROOT_ID = process.env.ALLEN_ARTIFACT_ROOT_ID || undefined;
const SPAWN_PARENT_CALLER = process.env.ALLEN_PARENT_CALLER || undefined;
const SPAWN_ROOT_EXECUTION_ID = process.env.ALLEN_ROOT_EXECUTION_ID || undefined;
const REPO_KNOWLEDGE_PACKET_ID = process.env.ALLEN_REPO_KNOWLEDGE_PACKET_ID || undefined;
const REPO_KNOWLEDGE_REPO_ID = process.env.ALLEN_REPO_KNOWLEDGE_REPO_ID || undefined;
const REPO_KNOWLEDGE_INDEX_ID = process.env.ALLEN_REPO_KNOWLEDGE_INDEX_ID || undefined;
const REPO_KNOWLEDGE_REPO_NAME = process.env.ALLEN_REPO_KNOWLEDGE_REPO_NAME || undefined;
const REPO_KNOWLEDGE_FRESHNESS = process.env.ALLEN_REPO_KNOWLEDGE_FRESHNESS || undefined;
// Session-scope markers. These are attached as headers on outbound
// /api/chat/* calls so the server can route tools to the correct chat /
// spawn-execution context. Set by whoever spawned this MCP subprocess:
//   chat-llm.ts        → ALLEN_CHAT_SESSION_ID for main-chat agents
//   chat-tools.ts      → same for spawn subprocesses rooted
//                        in a chat (omitted for workflow-rooted spawns)
const SPAWN_CHAT_SESSION_ID = process.env.ALLEN_CHAT_SESSION_ID || undefined;

// ── Auth: mint a short-lived JWT using the shared secret ──
// The MCP server runs as a child process of the main server and shares
// JWT_ACCESS_SECRET via env. We mint a system-admin token on demand and
// cache it for a few minutes to avoid re-signing on every call.

import jwt, { type SignOptions } from 'jsonwebtoken';
import { parseAllenApiResponse } from './mcp-api-response.js';

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;

interface CachedToken {
  token: string;
  expiresAt: number;
}
let cached: CachedToken | null = null;

function getAuthToken(): string | null {
  if (!JWT_ACCESS_SECRET) return null;
  const now = Date.now();
  if (cached && cached.expiresAt - now > 30_000) return cached.token;
  const token = jwt.sign(
    {
      sub: 'mcp-system',
      email: 'mcp@internal.local',
      role: 'admin',
      mustResetPassword: false,
    },
    JWT_ACCESS_SECRET,
    { expiresIn: '1h' } as SignOptions,
  );
  cached = { token, expiresAt: now + 60 * 60 * 1000 };
  return token;
}

// Wrap the global fetch so every call made from this module — including
// the many ad-hoc fetch(...) calls in executeTool — automatically carries
// the Authorization header when talking to the Allen API.
type FetchInput = Parameters<typeof fetch>[0];
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  if (!url.startsWith(API_BASE)) {
    return originalFetch(input, init);
  }
  const token = getAuthToken();
  if (!token) {
    return originalFetch(input, init);
  }
  const mergedHeaders = new Headers(init?.headers);
  if (!mergedHeaders.has('Authorization')) {
    mergedHeaders.set('Authorization', `Bearer ${token}`);
  }
  // Attach context markers so the server-side tool dispatcher can match
  // this MCP's calls to the exact chat session / spawn execution that
  // owns this subprocess. These are always safe to include (server ignores them for
  // non-chat routes) and only one will be truthy at a time in practice.
  if (SPAWN_CHAT_SESSION_ID && !mergedHeaders.has('x-allen-chat-session-id')) {
    mergedHeaders.set('x-allen-chat-session-id', SPAWN_CHAT_SESSION_ID);
  }
  if (SPAWN_PARENT_EXECUTION_ID && !mergedHeaders.has('x-allen-parent-execution-id')) {
    mergedHeaders.set('x-allen-parent-execution-id', SPAWN_PARENT_EXECUTION_ID);
  }
  if (SPAWN_ROOT_EXECUTION_ID && !mergedHeaders.has('x-allen-root-execution-id')) {
    mergedHeaders.set('x-allen-root-execution-id', SPAWN_ROOT_EXECUTION_ID);
  }
  return originalFetch(input, { ...init, headers: mergedHeaders });
};

// ── Helpers ──

function pathSegment(value: unknown): string {
  return encodeURIComponent(String(value));
}

/**
 * Map a parameter description string to its JSON Schema type.
 * The TOOLS array uses prose descriptions like "boolean (required) — must be true";
 * we look at the first word to pick the right JSON type.
 *
 * Without 'boolean' support, claude-cli would coerce booleans to strings and
 * the model would send `confirm: "true"` instead of `confirm: true` — failing
 * strict equality checks server-side.
 */
function paramJsonType(desc: string): string {
  if (typeof desc !== 'string') return 'string';
  const lower = desc.toLowerCase();
  if (lower.startsWith('object') || lower.startsWith('array')) return 'object';
  if (lower.startsWith('number') || lower.startsWith('integer')) return 'number';
  if (lower.startsWith('boolean') || lower.startsWith('bool')) return 'boolean';
  return 'string';
}

// ── Tool Definitions ──

const TOOLS = [
  // ── Assistant routing skills ──
  { name: 'list_skills', description: 'List all available Allen Library routing skills with lightweight metadata only. Use this first for non-trivial Allen-supported requests, choose the best skill from metadata by user intent, then call get_skill for the selected playbook.', params: { include_disabled: 'boolean — include disabled skills; default false' } },
  { name: 'search_skills', description: 'Optional ranking hint for Allen Library routing skills. Do not treat the top score as the final decision; review list_skills metadata and choose by user intent before calling get_skill.', params: { query: 'string (required) — user request or routing question', context: 'object — optional context such as intent, repo, currentPage, prUrl, ticketId, executionId', limit: 'number — max skills to return, default 5', include_disabled: 'boolean — include disabled skills; default false' } },
  { name: 'get_skill', description: 'Get the full routing/playbook instructions for one Allen Library skill. Use after selecting the best skill from list_skills metadata by user intent.', params: { name: 'string — skill slug', id: 'string — skill MongoDB _id; use name OR id' } },
  { name: 'update_skill', description: 'Update an existing Allen Library skill. Supports partial updates — only the fields you provide are changed. Resolve skill by id or name.', params: { id: 'string — skill MongoDB _id', name: 'string — skill slug (used when id is omitted)', new_name: 'string — new name slug (renames the skill)', displayName: 'string', description: 'string', category: 'string', triggers: 'array of strings', excludes: 'array of strings', priority: 'number', enabled: 'boolean', allowedRoutes: 'array of strings', relatedWorkflows: 'array of strings', relatedAgents: 'array of strings', body: 'string', tags: 'array of strings' } },

  // ── Workflows ──
  { name: 'list_workflows', description: 'List all workflows with name, description, node count, validation status.', params: {} },
  { name: 'get_workflow', description: 'Get full details of a specific workflow: YAML source, parsed nodes, edges, input schema, version.', params: { name: 'string — workflow name', id: 'string — workflow MongoDB _id (use name OR id)' } },
  { name: 'run_workflow', description: 'Start executing a workflow. Returns execution ID. Before calling this, call get_workflow for the chosen workflow and pass input using the exact parsed.input field names for that workflow. Do not invent aliases or nested shapes.', params: { workflow_name: 'string (required)', input: 'object — workflow input parameters matching get_workflow.parsed.input exactly' } },
  { name: 'validate_workflow', description: 'Validate a workflow YAML or parsed object against the live agent registry. Returns { valid, errors, warnings }. Read-only.', params: { yaml: 'string — YAML source', parsed: 'object — parsed workflow object (alternative to yaml)' } },
  { name: 'create_workflow', description: 'Create a new workflow. Validates before persisting. Usable immediately after creation.', params: { yaml: 'string — YAML source (preferred)', parsed: 'object — parsed workflow object (alternative)', tags: 'object — optional tags array' } },
  { name: 'update_workflow', description: 'Update an existing workflow by name or id. Bumps version. Refuses system-seeded workflows.', params: { id: 'string — MongoDB ObjectId', name: 'string — workflow name (used when id omitted)', yaml: 'string — new YAML source', parsed: 'object — new parsed workflow object' } },

  // ── Executions ──
  { name: 'wait_for_execution', description: 'Poll an execution until it completes. Blocks up to 90s. Returns response when done. If status="waiting", call again. Returns recent_activity, activity_summary, progress_message, top_logs, and activity_cursor so callers can report useful progress while work is still running.', params: { execution_id: 'string (required)', activity_since: 'string — ISO timestamp cursor from prior activity_cursor' } },
  { name: 'list_executions', description: 'List recent executions. Filter by status or workflow name.', params: { status: 'string', workflow_name: 'string', limit: 'number' } },
  { name: 'search_executions', description: 'Search executions with filters: date range, cost, failed nodes.', params: { workflow_name: 'string', status: 'string', since_hours: 'number', min_cost: 'number', has_failed_node: 'boolean', limit: 'number' } },
  { name: 'cancel_execution', description: 'Cancel a running execution.', params: { execution_id: 'string (required)' } },
  { name: 'resume_execution', description: 'Resume a cancelled/failed/completed execution after the user explicitly chooses resume. Agents/team leads resume their prior session when possible; workflows resume from a checkpoint.', params: { execution_id: 'string (required)', prompt: 'string — follow-up prompt for agent resumes', checkpoint_id: 'string — workflow checkpoint id, latest used if omitted' } },
  { name: 'submit_execution_input', description: 'Submit input to a paused workflow execution (e.g. answer a human node).', params: { execution_id: 'string (required)', node: 'string (required)', data: 'object (required)' } },
  { name: 'get_node_trace', description: 'Get detailed trace of a specific node execution: prompt, response, outputs, cost, duration.', params: { execution_id: 'string (required)', node_name: 'string (required)' } },
  { name: 'get_execution_logs', description: 'Get execution logs filtered by node, level, or category.', params: { execution_id: 'string (required)', node: 'string', level: 'string', category: 'string', limit: 'number' } },
  { name: 'get_node_context_usage', description: 'Get repo context packets and usage traces captured for an execution. Optional view can be full, summary, or normalized; default remains full for compatibility.', params: { execution_id: 'string (required)', view: 'string — optional full|summary|normalized', include: 'object — optional include flags array', refresh: 'boolean — bypass server cache' } },
  { name: 'context_quality_get_usage_trace', description: 'Unified context usage trace lookup. Resolves context trace data by executionId, contextAttemptId, OR chat session id and returns normalized identifiers { sourceId, executionId, contextAttemptId, sourceKind, flowKind } plus matchingContextAttempts/injection metadata. Fixes the gap where context_usage_trace pending candidates expose contextAttemptId but get_node_context_usage requires executionId.', params: { execution_id: 'string — workflow/agent execution id (provide this OR context_attempt_id OR session_id)', context_attempt_id: 'string — context attempt id from scheduler pending candidates (provide this OR execution_id OR session_id)', session_id: 'string — chat session id for chat_agent/chat_turn attempts' } },
  { name: 'context_quality_replay_usage_trace', description: 'Read-only retrieval replay for remediation planning. Reconstructs the captured production context selection envelope for a contextAttemptId/executionId/sessionId and maps Cognee refs back to curated DB entries. Returns candidateRefs, selectedRefs, injectedRefs, rejectedRefs, skippedBudgetRefs, curatedEntryMatches, matchingContextAttempts, and replayId.', params: { execution_id: 'string — workflow/agent execution id (provide this OR context_attempt_id OR session_id)', context_attempt_id: 'string — context attempt id from scheduler pending candidates (provide this OR execution_id OR session_id)', session_id: 'string — chat session id for chat_agent/chat_turn attempts' } },
  { name: 'context_quality_get_attempt_evidence', description: 'Get a complete evidence bundle for one assigned context attempt without rebuilding full execution-level context usage.', params: { context_attempt_id: 'string (required)' } },
  { name: 'context_quality_get_attempt_evidence_batch', description: 'Get evidence bundles for multiple assigned context attempts without rebuilding full execution-level context usage.', params: { context_attempt_ids: 'object — array of context attempt IDs (required)' } },

  // ── Agents ──
  { name: 'list_agents', description: 'List all agents with minimal info: name, displayName, teamName, type, model, provider. Use get_agent for full details.', params: {} },
  { name: 'get_agent', description: 'Get full details of a specific agent: system prompt, tools, capabilities, model, provider, spawnTargets, personality, description.', params: { name: 'string (required) — agent slug' } },
  { name: 'create_agent', description: 'Create a new agent in a team. Team must exist. The agent slug must be unique system-wide.', params: { name: 'string (required) — lowercase slug', displayName: 'string (required)', description: 'string — short description of what the agent does', teamName: 'string (required) — existing team slug', teamRole: 'string (required) — "lead" or "member"', system: 'string (required) — full system prompt', provider: 'string (required) — "claude" or "codex"', model: 'string', tools: 'object — array of tool names', capabilities: 'object — array of capability tags', spawnTargets: 'object — array of agent names this agent can spawn', personality: 'string', icon: 'string', color: 'string' } },
  { name: 'update_agent', description: 'Update an agent: system prompt, model, provider, tools, capabilities, spawnTargets, personality, displayName, description.', params: { name: 'string (required)', displayName: 'string', description: 'string', system: 'string', tools: 'object', capabilities: 'object', spawnTargets: 'object — array of agent names this agent can spawn', personality: 'string', model: 'string', provider: 'string' } },
  { name: 'delete_agent', description: 'Delete an agent. Refuses built-in agents and team leads. Requires confirm=true.', params: { name: 'string (required)', confirm: 'boolean (required) — must be true' } },
  { name: 'move_agent_to_team', description: 'Move one or more agents to a different team. Works for any cross-team move including unassigned → team.', params: { agent_names: 'object — array of agent name strings (required)', team_name: 'string (required) — target team slug' } },
  { name: 'spawn_agent', description: 'Spawn an agent in the background. Returns immediately with execution_id. Pass context_query as structured retrieval-only metadata; do not embed context query XML/JSON in prompt.', params: { agent_name: 'string (required)', prompt: 'string (required)', context_query: 'object — optional structured retrieval query, not sent to the agent prompt', repo_path: 'string — optional repo path', session_id: 'string — session ID from previous spawn to resume' } },

  // ── Teams ──
  { name: 'list_teams', description: 'List all teams: name, displayName, mission, lead, parent, isBuiltIn.', params: {} },
  { name: 'get_team', description: 'Get a team\'s metadata and member list (names + roles, without system prompts). Use get_team_blueprint for the deep view.', params: { name: 'string (required) — team slug' } },
  { name: 'get_team_blueprint', description: 'Full team blueprint: metadata and all members WITH system prompts. Use before adding agents.', params: { team_name: 'string (required) — team slug' } },
  { name: 'list_team_members', description: 'List agents in a team with name, displayName, teamRole, capabilities, tools, spawnTargets.', params: { team_name: 'string (required) — team slug' } },
  { name: 'create_team', description: 'Create a team. Lead agent must exist first (call create_agent for the lead first).', params: { name: 'string (required) — lowercase slug', displayName: 'string (required)', description: 'string', mission: 'string', leadAgentName: 'string (required) — lead agent name', parentTeamName: 'string — optional parent team' } },
  { name: 'update_team', description: 'Update a team\'s displayName, description, mission, or parent. Built-in teams cannot be updated.', params: { name: 'string (required)', displayName: 'string', description: 'string', mission: 'string', parentTeamName: 'string' } },
  { name: 'delete_team', description: 'Delete a team. Refuses if it has members. Requires confirm=true.', params: { name: 'string (required)', confirm: 'boolean (required) — must be true' } },

  // ── Repos ──
  { name: 'list_repos', description: 'List registered repositories with tech stack.', params: {} },
  { name: 'get_repo_context', description: 'Get the deep agent-generated context document for a repo (markdown describing each module).', params: { repo_path: 'string (required) — absolute path of a registered repo or workspace worktree' } },
  { name: 'get_repo_skill_body', description: 'Load the full body of a repo skill file by repo-relative skill_path. Use when selected context points to a useful skill; summaries are only a relevance filter and must not be the only source for useful skills.', params: { repo_path: 'string (required) — absolute path of a registered repo or workspace worktree', ref_id: 'string — selected provider refId for audit only', skill_path: 'string — repo-relative SKILL.md path' } },
  { name: 'get_repo_context_body', description: 'Load the full body of a repo instruction, context, doc, runbook, production knowledge file, or selected Cognee ref. Use selected Cognee ref_id or a repo-relative context_path; summaries are only a relevance filter and must not be the only source for useful context.', params: { repo_path: 'string (required) — absolute path of a registered repo or workspace worktree', ref_id: 'string — selected Cognee refId', context_path: 'string — repo-relative file path alternative to ref_id' } },
  { name: 'prepare_repo_context_curation', description: 'Prepare an idempotent repo-context-curator run. The service inventories context files from the specified branch (or the repo\'s detected default branch), compares hashes with DB, returns only missing/changed/retry files, budgets, and a staging run id.', params: { repo_id: 'string — registered repo id', repo_path: 'string — registered repo path alternative to repo_id', branch: 'string — optional branch name to curate (e.g. "context/knowledge-docs-curation-branch-tfsvp1"); defaults to the repo\'s detected default branch', git_ref: 'string — alias for branch', scope: 'object — optional {mode, pattern, force}; mode can be all/documents/docs or a path hint', force: 'boolean — recurate scoped files even when hashes match' } },
  { name: 'plan_repo_context_curation_assignments', description: 'Create and register deterministic worker assignment batches for a prepared repo context curation run. Use this before spawning repo-context-curation-worker agents; it avoids huge files_to_curate payloads and returns ready-to-spawn assignments plus a concurrency limit hard-capped at 4.', params: { run_id: 'string (required)', register: 'boolean — default true; registers returned assignments idempotently', include_all: 'boolean — optional; use all expected files instead of current retry files', max_files_per_assignment: 'number — optional batch file cap; default 20', max_bytes_per_assignment: 'number — optional batch byte cap; default 350000', concurrency_limit: 'number — optional visible worker concurrency cap; hard max 4' } },
  { name: 'register_repo_context_curation_assignments', description: 'Register worker assignments for a prepared repo context curation run before spawning workers. Idempotent by assignment id.', params: { run_id: 'string (required)', assignments: 'array of {assignmentId, workerId, files}' } },
  { name: 'get_repo_context_curation_stage_status', description: 'Validate staged repo context curation rows and return missing/invalid/retry files. Call after workers finish and before promotion.', params: { run_id: 'string (required)' } },
  { name: 'promote_repo_context_curation_stage', description: 'Promote a fully validated temporary repo context curation run into final DB collections visible in UI. Fails if any expected file is missing or invalid.', params: { run_id: 'string (required)' } },
  { name: 'save_repo_mandatory_context_mappings', description: 'Save agent-specific mandatory repo context mappings into Allen DB. Use only from repo-mandatory-context-mapper; this writes always-injected context for exact Allen agent names.', params: { repo_id: 'string (required)', mappings: 'array of {agentName, sourcePath, sourceHash, title, content, reasoning, enabled}' } },
  { name: 'save_repo_mandatory_context_mapping_proposal', description: 'Stage a mandatory context mapping proposal during a repo context setup run. Use only from repo-mandatory-context-mapper. Does NOT write to repo_mandatory_context_mappings directly — the orchestrator consumes the proposal atomically. Two-step protocol (PREFERRED — large single payloads can hang the CLI): as you draft, call with mode: "stage" and batches of AT MOST 10 mappings (staged rows persist server-side and are upserted by (setup_run_id, agentName, title[, sourcePath]), so re-staging is safe); when every mapping is staged, call once with mode: "finalize" plus affected_agent_names and expected_mapping_count (no mappings) to assemble the proposal. Omitting mode sends the legacy whole-packet body in one call.', params: { repo_id: 'string (required)', setup_run_id: 'string (required)', mode: 'string — "stage" | "finalize"; omit for the legacy whole-packet save', affected_agent_names: 'string[] (required unless mode is "stage") — agents reviewed by the mapper', mappings: 'array — required for mode "stage" (≤10 per call) and the legacy save; each: {agentName, sourcePath, sourceHash, title, content, reasoning}', expected_mapping_count: 'number (required for mode "finalize") — total staged mappings the proposal must contain' } },
  { name: 'find_repo_for_pr_url', description: 'Given a GitHub PR URL, find the registered Allen repo whose remote matches (owner/repo). Returns null if the repo is not registered.', params: { pr_url: 'string (required) — https://github.com/<owner>/<repo>/pull/<n>' } },

  // ── Pull Requests ──
  { name: 'find_pr_by_url', description: 'Look up a pull_requests row by full PR URL. Returns the stored metadata (workspaceId, originatingExecutionId, processedCommentIds, resolutionAttempts, …) or null.', params: { pr_url: 'string (required)' } },
  { name: 'mark_pr_synced', description: 'Stamp a pull_requests row with a completed CodeRabbit-resolution round. Appends processedCommentIds, increments resolutionAttempts, records lastReviewedHeadSha.', params: { pr_id: 'string (required) — pull_requests _id', head_sha: 'string (required)', processed_comment_ids: 'object — array of GH comment id strings that were applied' } },

  // ── Workspaces ──
  { name: 'get_workspace', description: 'Fetch a workspace row by id. Returns worktreePath, branch, baseBranch, status, repoId, prUrl, services, and more.', params: { workspace_id: 'string (required) — workspaces _id' } },
  { name: 'create_workspace_for_pr', description: 'Create a fresh workspace from a PR branch (Flow B). Used when a PR has no linked workspace. Polls until setup completes. Returns { workspace_id, worktree_path, branch, base_branch }.', params: { pr_url: 'string (required)', repo_id: 'string (required)', branch: 'string (required) — PR head branch', base_branch: 'string (required) — PR base branch', pr_number: 'number (required)', pr_title: 'string — optional display name' } },
  { name: 'create_workspace', description: 'Create an isolated git worktree from a registered repo, on a new branch off the base branch. Use this whenever code changes are needed — every specialist agent you spawn must work inside this worktree. Returns { workspace_id, worktree_path, branch, base_branch }. Engineering-lead orchestrators are the expected caller; never call this from a worker/specialist agent.', params: { repo_path: 'string (required) — absolute path of a registered repo or an existing worktree whose repo will be used as the base', branch_prefix: 'string — short label prepended to the generated branch (e.g. "feature", "fix"). Default: "feature".', task_summary: 'string — one-line intent used inside the generated branch name for human readability', base_branch: 'string — branch to cut from. Defaults to the repo\'s detected default branch (captured at scan time); falls back to "main" only if the repo record has no defaultBranch. Pass this explicitly only when you need to cut from a non-default branch.' } },

  // ── Communication ──
  { name: 'ask_user', description: 'Ask the user a question directly. Blocks until they answer. Only use when no agent can help.', params: { question: 'string (required)' } },
  { name: 'report_to_user', description: 'Send a progress update to the user during a long-running chat, workflow, or spawned-agent run.', params: { message: 'string (required)', status: 'string — in_progress | completed | needs_input' } },

  // ── Self-introspection ──
  { name: 'get_my_session_history', description: 'Get your own chat session message history. Use to re-read the user\'s original request or see your prior responses.', params: { limit: 'number — max messages (default 30, max 100)' } },

  // ── Chat conversation tracing (arbitrary sessions) ──
  //
  // Use these to diagnose "why did this chat behave the way it did?" for
  // any chat session by id — not just your own. The four collections below
  // together tell the full story:
  //   chat_sessions       → provider, model, activeAgent, agentOverrides
  //   chat_messages       → full user/assistant/tool turns + persisted toolCalls
  //   chat_logs           → per-turn trace: provider, model, trace, cost, duration, status
  { name: 'get_chat_session', description: 'Get chat session metadata for any session id: provider, model, activeAgent, agentOverrides, llmSessionId, userId, createdAt. Use to answer "which provider/model is this chat configured for?".', params: { session_id: 'string (required) — chat_sessions _id' } },
  { name: 'get_chat_messages', description: 'Paginated read of the chat_messages collection for a session. Returns user + assistant turns, including persisted toolCalls on assistant rows. Pass before=<timestamp|id> to page backward.', params: { session_id: 'string (required)', limit: 'number — max messages per page (default 50, max 200)', before: 'string — cursor for older pages' } },
  { name: 'get_chat_logs', description: 'Read the chat_logs collection for a session (full per-turn trace: provider, model, trace, toolCalls, cost, duration, status). Newest-first ordering, then reversed to chronological on return.', params: { session_id: 'string (required)', limit: 'number — max logs (default 50, max 200)' } },
  { name: 'get_chat_log', description: 'Drill into one chat_log row by its Mongo _id. Full trace/toolCalls/prompt, not truncated. Pair with get_chat_logs to locate the id.', params: { log_id: 'string (required) — chat_logs _id' } },

  // ── Self-healing monitoring evidence + incident state ──
  { name: 'allen_monitoring_get_scan_cursor', description: 'Read the self-healing monitoring cursor. Use before planning an hourly scan window.', params: { name: 'string — cursor name, default hourly-agent' } },
  { name: 'allen_monitoring_update_scan_cursor', description: 'Update the self-healing monitoring cursor after the agent-led scan completes.', params: { name: 'string — cursor name', last_successful_scan_at: 'string — ISO timestamp', execution_id: 'string', summary: 'string' } },
  { name: 'allen_monitoring_search_records', description: 'Search redacted raw Allen runtime records for evidence collection. The agent decides what is wrong; this tool only fetches records.', params: { surface: 'string (required) — chat_sessions, chat_messages, chat_logs, agent_conversations, agent_activity, executions, execution_logs, execution_traces, memory_injection_audits, learnings, ticket_assignments, monitoring_events, monitoring_incidents', since: 'string — ISO lower bound', until: 'string — ISO upper bound', statuses: 'object — array of status strings', root_id: 'string — execution/session/incident id', text: 'string — text search', limit: 'number — max 100', exclude_successful_with_error_mode: 'boolean — when true and surface=chat_logs, exclude completed sessions that have a non-null failureMode (false positives)' } },
  { name: 'allen_monitoring_get_record', description: 'Fetch one full redacted runtime record by surface and id.', params: { surface: 'string (required)', id: 'string (required)' } },
  { name: 'allen_monitoring_create_evidence_bundle', description: 'Persist the evidence bundle the monitoring agent reviewed.', params: { title: 'string (required)', summary: 'string (required)', record_refs: 'object — array of {surface,id,reason}', evidence: 'object — curated evidence', scan_window: 'object' } },
  { name: 'allen_monitoring_search_incidents', description: 'Search existing monitoring incidents for dedupe and follow-up decisions.', params: { status: 'string', root_cause_area: 'string', source_type: 'string', text: 'string', linear_issue_id: 'string', limit: 'number' } },
  { name: 'allen_monitoring_upsert_incident', description: 'Create or update a monitoring incident from the agent decision. Does not create Linear tickets. Returns error if DB write had no effect. Severity: critical=service-down/data-loss, high=degraded-production, medium=isolated-failures, low=minor-impact. Confidence: 0.9+=multiple-corroborating-sources, 0.7-0.9=strong-evidence, 0.5-0.7=moderate, <0.5=noise/needs-more-data.', params: { fingerprint: 'string', title: 'string (required)', summary: 'string (required)', source_type: 'string (required)', root_cause_area: 'string (required)', severity: 'string (required)', confidence: 'number (required)', status: 'string', related_ids: 'object', evidence: 'object', evidence_bundle_id: 'string', agent_decision: 'object' } },
  { name: 'allen_monitoring_update_incident', description: 'Update a monitoring incident after Linear ticketing, routing, bug-fix dispatch, suppression, or resolution.', params: { incident_id: 'string (required)', status: 'string', linear_issue_id: 'string', linear_identifier: 'string', linear_url: 'string', routing_target: 'object', dispatch_execution_id: 'string', agent_decision: 'object', evidence_patch: 'object' } },
  { name: 'allen_monitoring_resolve_repo_path', description: 'Resolve the Allen repo path to pass into bug-fix-by-severity for self-healing incidents.', params: {} },

  // ── Context Quality / Judge ──
  { name: 'context_quality_trigger_orchestrator', description: 'Trigger the context judge orchestrator to start a new evaluation run. Returns a run record with runId. Pass repoId for repo-scoped runs, global=true for global runs.', params: { repoId: 'string — optional repo id for scoped run', repoIds: 'object — optional array of repo ids', global: 'boolean — default true when no repoId supplied', triggeredBy: 'string — "ui" | "api" | "scheduler" | "manual"' } },
  { name: 'context_quality_begin_session', description: 'Begin an orchestration session for the context judge agent. Returns sessionId used in all subsequent calls. In dry_run=true mode, findings are NOT persisted to DB. runScope reflects which repos were evaluated (inferred from repoId when not provided). Captures a trace backlog snapshot and optional rootExecutionId for repair/resume and self-trace exclusion.', params: { scope: 'string (required) — "workflow"|"node"|"chat_turn"|"spawned_agent"|"learning"|"cross_repo"|"global"|"user_preference"', runScope: 'string — "repo"|"multi_repo"|"global" (inferred from repoId when not provided)', sourceId: 'string', sourceKind: 'string', repoId: 'string', rootExecutionId: 'string — root execution id for this orchestrator run', agentModel: 'string', agentProvider: 'string', agentRationale: 'string', dry_run: 'boolean — artifact-only mode, no DB writes' } },
  { name: 'context_quality_log_decision', description: 'Log an agent reasoning step to the orchestration session audit trail.', params: { session_id: 'string (required)', kind: 'string (required) — "discovery"|"classification"|"routing"|"gate_check"|"summary"', detail: 'string (required)', metadata: 'object' } },
  { name: 'context_quality_submit_findings', description: 'Submit classified findings for a session. Persists to DB in production mode, artifact-only in dry_run mode. Returns { judgeRunId, findingIds, reviewTaskIds, dryRun? }. Each finding may include impactScope (separate from run scope), primarySourceId, executionId, contextAttemptId for source traceability. Human gates use impactScope — a repo run can produce cross_repo/global findings.', params: { session_id: 'string (required)', findings: 'object (required) — array of {classification,fixType,severity,risk,confidence,impactScope?,primarySourceId?,executionId?,contextAttemptId?,sourceRefs?,evidence?,suggestedRemediation?,learningId?}' } },
  { name: 'context_quality_finalize_session', description: 'Finalize session. Returns DB-derived summary (dbSummary.dbDerivedFindingCount etc). Check these counts — if 0 but findings were submitted, DB writes failed.', params: { session_id: 'string (required)', summary: 'string' } },
  { name: 'context_quality_get_session', description: 'Get current state of an orchestration session, including live DB-derived summary and stage state.', params: { session_id: 'string (required)' } },
  { name: 'context_quality_get_stage_state', description: 'Get DB-derived context judge stage state and next required stage for a session.', params: { session_id: 'string (required)' } },
  { name: 'context_quality_get_repair_state', description: 'Repair/resume helper. Given session_id or root_execution_id/execution_id, returns completed work, unresolved traces, findings lacking remediation mappings, and next required stage.', params: { session_id: 'string', root_execution_id: 'string', execution_id: 'string' } },
  { name: 'context_quality_list_pending', description: 'Discover unevaluated sources. Use limit=20 for batching. Always use this for source discovery, not raw DB queries. Candidates are returned newest-first. Set allowBackfill=true to ignore the cursor and discover older unevaluated sources (repair/backfill mode).', params: { sourceType: 'string (required) — "workflow_run"|"spawned_agent_run"|"chat_turn"|"context_usage_trace"|"deterministic_warning"|"human_feedback"|"chat_learning"|"stale_finding"', limit: 'number — max 50', repoId: 'string', repoIds: 'object', allowBackfill: 'boolean — ignore cursor, discover older unevaluated sources' } },
  { name: 'context_quality_list_findings', description: 'List context findings with filters.', params: { judgeRunId: 'string', scope: 'string', status: 'string', limit: 'number — max 100', offset: 'number' } },
  { name: 'context_quality_log_source_evaluation', description: 'Log a durable source evaluation outcome to the context_source_evaluations ledger. Call this for EVERY evaluated source — both finding_created and no_issue/skipped outcomes. This enables the scheduler to skip already-evaluated sources on future runs. REST: POST /api/context/quality/source-evaluations. Alias for context_quality_submit_source_evaluation — use that for enhanced fields.', params: { session_id: 'string (required)', source_type: 'string (required) — e.g. "context_usage_trace"|"workflow_run"|"chat_turn"', source_id: 'string (required)', decision: 'string (required) — "finding_created"|"no_issue"|"skipped"|"error"', judge_run_id: 'string', repo_id: 'string', context_attempt_id: 'string', execution_id: 'string', flow_kind: 'string', reason: 'string', finding_ids: 'object — array of findingIds (for finding_created)', status: 'string — "completed"|"failed"|"retryable" (default: completed)' } },
  { name: 'context_quality_submit_source_evaluation', description: 'Submit a durable source evaluation with all enhanced ENG-1760 fields including workerAssignmentId, contextVerdict, contextCorrect, evidence, severity, risk, and remediation hints. Use this instead of context_quality_log_source_evaluation for trace-analysis worker results. REST: POST /api/context/quality/source-evaluations/submit.', params: { session_id: 'string (required)', source_type: 'string (required) — e.g. "context_usage_trace"|"workflow_run"', source_id: 'string (required)', decision: 'string (required) — "finding_created"|"no_issue"|"skipped"|"error"', judge_run_id: 'string', repo_id: 'string', source_kind: 'string', context_attempt_id: 'string', execution_id: 'string', flow_kind: 'string', worker_assignment_id: 'string — trace analysis assignment this evaluation belongs to', status: 'string — "completed"|"failed"|"retryable" (default: completed)', reason: 'string', classification: 'string', fix_type: 'string', confidence: 'number', risk: 'string — "low"|"medium"|"high"|"critical"', severity: 'string — "info"|"warn"|"error"|"critical"', finding_ids: 'object — array of findingIds', context_verdict: 'string — "correct"|"wrong"|"incomplete"|"missing"|"not_needed"|"unjudgeable"', context_correct: 'boolean — was the injected context correct/sufficient?', context_incomplete: 'boolean', context_irrelevant: 'boolean', mandatory_missing: 'boolean', mandatory_incorrect: 'boolean', over_filtered: 'boolean', over_injected: 'boolean', wrong_scope: 'boolean', stale_context: 'boolean', affected_ref_ids: 'object — array of refIds', expected_context_kinds: 'object — array of strings', remediation_hints: 'object — array of strings', evidence: 'object — array of {kind, refId?, snippet?, score?, label?}', notes: 'string — free-text evaluation notes', evidence_summary: 'object', evaluation_version: 'number' } },
  { name: 'context_quality_list_unevaluated_traces', description: 'List unevaluated context_usage_trace candidates for the exhaustive trace evaluation orchestrator. Returns traces NOT yet in context_source_evaluations (completed) AND NOT in active context_trace_analysis_assignments (non-failed). Excludes judge self-traces when session/root filters are supplied. Limit is capped at 20. REST: GET /api/context/quality/scheduler/unevaluated-traces.', params: { repo_id: 'string — optional repo filter', session_id: 'string — optional session filter', limit: 'number — max 20 (default 20)', cursor: 'string — last contextAttemptId from previous page (exclusive lower bound)', exclude_root_execution_id: 'string', exclude_execution_ids: 'object — array of execution ids to exclude', exclude_agent_names: 'object — array of agent names to exclude' } },
  { name: 'context_quality_create_trace_analysis_assignment', description: 'Register a batch of context_usage_trace candidates as a single trace analysis assignment. One assignment = one worker batch = at most 20 contextAttemptIds. Workers call this before starting evaluation to prevent duplicate assignment. Pass retryOfAssignmentId when replacing a failed assignment. REST: POST /api/context/quality/trace-analysis-assignments.', params: { session_id: 'string (required)', source_ids: 'object (required) — array of contextAttemptIds (max 20)', repo_id: 'string', worker_agent_name: 'string', retry_of_assignment_id: 'string — failed assignment being retried' } },
  { name: 'context_quality_create_trace_analysis_wave', description: 'Create the next parallel trace-analysis wave. Returns up to 4 non-overlapping context_trace_analysis_assignments, each with up to 20 contextAttemptIds. Orchestrator must spawn all returned assignments before waiting. REST: POST /api/context/quality/trace-analysis-assignments/wave.', params: { session_id: 'string (required)', repo_id: 'string — optional repo filter', max_assignments: 'number — default 4, hard max 4', limit_per_assignment: 'number — default 20, hard max 20', exclude_root_execution_id: 'string', exclude_execution_ids: 'object — array of execution ids to exclude', exclude_agent_names: 'object — array of agent names to exclude' } },
  { name: 'context_quality_list_trace_analysis_assignments', description: 'List trace analysis assignments for a session with optional status filter. REST: GET /api/context/quality/trace-analysis-assignments.', params: { session_id: 'string', status: 'string — "queued"|"running"|"completed"|"failed"', limit: 'number', offset: 'number' } },
  { name: 'context_quality_get_trace_analysis_assignment', description: 'Get a single trace analysis assignment by ID. REST: GET /api/context/quality/trace-analysis-assignments/:assignmentId.', params: { assignment_id: 'string (required)' } },
  { name: 'context_quality_update_trace_analysis_assignment', description: 'Update trace analysis assignment lifecycle. Workers call this: status="running" when starting, "completed"/"failed" when done. Also updates evaluatedCount, skippedCount, failedCount, findingCount, terminalReason. REST: PATCH /api/context/quality/trace-analysis-assignments/:assignmentId.', params: { assignment_id: 'string (required)', status: 'string — "queued"|"running"|"completed"|"failed"', worker_execution_id: 'string', worker_agent_name: 'string', evaluated_count: 'number', skipped_count: 'number', failed_count: 'number', finding_count: 'number', error: 'string', terminal_reason: 'string — completed|failed_unretried|retried|self_trace_ignored|cancelled' } },
  { name: 'context_quality_list_source_evaluations', description: 'List source evaluation records for a session. REST: GET /api/context/quality/source-evaluations.', params: { session_id: 'string (required)', source_type: 'string — filter by source type', decision: 'string — filter by decision', limit: 'number' } },
  { name: 'context_quality_update_worker_assignment', description: 'Update worker assignment status. Workers MUST call this: status="running" when starting, "completed"/"failed" when done. Include workerRole/agentName when available so assignment ownership cannot be overwritten by the wrong worker type.', params: { assignment_id: 'string (required)', status: 'string (required) — "running"|"completed"|"failed"', notes: 'string', result: 'object', agentRunId: 'string', agentExecutionId: 'string', workerRole: 'string', agentName: 'string' } },
  { name: 'context_quality_create_worker_assignment', description: 'Create worker assignment(s) for auto-remediatable review tasks. Curation fixes are grouped by target entry; one call may return multiple assignments, and same-entry conflicts may be returned as skippedConflicts. In repairMode=true, pass explicit remediationIds to create visible repair assignment(s) for failed/partial remediation rows.', params: { maxBatch: 'number', workerAgentName: 'string', workerRole: 'string', remediationIds: 'object — explicit remediation IDs for repair mode', repairMode: 'boolean', rootExecutionId: 'string', sessionId: 'string' } },
  { name: 'context_quality_patch_finding', description: 'Update a context quality finding — e.g. set status=in_review, add suggestedRemediation. Returns the updated finding. Primary method for review-triage workers; REST fallback: PATCH /api/context/quality/findings/:findingId.', params: { finding_id: 'string (required)', status: 'string — "open"|"in_review"|"resolved"|"dismissed"', suggestedRemediation: 'string' } },
  { name: 'context_quality_list_remediation_tasks', description: 'List remediation records for fix/QA workers or repair reporting. REST: GET /api/context/quality/remediation-tasks.', params: { taskId: 'string', remediationId: 'string', workerRole: 'string', status: 'string', limit: 'number', offset: 'number' } },
  { name: 'context_quality_create_remediation_task', description: 'Create a structured remediation task for an approved finding. REST: POST /api/context/quality/remediation-tasks. Required: taskId, findingId, judgeRunId, actionKind. fixType is also accepted as an alias for actionKind for backwards compatibility.', params: { taskId: 'string (required) — review task ID from the approved context_review_tasks record', findingId: 'string (required)', judgeRunId: 'string (required)', actionKind: 'string (required) — e.g. "curated_entry_edit"|"curated_entry_create"|"ingestion_rerun"|"no_op" etc. Also accepted as fixType.', remediationKind: 'string — curation_metadata_update|mandatory_mapping_update|memory_merge|memory_demote|memory_add|retrieval_policy_fix|code_fix|qa_rejudge|no_op', fixType: 'string — alias for actionKind (backwards compat)', workerRole: 'string', targetEntryId: 'string', targetEntryIds: 'object — array of curated entry ids', targetRefId: 'string', targetRefIds: 'object — array of context ref ids', targetMappingId: 'string', targetMappingIds: 'object — array of mandatory mapping ids', targetRepoId: 'string', sourceEvaluationIds: 'object — array of source evaluation ids supporting this mapping', affectedRefIds: 'object — array of affected Cognee/context refs', proposedPatch: 'object — proposed DB/context metadata patch', retrievalReplayId: 'string', validationPlan: 'string', estimatedRisk: 'string — "low"|"medium"|"high"', humanGateRequired: 'boolean' } },
  { name: 'context_quality_dispatch_remediation_task', description: 'Dispatch a remediation task for execution. Returns the dispatched task record. REST fallback: POST /api/context/quality/remediation-tasks/:id/dispatch.', params: { task_id: 'string (required)' } },
  { name: 'context_quality_create_learning_promotion', description: 'Create a LearningPromotion proposal. Server enforces auto-gating: confidence >= 0.65, no high risk, validated source, and no conflict maps to an approved auto-curation remediation; otherwise it remains human-reviewed. Returns the promotion record with promotionId. REST fallback: POST /api/context/quality/learning-promotions.', params: { learningId: 'string (required)', rootExecutionId: 'string', sessionId: 'string', reviewTaskId: 'string', action: 'string (required) — "create_curated_context"|"update_curated_context"|"remediate_curated_context"', targetRepoId: 'string', targetRepoIds: 'object — array of target repo ids', targetEntryId: 'string', targetEntryIds: 'object — array of curated entry ids', targetRefIds: 'object — array of Cognee/context refs', affectedRefIds: 'object — array of affected refs', sourceEvaluationIds: 'object — array of source evaluation ids', proposedPatch: 'object — proposed curation patch with curatedContext/retrievalText/title/category/injectionPolicy where available', confidence: 'number', estimatedRisk: 'string', humanGateRequired: 'boolean — advisory only; server recomputes the gate', sourceValidationStatus: 'string — validated|failed|pending|not_required', conflictStatus: 'string — no_conflict|conflict_detected|conflict_resolved', remediationId: 'string', scope: 'string', suggestedContent: 'string — proposed curated text (DRAFT ONLY)', proposedCuratedText: 'string — proposed injected context text' } },
  { name: 'context_quality_decide_learning_promotion', description: 'Record a human decision on a LearningPromotion. AGENTS MUST NOT SELF-APPROVE — this is for human-actor use only. Returns the decision record. REST fallback: POST /api/context/quality/learning-promotions/:id/decisions.', params: { promotion_id: 'string (required)', decision: 'string (required) — "approved"|"rejected"', reason: 'string' } },
  { name: 'context_quality_apply_curated_edit', description: 'Apply an approved curated context edit. Requires LearningPromotion.decision==="approved" or an approved review task when humanGateRequired=true. Returns { revisionId, entryId }. REST fallback: POST /api/context/quality/curated-edits/:repoId/:entryId.', params: { repo_id: 'string (required)', entry_id: 'string (required)', action: 'string (required) — "create"|"update"|"archive"', content: 'string — legacy content replacement only', patch: 'object — structured curation patch', proposedPatch: 'object — structured remediation proposal patch', metadataUpdates: 'object — metadata/policy update fields', sourceReviewTaskId: 'string', sourceLearningId: 'string', sourcePromotionId: 'string', remediationId: 'string', expectedEntryVersionId: 'string — active entryVersionId read immediately before update/archive' } },
  { name: 'context_quality_get_curated_entry', description: 'Read the current curated context entry before applying a remediation. REST fallback: GET /api/context/quality/curated-entries/:repoId/:entryId.', params: { repo_id: 'string (required)', entry_id: 'string (required)' } },
  { name: 'context_quality_get_curation_history', description: 'Get revision history for a curated context entry. Returns list of revisions with timestamps. REST fallback: GET /api/context/quality/curated-edits/:repoId/:entryId/history.', params: { repo_id: 'string (required)', entry_id: 'string (required)' } },
  { name: 'context_quality_revert_curated_edit', description: 'Revert a curated context entry to a specific revision. Returns the new revision record. REST fallback: POST /api/context/quality/curated-edits/:repoId/:entryId/revert/:revisionId.', params: { repo_id: 'string (required)', entry_id: 'string (required)', revision_id: 'string (required)' } },

  // ── Knowledge & Data ──
  { name: 'search_learnings', description: 'Search the learning system. Filter by workflow, type, or limit.', params: { workflow_name: 'string', type: 'string', limit: 'number' } },
  { name: 'save_learning', description: 'Save a learning/correction to memory. Call when user corrects you or states a preference.', params: { content: 'string (required) — generalized rule', type: 'string (required) — fact, pattern, mistake, or preference' } },
  { name: 'get_dashboard_stats', description: 'Get dashboard statistics: workflow count, executions, success rate, agent count.', params: {} },
  { name: 'query_database', description: 'Read-only MongoDB query against any collection (e.g. workflows, executions, agents, repos, learnings, chat_sessions, chat_threads, execution_logs, node_traces, workspaces, teams, …). Pass filter/projection/sort for precise results.', params: { collection: 'string (required)', filter: 'object', projection: 'object', sort: 'object', limit: 'number (max 100, default 20)' } },
  { name: 'save_repo_context_curation_stage', description: 'Save generated repo context into the temporary staging area for the active repo-context-curator run. Worker agents use this only; it never writes final curation collections.', params: { run_id: 'string (required)', assignment_id: 'string (required)', worker_id: 'string (required)', entries: 'array of generated context entries', file_statuses: 'array with one status per assigned file' } },

  // ── File upload ──
  { name: 'upload_file', description: 'Upload a file to Allen storage. Returns a permanent public URL.', params: { content: 'string (required) — file content', filename: 'string (required) — e.g. "report.md"', mime_type: 'string — MIME type (default: text/plain)' } },

  // ── Artifacts (hierarchical files filed under the run that spawned you) ──
  //
  // Prefer `allen_save_artifact` over `upload_file` when you produce a plan,
  // design doc, JSON config, CSV, or scratch output that the USER should be
  // able to review later. The artifact is automatically filed under the
  // "root" that spawned this agent — chat session id, workflow execution
  // id, or standalone agent execution id. The UI surfaces all artifacts
  // for a given root so humans can browse them without the raw URLs.
  //
  // Root context is auto-detected from the agent's environment
  // (ALLEN_ARTIFACT_ROOT_TYPE / ALLEN_ARTIFACT_ROOT_ID) — you don't pass
  // it yourself. Sub-agents inherit their parent's root, so files always
  // file under the top-level work that kicked everything off.
  { name: 'allen_save_artifact', description: 'Save a plan, design doc, JSON, CSV, or text artifact that the user should be able to review later. Files under the run that spawned you — a workflow execution, chat session, or agent run. Prefer this over upload_file when the artifact is meant to be browsed from the Allen UI.', params: { filename: 'string (required) — relative path like "plan.md" or "design/api.json". No leading slash, no ".."', content: 'string (required) — file content as text. For binary, base64-encode and set content_type="binary".', content_type: 'string — "markdown" | "json" | "csv" | "text" | "code" | "binary" — inferred from extension if omitted', description: 'string — short human description shown in the artifacts list', language: 'string — language hint for content_type="code" (e.g. "python", "sql")', overwrite: 'boolean — default false; when true, replace an existing artifact with the same filename' } },
  { name: 'allen_list_artifacts', description: 'List the artifacts already saved for this run (or any run). Useful for referencing prior plans/docs when continuing work.', params: { root_id: 'string — override the current run\'s root; omit to list your own run\'s artifacts', root_type: 'string — "chat" | "workflow" | "agent"; used with root_id', limit: 'number — default 50' } },
  { name: 'allen_get_artifact', description: 'Fetch the content of an artifact by id (from allen_save_artifact or allen_list_artifacts).', params: { artifact_id: 'string (required)' } },
];

// ── API Call Helper ──

async function callAPI(endpoint: string, method = 'GET', body?: unknown): Promise<unknown> {
  const url = `${API_BASE}${endpoint}`;
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  return parseAllenApiResponse(res);
}

function trimText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function formatProgressActivity(row: Record<string, unknown>): string | undefined {
  const agent = trimText(row.agent, 80) ?? 'agent';
  const tool = trimText(row.tool, 80);
  const content = trimText(row.content ?? row.label, 180);
  const type = String(row.type ?? '');
  if (type === 'tool_call') return `${agent} started ${tool ?? 'a tool'}${content ? `: ${content}` : ''}`;
  if (type === 'tool_result') return `${agent} received ${tool ?? 'tool'} result${content ? `: ${content}` : ''}`;
  if (type === 'thinking') return content ? `${agent} is thinking: ${content}` : `${agent} is thinking`;
  if (type === 'text') return content ? `${agent}: ${content}` : undefined;
  return content ? `${agent}: ${content}` : undefined;
}

function formatProgressLog(row: Record<string, unknown>): string | undefined {
  const message = trimText(row.message ?? row.content ?? row.command ?? row.tool ?? row.type, 220);
  if (!message) return undefined;
  const node = trimText(row.node, 60);
  const category = trimText(row.category, 40);
  const prefix = node ? `[${node}]` : category ? `[${category}]` : '';
  return prefix ? `${prefix} ${message}` : message;
}

async function readExecutionProgress(executionId: unknown, sinceRaw?: unknown): Promise<Record<string, unknown>> {
  if (!executionId) return {};
  const execId = String(executionId);
  const since = typeof sinceRaw === 'string' && sinceRaw ? new Date(sinceRaw) : undefined;
  const activityQs = new URLSearchParams({ limit: '12' });
  if (since && !Number.isNaN(since.getTime())) activityQs.set('since', since.toISOString());

  const [activityRes, logsRes] = await Promise.all([
    callAPI(`/api/executions/${execId}/activity?${activityQs.toString()}`).catch(() => ({ events: [] })),
    callAPI(`/api/executions/${execId}/logs?include_descendants=true&limit=12`).catch(() => []),
  ]);

  const recentActivity = Array.isArray((activityRes as Record<string, unknown>)?.events)
    ? ((activityRes as Record<string, unknown>).events as Record<string, unknown>[])
    : [];
  const rawLogs = Array.isArray(logsRes) ? (logsRes as Record<string, unknown>[]) : [];
  const logs = since && !Number.isNaN(since.getTime())
    ? rawLogs.filter((log) => {
        const at = new Date(String(log.timestamp ?? log.createdAt ?? ''));
        return !Number.isNaN(at.getTime()) && at > since;
      })
    : rawLogs;

  const topLogs = logs.slice(-8).map((log) => ({
    timestamp: log.timestamp ?? log.createdAt,
    level: log.level,
    category: log.category ?? log.type,
    node: log.node ?? null,
    message: trimText(log.message ?? log.content ?? log.command ?? log.tool ?? log.type, 300) ?? '',
  }));
  const activitySummary = [
    ...recentActivity.map(formatProgressActivity),
    ...logs.slice(-5).map(formatProgressLog),
  ].filter((line): line is string => Boolean(line)).slice(-10);

  const cursorCandidates = [
    ...recentActivity.map(row => row.at),
    ...logs.map(log => log.timestamp ?? log.createdAt),
    since?.toISOString(),
  ]
    .filter(Boolean)
    .map(value => new Date(String(value)))
    .filter(date => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  return {
    recent_activity: recentActivity,
    top_logs: topLogs,
    activity_summary: activitySummary,
    progress_message: activitySummary[activitySummary.length - 1],
    activity_cursor: cursorCandidates[0]?.toISOString(),
  };
}

// ── Tool Execution via API ──

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    // Slim summary only — name, description, version, nodeCount, isValid,
    // updatedAt. Agents call get_workflow when they need the full graph.
    case 'list_workflows': return callAPI('/api/workflows?summary=true');
    case 'list_executions': {
      const params = new URLSearchParams();
      if (args.status) params.set('status', String(args.status));
      if (args.workflow_name) params.set('workflowName', String(args.workflow_name));
      const qs = params.toString();
      return callAPI(`/api/executions${qs ? '?' + qs : ''}`);
    }
    case 'wait_for_execution': {
      // Chunked long-poll: wait up to 90s for completion, then return
      const execId = args.execution_id;
      const activitySince = args.activity_since;
      let eWait = 5000;
      const eMaxWait = 30_000;
      const eDeadline = Date.now() + 90_000;
      while (Date.now() < eDeadline) {
        const res = await fetch(`${API_BASE}/api/executions/${execId}`);
        const data = await res.json() as Record<string, unknown>;
        if (data.status !== 'running' && data.status !== 'queued') {
          // Fetch trace for the response
          try {
            const traceRes = await fetch(`${API_BASE}/api/executions/${execId}/traces`);
            const traces = await traceRes.json() as Array<Record<string, unknown>>;
            const lastTrace = traces[traces.length - 1];
            if (lastTrace) {
              const output = lastTrace.output as Record<string, unknown> | undefined;
              data.response = output?.response ?? lastTrace.rawResponse ?? undefined;
              data.session_id = output?.session_id ?? undefined;
            }
          } catch {}
          return { ...data, ...(await readExecutionProgress(execId, activitySince)) };
        }
        process.stderr.write(`[mcp] waiting for execution ${execId} (${Math.round(eWait / 1000)}s interval)\n`);
        await new Promise(r => setTimeout(r, eWait));
        eWait = Math.min(eWait * 1.3, eMaxWait);
      }
      return {
        id: execId,
        status: 'waiting',
        message: 'Execution still running. Call wait_for_execution again.',
        ...(await readExecutionProgress(execId, activitySince)),
      };
    }
    case 'cancel_execution': {
      const url = `${API_BASE}/api/executions/${args.execution_id}/cancel`;
      const res = await fetch(url, { method: 'POST' });
      return res.json();
    }
    case 'run_workflow': {
      // Find workflow by name first
      const workflows = await callAPI('/api/workflows') as any[];
      const wf = workflows?.find((w: any) => w.name === args.workflow_name || w.parsed?.name === args.workflow_name);
      if (!wf) return { error: `Workflow "${args.workflow_name}" not found` };
      const wfDetails = await callAPI(`/api/workflows/${wf._id}`) as any;
      const input = (args.input ?? {}) as Record<string, unknown>;
      const inputDef = wfDetails?.parsed?.input as Record<string, { required?: boolean; type?: string; label?: string }> | undefined;
      if (inputDef) {
        const missingFields = Object.entries(inputDef)
          .filter(([key, def]) => def.required && (input[key] === undefined || input[key] === null || input[key] === ''))
          .map(([key]) => key);
        if (missingFields.length > 0) {
          return {
            error: `Missing required inputs: ${missingFields.join(', ')}`,
            hint: 'Call get_workflow first and rebuild input with the exact parsed.input field names.',
            required_inputs: Object.entries(inputDef).map(([name, def]) => ({
              name,
              type: def.type ?? 'string',
              required: def.required ?? false,
              label: def.label,
            })),
          };
        }
      }
      // Go through the chat-tool dispatcher instead of the raw execution
      // route so server-side active chat context can stamp both
      // meta.chatSessionId and meta.parentMessageId. The raw route only sees
      // headers from this MCP process and cannot know which assistant message
      // owns the workflow run.
      const url = `${API_BASE}/api/chat/tools/run_workflow`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_name: args.workflow_name, input }),
      });
      return res.json();
    }
    case 'list_repos': return callAPI('/api/repos');
    case 'get_repo_context': {
      const path = String(args.repo_path ?? '');
      if (!path) return { error: 'repo_path is required' };
      const url = `${API_BASE}/api/repos/context?path=${encodeURIComponent(path)}`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) return { error: `No context found for path: ${path}. Either the repo isn't registered or its first scan hasn't completed yet.` };
        return { error: `API ${res.status}: ${await res.text().catch(() => 'unknown')}` };
      }
      return res.json();
    }
    case 'get_repo_skill_body': {
      const path = String(args.repo_path ?? '');
      if (!path) return { error: 'repo_path is required' };
      const params = new URLSearchParams({ path });
      if (args.ref_id) params.set('refId', String(args.ref_id));
      if (args.skill_path) params.set('skillPath', String(args.skill_path));
      if (!params.has('skillPath')) return { error: 'skill_path is required' };
      const res = await fetch(`${API_BASE}/api/repos/skill-body?${params.toString()}`);
      if (!res.ok) return { error: `API ${res.status}: ${await res.text().catch(() => 'unknown')}` };
      return res.json();
    }
    case 'get_repo_context_body': {
      const path = String(args.repo_path ?? '');
      if (!path) return { error: 'repo_path is required' };
      const params = new URLSearchParams({ path });
      if (args.ref_id) params.set('refId', String(args.ref_id));
      if (args.context_path) params.set('contextPath', String(args.context_path));
      if (!params.has('refId') && !params.has('contextPath')) return { error: 'ref_id or context_path is required' };
      const res = await fetch(`${API_BASE}/api/repos/context-body?${params.toString()}`);
      if (!res.ok) return { error: `API ${res.status}: ${await res.text().catch(() => 'unknown')}` };
      return res.json();
    }
    case 'prepare_repo_context_curation': {
      const repoId = String(args.repo_id ?? args.repoId ?? '');
      const repoPath = String(args.repo_path ?? args.repoPath ?? '');
      if (!repoId && !repoPath) return { error: 'repo_id or repo_path is required' };
      const scope = args.scope && typeof args.scope === 'object' ? args.scope as Record<string, unknown> : {};
      const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
      const gitRef = typeof args.git_ref === 'string' && args.git_ref.trim() ? args.git_ref.trim() : undefined;
      return callAPI('/api/repos/context-curation/prepare', 'POST', {
        repo_id: repoId || undefined,
        repo_path: repoPath || undefined,
        branch: branch ?? gitRef,
        scope: { ...scope, force: args.force === true || scope.force === true },
        source_execution_id: SPAWN_PARENT_EXECUTION_ID || SPAWN_ROOT_EXECUTION_ID,
        source_agent: SPAWN_PARENT_CALLER,
      });
    }
    case 'register_repo_context_curation_assignments': {
      const runId = String(args.run_id ?? args.runId ?? '');
      if (!runId) return { error: 'run_id is required' };
      return callAPI('/api/repos/context-curation/assignments', 'POST', {
        run_id: runId,
        assignments: Array.isArray(args.assignments) ? args.assignments : [],
      });
    }
    case 'plan_repo_context_curation_assignments': {
      const runId = String(args.run_id ?? args.runId ?? '');
      if (!runId) return { error: 'run_id is required' };
      return callAPI('/api/repos/context-curation/assignment-plan', 'POST', {
        run_id: runId,
        register: args.register !== false,
        max_files_per_assignment: args.max_files_per_assignment ?? args.maxFilesPerAssignment,
        max_bytes_per_assignment: args.max_bytes_per_assignment ?? args.maxBytesPerAssignment,
        large_file_bytes: args.large_file_bytes ?? args.largeFileBytes,
        concurrency_limit: args.concurrency_limit ?? args.concurrencyLimit,
        include_all: args.include_all === true || args.includeAll === true,
      });
    }
    case 'get_repo_context_curation_stage_status': {
      const runId = String(args.run_id ?? args.runId ?? '');
      if (!runId) return { error: 'run_id is required' };
      return callAPI('/api/repos/context-curation/stage-status', 'POST', { run_id: runId });
    }
    case 'promote_repo_context_curation_stage': {
      const runId = String(args.run_id ?? args.runId ?? '');
      if (!runId) return { error: 'run_id is required' };
      return callAPI('/api/repos/context-curation/promote', 'POST', { run_id: runId });
    }
    case 'save_repo_context_curation_stage': {
      const runId = String(args.run_id ?? args.runId ?? '');
      const assignmentId = String(args.assignment_id ?? args.assignmentId ?? '');
      const workerId = String(args.worker_id ?? args.workerId ?? '');
      if (!runId || !assignmentId || !workerId) return { error: 'run_id, assignment_id, and worker_id are required' };
      return callAPI('/api/repos/context-curation/stage', 'POST', {
        run_id: runId,
        assignment_id: assignmentId,
        worker_id: workerId,
        entries: Array.isArray(args.entries) ? args.entries : [],
        file_statuses: Array.isArray(args.file_statuses) ? args.file_statuses : Array.isArray(args.fileStatuses) ? args.fileStatuses : [],
      });
    }
    case 'save_repo_mandatory_context_mappings': {
      const repoId = String(args.repo_id ?? args.repoId ?? '');
      if (!repoId) return { error: 'repo_id is required' };
      return callAPI('/api/repos/mandatory-context', 'POST', {
        repo_id: repoId,
        mappings: Array.isArray(args.mappings) ? args.mappings : [],
      });
    }
    case 'save_repo_mandatory_context_mapping_proposal': {
      const repoId = String(args.repo_id ?? args.repoId ?? '');
      const setupRunId = String(args.setup_run_id ?? args.setupRunId ?? '');
      if (!repoId) return { error: 'repo_id is required' };
      if (!setupRunId) return { error: 'setup_run_id is required' };
      const mode = String(args.mode ?? '');
      if (mode === 'stage') {
        return callAPI(`/api/repos/${encodeURIComponent(repoId)}/mandatory-context/proposals`, 'POST', {
          mode: 'stage',
          setupRunId,
          mappings: Array.isArray(args.mappings) ? args.mappings : [],
        });
      }
      const affectedAgentNames = Array.isArray(args.affected_agent_names) ? args.affected_agent_names : Array.isArray(args.affectedAgentNames) ? args.affectedAgentNames : [];
      if (!affectedAgentNames.length) return { error: 'affected_agent_names is required and must be a non-empty array' };
      if (mode === 'finalize') {
        const expectedMappingCount = Number(args.expected_mapping_count ?? args.expectedMappingCount);
        if (!Number.isInteger(expectedMappingCount) || expectedMappingCount < 0) {
          return { error: 'expected_mapping_count is required for mode "finalize" and must be a non-negative integer' };
        }
        return callAPI(`/api/repos/${encodeURIComponent(repoId)}/mandatory-context/proposals`, 'POST', {
          mode: 'finalize',
          setupRunId,
          affectedAgentNames,
          expectedMappingCount,
        });
      }
      if (mode) return { error: `unknown mode '${mode}' — expected 'stage' or 'finalize'` };
      return callAPI(`/api/repos/${encodeURIComponent(repoId)}/mandatory-context/proposals`, 'POST', {
        setupRunId,
        affectedAgentNames,
        mappings: Array.isArray(args.mappings) ? args.mappings : [],
      });
    }
    case 'get_node_context_usage': {
      const executionId = String(args.execution_id ?? '');
      if (!executionId) return { error: 'execution_id is required' };
      const params = new URLSearchParams();
      const view = String(args.view ?? '');
      if (view) params.set('view', view);
      const include = Array.isArray(args.include) ? args.include.map(String).filter(Boolean).join(',') : String(args.include ?? '');
      if (include) params.set('include', include);
      if (args.refresh === true || args.bypassCache === true) params.set('refresh', 'true');
      const qs = params.toString();
      return callAPI(`/api/executions/${encodeURIComponent(executionId)}/context-usage${qs ? `?${qs}` : ''}`);
    }
    case 'context_quality_get_attempt_evidence': {
      const contextAttemptId = String(args.context_attempt_id ?? args.contextAttemptId ?? '');
      if (!contextAttemptId) return { error: 'context_attempt_id is required' };
      return callAPI(`/api/context/attempts/${encodeURIComponent(contextAttemptId)}/evidence`);
    }
    case 'context_quality_get_attempt_evidence_batch': {
      const contextAttemptIds = Array.isArray(args.context_attempt_ids)
        ? args.context_attempt_ids.map(String).filter(Boolean)
        : Array.isArray(args.contextAttemptIds)
          ? args.contextAttemptIds.map(String).filter(Boolean)
          : [];
      if (!contextAttemptIds.length) return { error: 'context_attempt_ids is required' };
      return callAPI('/api/context/attempts/evidence/batch', 'POST', { context_attempt_ids: contextAttemptIds });
    }
    case 'context_quality_get_usage_trace': {
      // Fix 2: Unified context usage trace lookup.
      // Accepts executionId OR contextAttemptId and returns normalized identifiers.
      const executionId = args.execution_id ? String(args.execution_id) : '';
      const contextAttemptId = args.context_attempt_id ? String(args.context_attempt_id) : '';
      const sessionId = args.session_id ? String(args.session_id) : '';
      if (!executionId && !contextAttemptId && !sessionId) {
        return { error: 'execution_id, context_attempt_id, or session_id is required' };
      }
      const qs: string[] = [];
      if (executionId) qs.push(`executionId=${encodeURIComponent(executionId)}`);
      if (contextAttemptId) qs.push(`contextAttemptId=${encodeURIComponent(contextAttemptId)}`);
      if (sessionId) qs.push(`sessionId=${encodeURIComponent(sessionId)}`);
      return callAPI(`/api/context/quality/usage-trace?${qs.join('&')}`);
    }
    case 'context_quality_replay_usage_trace': {
      const executionId = args.execution_id ?? args.executionId ? String(args.execution_id ?? args.executionId) : '';
      const contextAttemptId = args.context_attempt_id ?? args.contextAttemptId ? String(args.context_attempt_id ?? args.contextAttemptId) : '';
      const sessionId = args.session_id ?? args.sessionId ? String(args.session_id ?? args.sessionId) : '';
      if (!executionId && !contextAttemptId && !sessionId) {
        return { error: 'execution_id, context_attempt_id, or session_id is required' };
      }
      const qs: string[] = [];
      if (executionId) qs.push(`executionId=${encodeURIComponent(executionId)}`);
      if (contextAttemptId) qs.push(`contextAttemptId=${encodeURIComponent(contextAttemptId)}`);
      if (sessionId) qs.push(`sessionId=${encodeURIComponent(sessionId)}`);
      return callAPI(`/api/context/quality/usage-trace/replay?${qs.join('&')}`);
    }
    case 'find_repo_for_pr_url': {
      const prUrl = String(args.pr_url ?? '');
      if (!prUrl) return { error: 'pr_url is required' };
      return callAPI(`/api/repos/by-pr-url?url=${encodeURIComponent(prUrl)}`);
    }
    case 'find_pr_by_url': {
      const prUrl = String(args.pr_url ?? '');
      if (!prUrl) return { error: 'pr_url is required' };
      return callAPI(`/api/pull-requests/by-url?url=${encodeURIComponent(prUrl)}`);
    }
    case 'mark_pr_synced': {
      const prId = String(args.pr_id ?? '');
      const headSha = String(args.head_sha ?? '');
      const processedCommentIds = Array.isArray(args.processed_comment_ids)
        ? (args.processed_comment_ids as unknown[]).map(String)
        : [];
      if (!prId) return { error: 'pr_id is required' };
      return callAPI(`/api/pull-requests/${encodeURIComponent(prId)}/mark-synced`, 'POST', {
        headSha, processedCommentIds,
      });
    }
    case 'get_workspace': {
      const wsId = String(args.workspace_id ?? '');
      if (!wsId) return { error: 'workspace_id is required' };
      return callAPI(`/api/workspaces/${encodeURIComponent(wsId)}`);
    }
    case 'create_workspace_for_pr': {
      const prUrl = String(args.pr_url ?? '');
      const repoId = String(args.repo_id ?? '');
      const branch = String(args.branch ?? '');
      const baseBranch = String(args.base_branch ?? '');
      const prNumber = Number(args.pr_number);
      const prTitle = (args.pr_title as string | undefined) ?? `PR #${prNumber}`;
      if (!prUrl || !repoId || !branch || !baseBranch || !prNumber) {
        return { error: 'pr_url, repo_id, branch, base_branch, pr_number are all required' };
      }
      // Look up the repo for name/path metadata required by the workspace
      // creation endpoint.
      const repo = await callAPI(`/api/repos/${encodeURIComponent(repoId)}`) as any;
      if (!repo || repo.error) return { error: `Repo ${repoId} not found` };
      const ws = await callAPI('/api/workspaces', 'POST', {
        repoId,
        repoName: repo.name,
        repoPath: repo.path,
        branch, baseBranch,
        name: `coderabbit-pr-${prNumber}`,
        source: 'pr',
        prNumber, prTitle, prUrl,
        meta: { coderabbitOnly: true, createdForPrUrl: prUrl },
      }) as any;
      if (ws?.error) return { error: ws.error };
      // Poll until status=active (≤10 min).
      const wsId = String(ws._id ?? ws.id);
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        const cur = await callAPI(`/api/workspaces/${encodeURIComponent(wsId)}`) as any;
        if (cur?.status === 'active' || cur?.status === 'running') {
          if (SPAWN_CHAT_SESSION_ID) {
            await callAPI(`/api/workspaces/${encodeURIComponent(wsId)}/link-chat`, 'POST', { sessionId: SPAWN_CHAT_SESSION_ID }).catch(() => {});
          }
          return {
            workspace_id: wsId,
            worktree_path: cur.worktreePath,
            branch: cur.branch,
            base_branch: cur.baseBranch,
            status: cur.status,
            chat_session_id: SPAWN_CHAT_SESSION_ID,
          };
        }
        if (cur?.status === 'failed') return { error: 'workspace setup failed' };
        await new Promise(r => setTimeout(r, 2000));
      }
      return { error: 'workspace setup timed out (10 min)' };
    }
    case 'create_workspace': {
      // Generic workspace creation — the PR-specific variant above is used
      // for CodeRabbit review flows. This one is for engineering-lead's
      // feature / bug fix path: cut a fresh branch off the base and
      // create an isolated worktree every specialist will share.
      const repoPath = String(args.repo_path ?? '');
      const branchPrefix = String(args.branch_prefix ?? 'feature');
      const taskSummary = String(args.task_summary ?? '').trim();
      if (!repoPath) return { error: 'repo_path is required' };

      // Find the repo by absolute path (registered repo or any existing
      // workspace whose repoPath we recognise).
      const repos = await callAPI('/api/repos') as any[];
      if (!Array.isArray(repos)) return repos; // error passthrough
      const repo = repos.find((r: any) => r.path === repoPath);
      if (!repo) {
        // Fallback: repoPath might be an existing Allen worktree path
        // (e.g. /home/ubuntu/.allen/workspaces/<id>) rather than a registered
        // repo path. Look it up in /api/workspaces and return the existing
        // workspace without creating a new one.
        const allWorkspaces = await callAPI('/api/workspaces') as any;
        const existingWs = Array.isArray(allWorkspaces)
          ? allWorkspaces.find((ws: any) =>
              ws.worktreePath === repoPath &&
              !['archived', 'archiving', 'failed'].includes(ws.status),
            )
          : null;
        if (existingWs) {
          const wsId = String(existingWs._id ?? existingWs.id);
          if (SPAWN_CHAT_SESSION_ID) {
            await callAPI(
              `/api/workspaces/${encodeURIComponent(wsId)}/link-chat`,
              'POST',
              { sessionId: SPAWN_CHAT_SESSION_ID },
            ).catch(() => {});
          }
          return {
            workspace_id: wsId,
            worktree_path: existingWs.worktreePath,
            branch: existingWs.branch,
            base_branch: existingWs.baseBranch,
            status: existingWs.status,
            chat_session_id: SPAWN_CHAT_SESSION_ID,
          };
        }
        return { error: `No registered repo found at ${repoPath}. Call list_repos and pass an exact path.` };
      }

      // Resolve the base branch. Precedence: explicit caller arg → the
      // repo's detected default branch (captured at scan time) → 'dev' as
      // a sensible fallback for teams whose convention is `dev` /
      // `development` rather than `main`. The workspace service itself
      // does a second-pass fallback against the actual repo when the
      // requested branch doesn't resolve (see workspace.service.ts), so
      // passing 'dev' here still works for repos on main/master.
      const repoDefaultBranch = (repo?.detected as any)?.defaultBranch as string | undefined;
      const baseBranch = String(args.base_branch ?? repoDefaultBranch ?? 'dev');

      // Generate a short, filesystem-safe branch name from the summary.
      const slug = taskSummary
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'work';
      const stamp = Math.floor(Date.now() / 1000).toString(36);
      const branch = `${branchPrefix}/${slug}-${stamp}`;
      const name = `${branchPrefix}-${slug}-${stamp}`.slice(0, 60);

      const ws = await callAPI('/api/workspaces', 'POST', {
        repoId: String(repo._id ?? repo.id),
        repoName: repo.name,
        repoPath: repo.path,
        branch,
        baseBranch,
        name,
      }) as any;
      if (ws?.error) return { error: ws.error };

      // Poll until active (≤5 min — generic workspaces usually complete
      // faster than PR-flow ones since there's no PR checkout step).
      const wsId = String(ws._id ?? ws.id);
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const cur = await callAPI(`/api/workspaces/${encodeURIComponent(wsId)}`) as any;
        if (cur?.status === 'active' || cur?.status === 'running') {
          if (SPAWN_CHAT_SESSION_ID) {
            await callAPI(`/api/workspaces/${encodeURIComponent(wsId)}/link-chat`, 'POST', { sessionId: SPAWN_CHAT_SESSION_ID }).catch(() => {});
          }
          return {
            workspace_id: wsId,
            worktree_path: cur.worktreePath,
            branch: cur.branch,
            base_branch: cur.baseBranch,
            status: cur.status,
            chat_session_id: SPAWN_CHAT_SESSION_ID,
          };
        }
        if (cur?.status === 'failed') return { error: 'workspace setup failed' };
        await new Promise(r => setTimeout(r, 2000));
      }
      return { error: 'workspace setup timed out (5 min)' };
    }
    case 'list_agents': {
      // Return minimal fields — full details via get_agent
      const all = await callAPI('/api/agents') as any[];
      if (!Array.isArray(all)) return all; // error passthrough
      return all.map((a: any) => ({
        name: a.name,
        displayName: a.displayName,
        description: a.description ?? '',
        teamName: a.teamName,
        type: a.type,
        model: a.model,
        provider: a.provider ?? 'claude',
      }));
    }
    case 'get_agent': {
      const agentName = String(args.name ?? '');
      if (!agentName) return { error: 'name is required' };
      const res = await fetch(`${API_BASE}/api/agents`);
      const agents = await res.json() as any[];
      const agent = agents.find((a: any) => a.name === agentName);
      if (!agent) return { error: `Agent "${agentName}" not found` };
      return agent;
    }
    case 'get_workflow': {
      const wfName = args.name as string | undefined;
      const wfId = args.id as string | undefined;
      if (!wfName && !wfId) return { error: 'name or id is required' };
      if (wfId) return callAPI(`/api/workflows/${wfId}`);
      // Find by name
      const workflows = await callAPI('/api/workflows') as any[];
      if (!Array.isArray(workflows)) return workflows;
      const wf = workflows.find((w: any) => w.name === wfName || w.parsed?.name === wfName);
      if (!wf) return { error: `Workflow "${wfName}" not found` };
      return callAPI(`/api/workflows/${wf._id}`);
    }
    case 'get_team': {
      const teamName = String(args.name ?? '');
      if (!teamName) return { error: 'name is required' };
      const team = await callAPI(`/api/teams/${teamName}`) as any;
      if (team?.error) return team;
      // Also fetch member names (light — no system prompts)
      const members = await callAPI(`/api/teams/${teamName}/members`) as any[];
      return {
        ...team,
        members: Array.isArray(members) ? members.map((m: any) => ({
          name: m.name,
          displayName: m.displayName,
          teamRole: m.teamRole,
          model: m.model,
          type: m.type,
        })) : [],
      };
    }
    case 'move_agent_to_team': {
      const agentNames = args.agent_names;
      const teamName = args.team_name;
      if (!Array.isArray(agentNames) || agentNames.length === 0) return { error: 'agent_names must be a non-empty array' };
      if (!teamName) return { error: 'team_name is required' };
      const res = await fetch(`${API_BASE}/api/agents/bulk-team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentNames, teamName }),
      });
      return res.json();
    }
    case 'get_dashboard_stats': return callAPI('/api/dashboard/stats');
    case 'search_learnings': {
      const params = new URLSearchParams();
      if (args.workflow_name) params.set('workflowName', String(args.workflow_name));
      if (args.type) params.set('type', String(args.type));
      if (args.limit) params.set('limit', String(args.limit));
      const qs = params.toString();
      return callAPI(`/api/learnings${qs ? '?' + qs : ''}`);
    }
    case 'get_node_trace': return callAPI(`/api/executions/${args.execution_id}/traces/${args.node_name}`);
    case 'get_execution_logs': {
      const params = new URLSearchParams();
      if (args.node) params.set('node', String(args.node));
      if (args.level) params.set('level', String(args.level));
      if (args.category) params.set('category', String(args.category));
      if (args.limit) params.set('limit', String(args.limit));
      const qs = params.toString();
      return callAPI(`/api/executions/${args.execution_id}/logs${qs ? '?' + qs : ''}`);
    }
    case 'submit_execution_input': {
      const url = `${API_BASE}/api/executions/${args.execution_id}/input`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node: args.node, data: args.data }),
      });
      return res.json();
    }
    case 'spawn_agent': {
      const url = `${API_BASE}/api/chat/spawn-agent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_name: args.agent_name,
          prompt: args.prompt,
          context_query: args.context_query,
          repo_path: args.repo_path,
          session_id: args.session_id,
          // Spawn-tree linkage — lets the execution row carry its caller
          // label, parent pointer, and root pointer so the parent workflow's
          // execution page can find and track its spawned children.
          parent_execution_id: SPAWN_PARENT_EXECUTION_ID,
          parent_caller: SPAWN_PARENT_CALLER,
          root_execution_id: SPAWN_ROOT_EXECUTION_ID,
          // Forward the artifact root so the spawned agent's files end up
          // under the SAME top-level run. Without this, nested spawns
          // would re-root under their own agent exec id.
          artifact_root_type: SPAWN_ARTIFACT_ROOT_TYPE,
          artifact_root_id: SPAWN_ARTIFACT_ROOT_ID,
          repo_knowledge_packet_id: REPO_KNOWLEDGE_PACKET_ID,
          repo_knowledge_repo_id: REPO_KNOWLEDGE_REPO_ID,
          repo_knowledge_index_id: REPO_KNOWLEDGE_INDEX_ID,
          repo_knowledge_repo_name: REPO_KNOWLEDGE_REPO_NAME,
          repo_knowledge_freshness: REPO_KNOWLEDGE_FRESHNESS,
        }),
      });
      return res.json();
    }
    case 'query_database': {
      const collection = args.collection as string;
      if (!collection) return { error: 'collection is required' };
      const res = await fetch(`${API_BASE}/api/chat/query-database`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection,
          filter: args.filter ?? {},
          projection: args.projection ?? {},
          sort: args.sort ?? {},
          limit: args.limit ?? 20,
        }),
      });
      return res.json();
    }

    // ── Chat conversation tracing ──
    //
    // Thin wrappers over the existing /api/chat routes. The MCP auth layer
    // at the top of this file injects the Authorization header on every
    // API_BASE fetch, so these work for any session the service account
    // can read — not just the currently-running chat session like
    // get_my_session_history does.
    case 'get_chat_session': {
      const sid = args.session_id as string | undefined;
      if (!sid) return { error: 'session_id is required' };
      const res = await fetch(`${API_BASE}/api/chat/sessions/${encodeURIComponent(sid)}`);
      if (!res.ok) return { error: `chat_sessions lookup failed (${res.status})` };
      return res.json();
    }
    case 'get_chat_messages': {
      const sid = args.session_id as string | undefined;
      if (!sid) return { error: 'session_id is required' };
      const params = new URLSearchParams();
      if (args.limit != null) params.set('limit', String(Math.min(Number(args.limit) || 50, 200)));
      if (args.before) params.set('before', String(args.before));
      const qs = params.toString();
      const res = await fetch(`${API_BASE}/api/chat/sessions/${encodeURIComponent(sid)}/messages${qs ? '?' + qs : ''}`);
      if (!res.ok) return { error: `chat_messages lookup failed (${res.status})` };
      return res.json();
    }
    case 'get_chat_logs': {
      const sid = args.session_id as string | undefined;
      if (!sid) return { error: 'session_id is required' };
      const params = new URLSearchParams();
      if (args.limit != null) params.set('limit', String(Math.min(Number(args.limit) || 50, 200)));
      const qs = params.toString();
      const res = await fetch(`${API_BASE}/api/chat/sessions/${encodeURIComponent(sid)}/logs${qs ? '?' + qs : ''}`);
      if (!res.ok) return { error: `chat_logs lookup failed (${res.status})` };
      return res.json();
    }
    case 'get_chat_log': {
      const lid = args.log_id as string | undefined;
      if (!lid) return { error: 'log_id is required' };
      const res = await fetch(`${API_BASE}/api/chat/logs/${encodeURIComponent(lid)}`);
      if (!res.ok) return { error: `chat_log ${lid} not found (${res.status})` };
      return res.json();
    }
    case 'search_executions': {
      const params = new URLSearchParams();
      if (args.status) params.set('status', String(args.status));
      if (args.workflow_name) params.set('workflowName', String(args.workflow_name));
      const qs = params.toString();
      const res = await fetch(`${API_BASE}/api/executions${qs ? '?' + qs : ''}`);
      return res.json();
    }
    case 'save_learning': {
      const url = `${API_BASE}/api/learnings`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: args.content,
          type: args.type ?? 'fact',
          target: 'agent',
          tags: ['chat', 'auto-extracted'],
          scope: { level: 'global' },
          source: { sourceType: 'human_correction', workflowName: 'chat', nodeName: 'chat', executionId: '', timestamp: new Date() },
          confidence: 0.9,
          status: 'active',
        }),
      });
      return res.json();
    }
    case 'ask_user': {
      // Store the question (non-blocking)
      await fetch(`${API_BASE}/api/chat/ask-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: args.question }),
      });
      // Poll for answer in 90s chunks (MCP-safe)
      let auWait = 3000;
      const auMaxWait = 30_000;
      const auDeadline = Date.now() + 90_000;
      while (Date.now() < auDeadline) {
        const statusRes = await fetch(`${API_BASE}/api/chat/ask-user/status`);
        const statusData = await statusRes.json() as Record<string, unknown>;
        if (statusData.status === 'answered') return { answer: statusData.answer };
        process.stderr.write(`[mcp] waiting for user answer (${Math.round(auWait / 1000)}s)\n`);
        await new Promise(r => setTimeout(r, auWait));
        auWait = Math.min(auWait * 1.3, auMaxWait);
      }
      return { status: 'waiting_for_user', message: 'User has not answered yet. Call ask_user again to continue waiting.' };
    }
    case 'report_to_user': {
      // report_to_user is handled in-process by the chat service, not via API
      // When called through MCP, it's a no-op that returns success
      return { reported: true, message: args.message, status: args.status ?? 'in_progress' };
    }
    case 'upload_file': {
      const url = `${API_BASE}/api/files/from-content`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: args.content, filename: args.filename, mimeType: args.mime_type }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (data.url) {
        // Return full public URL so agents can share it
        data.publicUrl = `${PUBLIC_BASE}${data.url}`;
      }
      return data;
    }

    // ── Artifacts ──
    // Root context is injected via env vars at spawn time. The tool is
    // idempotent for a given (root, filename) when overwrite=true.
    case 'allen_save_artifact': {
      const rootType = process.env.ALLEN_ARTIFACT_ROOT_TYPE;
      const rootId = process.env.ALLEN_ARTIFACT_ROOT_ID;
      if (!rootType || !rootId) {
        return { error: 'ALLEN_ARTIFACT_ROOT_TYPE / ALLEN_ARTIFACT_ROOT_ID env vars not set — artifact root is unknown. If you\'re running this agent directly without a spawner, use upload_file instead.' };
      }
      const body = {
        rootType,
        rootId,
        filename: args.filename,
        content: args.content,
        contentType: args.content_type,
        description: args.description,
        language: args.language,
        overwrite: args.overwrite ?? false,
        spawnContext: {
          originType: 'spawn_agent',
          agentName: process.env.ALLEN_ARTIFACT_AGENT_NAME,
          agentExecutionId: process.env.ALLEN_ARTIFACT_AGENT_EXECUTION_ID,
          nodeName: process.env.ALLEN_ARTIFACT_NODE_NAME,
          parentId: process.env.ALLEN_ARTIFACT_PARENT_ID,
        },
      };
      const res = await fetch(`${API_BASE}/api/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) return { error: data.error ?? `Save failed (${res.status})` };
      if (data.url) data.publicUrl = `${PUBLIC_BASE}${data.url}`;
      return data;
    }
    case 'allen_list_artifacts': {
      const rootType = (args.root_type as string | undefined) ?? process.env.ALLEN_ARTIFACT_ROOT_TYPE;
      const rootId = (args.root_id as string | undefined) ?? process.env.ALLEN_ARTIFACT_ROOT_ID;
      const params = new URLSearchParams();
      if (rootType) params.set('rootType', rootType);
      if (rootId) params.set('rootId', rootId);
      if (args.limit) params.set('limit', String(args.limit));
      return callAPI(`/api/artifacts${params.toString() ? '?' + params.toString() : ''}`);
    }
    case 'allen_get_artifact': {
      const id = args.artifact_id as string | undefined;
      if (!id) return { error: 'artifact_id is required' };
      const metaRes = await fetch(`${API_BASE}/api/artifacts/${encodeURIComponent(id)}`);
      if (!metaRes.ok) return { error: `Artifact "${id}" not found` };
      const meta = await metaRes.json() as Record<string, unknown>;
      // Fetch content via the public endpoint (same MIME rules as UI).
      const contentRes = await fetch(`${API_BASE}/api/artifacts/${encodeURIComponent(id)}/content`);
      const content = await contentRes.text();
      return { ...meta, content, publicUrl: `${PUBLIC_BASE}/api/artifacts/${encodeURIComponent(id)}/content` };
    }
    case 'context_quality_trigger_orchestrator':
      return callAPI('/api/context/quality/orchestrator/trigger', 'POST', {
        repoId: args.repoId, repoIds: args.repoIds, global: args.global, triggeredBy: args.triggeredBy ?? 'api',
      });
    case 'context_quality_begin_session':
      return callAPI('/api/context/quality/orchestrator/sessions', 'POST', {
        scope: args.scope, runScope: args.runScope, sourceId: args.sourceId, sourceKind: args.sourceKind, repoId: args.repoId,
        agentModel: args.agentModel, agentProvider: args.agentProvider, agentRationale: args.agentRationale,
        rootExecutionId: args.rootExecutionId ?? args.root_execution_id ?? SPAWN_ROOT_EXECUTION_ID,
        dry_run: args.dry_run,
      });
    case 'context_quality_log_decision':
      return callAPI(`/api/context/quality/orchestrator/sessions/${String(args.session_id)}/decisions`, 'POST', {
        kind: args.kind, detail: args.detail, metadata: args.metadata,
      });
    case 'context_quality_submit_findings':
      return callAPI(`/api/context/quality/orchestrator/sessions/${String(args.session_id)}/findings`, 'POST', {
        findings: args.findings,
      });
    case 'context_quality_finalize_session':
      return callAPI(`/api/context/quality/orchestrator/sessions/${String(args.session_id)}/finalize`, 'POST', {
        summary: args.summary,
      });
    case 'context_quality_get_session':
      return callAPI(`/api/context/quality/orchestrator/sessions/${String(args.session_id)}`);
    case 'context_quality_get_stage_state':
      return callAPI(`/api/context/quality/orchestrator/sessions/${String(args.session_id)}/stage-state`);
    case 'context_quality_get_repair_state':
      return callAPI('/api/context/quality/orchestrator/repair-state', 'POST', {
        sessionId: args.session_id ?? args.sessionId,
        rootExecutionId: args.root_execution_id ?? args.rootExecutionId,
        executionId: args.execution_id ?? args.executionId,
      });
    case 'context_quality_list_pending': {
      const qs: string[] = [`sourceType=${encodeURIComponent(String(args.sourceType ?? ''))}`];
      if (args.limit) qs.push(`limit=${Math.min(Number(args.limit), 50)}`);
      if (args.repoId) qs.push(`repoId=${encodeURIComponent(String(args.repoId))}`);
      if (args.repoIds) qs.push(`repoIds=${encodeURIComponent(JSON.stringify(args.repoIds))}`);
      if (args.allowBackfill) qs.push(`allowBackfill=true`);
      return callAPI(`/api/context/quality/scheduler/pending?${qs.join('&')}`);
    }
    case 'context_quality_log_source_evaluation':
      // Backwards-compatible alias — routes through the enhanced submit endpoint
      // so all new fields (contextCorrect, evidence, etc.) are preserved when passed.
      return callAPI('/api/context/quality/source-evaluations/submit', 'POST', {
        sessionId: args.session_id,
        judgeRunId: args.judge_run_id,
        repoId: args.repo_id,
        sourceType: args.source_type,
        sourceId: args.source_id,
        contextAttemptId: args.context_attempt_id,
        executionId: args.execution_id,
        flowKind: args.flow_kind,
        decision: args.decision,
        status: args.status ?? 'completed',
        reason: args.reason,
        findingIds: args.finding_ids,
      });
    case 'context_quality_submit_source_evaluation':
      return callAPI('/api/context/quality/source-evaluations/submit', 'POST', {
        sessionId: args.session_id ?? args.sessionId,
        judgeRunId: args.judge_run_id ?? args.judgeRunId,
        repoId: args.repo_id ?? args.repoId,
        sourceType: args.source_type ?? args.sourceType,
        sourceId: args.source_id ?? args.sourceId,
        sourceKind: args.source_kind ?? args.sourceKind,
        contextAttemptId: args.context_attempt_id ?? args.contextAttemptId,
        executionId: args.execution_id ?? args.executionId,
        flowKind: args.flow_kind ?? args.flowKind,
        workerAssignmentId: args.worker_assignment_id ?? args.workerAssignmentId,
        decision: args.decision,
        status: args.status ?? 'completed',
        reason: args.reason,
        classification: args.classification,
        fixType: args.fix_type ?? args.fixType,
        confidence: args.confidence,
        risk: args.risk,
        severity: args.severity,
        findingIds: args.finding_ids ?? args.findingIds,
        contextCorrect: args.context_correct ?? args.contextCorrect,
        contextVerdict: args.context_verdict ?? args.contextVerdict,
        contextIncomplete: args.context_incomplete ?? args.contextIncomplete,
        contextIrrelevant: args.context_irrelevant ?? args.contextIrrelevant,
        mandatoryMissing: args.mandatory_missing ?? args.mandatoryMissing,
        mandatoryIncorrect: args.mandatory_incorrect ?? args.mandatoryIncorrect,
        overFiltered: args.over_filtered ?? args.overFiltered,
        overInjected: args.over_injected ?? args.overInjected,
        wrongScope: args.wrong_scope ?? args.wrongScope,
        staleContext: args.stale_context ?? args.staleContext,
        affectedRefIds: args.affected_ref_ids ?? args.affectedRefIds,
        expectedContextKinds: args.expected_context_kinds ?? args.expectedContextKinds,
        remediationHints: args.remediation_hints ?? args.remediationHints,
        evidence: args.evidence,
        notes: args.notes,
        evidenceSummary: args.evidence_summary ?? args.evidenceSummary,
        evaluationVersion: args.evaluation_version ?? args.evaluationVersion,
      });
    case 'context_quality_list_unevaluated_traces': {
      const utqs: string[] = [];
      if (args.repo_id ?? args.repoId) utqs.push(`repoId=${encodeURIComponent(String(args.repo_id ?? args.repoId))}`);
      if (args.session_id ?? args.sessionId) utqs.push(`sessionId=${encodeURIComponent(String(args.session_id ?? args.sessionId))}`);
      if (args.limit) utqs.push(`limit=${Math.min(Number(args.limit), 20)}`);
      if (args.cursor) utqs.push(`cursor=${encodeURIComponent(String(args.cursor))}`);
      if (args.exclude_root_execution_id ?? args.excludeRootExecutionId) utqs.push(`excludeRootExecutionId=${encodeURIComponent(String(args.exclude_root_execution_id ?? args.excludeRootExecutionId))}`);
      if (args.exclude_execution_ids ?? args.excludeExecutionIds) utqs.push(`excludeExecutionIds=${encodeURIComponent(JSON.stringify(args.exclude_execution_ids ?? args.excludeExecutionIds))}`);
      if (args.exclude_agent_names ?? args.excludeAgentNames) utqs.push(`excludeAgentNames=${encodeURIComponent(JSON.stringify(args.exclude_agent_names ?? args.excludeAgentNames))}`);
      return callAPI(`/api/context/quality/scheduler/unevaluated-traces${utqs.length ? '?' + utqs.join('&') : ''}`);
    }
    case 'context_quality_create_trace_analysis_assignment':
      return callAPI('/api/context/quality/trace-analysis-assignments', 'POST', {
        sessionId: args.session_id ?? args.sessionId,
        repoId: args.repo_id ?? args.repoId,
        sourceIds: args.source_ids ?? args.sourceIds,
        workerAgentName: args.worker_agent_name ?? args.workerAgentName,
        retryOfAssignmentId: args.retry_of_assignment_id ?? args.retryOfAssignmentId,
      });
    case 'context_quality_create_trace_analysis_wave':
    case 'context_quality_create_trace_analysis_assignment_wave':
      return callAPI('/api/context/quality/trace-analysis-assignments/wave', 'POST', {
        sessionId: args.session_id ?? args.sessionId,
        repoId: args.repo_id ?? args.repoId,
        maxAssignments: args.max_assignments ?? args.maxAssignments,
        limitPerAssignment: args.limit_per_assignment ?? args.limitPerAssignment,
        excludeRootExecutionId: args.exclude_root_execution_id ?? args.excludeRootExecutionId,
        excludeExecutionIds: args.exclude_execution_ids ?? args.excludeExecutionIds,
        excludeAgentNames: args.exclude_agent_names ?? args.excludeAgentNames,
      });
    case 'context_quality_list_trace_analysis_assignments': {
      const taqs: string[] = [];
      if (args.session_id ?? args.sessionId) taqs.push(`sessionId=${encodeURIComponent(String(args.session_id ?? args.sessionId))}`);
      if (args.status) taqs.push(`status=${encodeURIComponent(String(args.status))}`);
      if (args.limit) taqs.push(`limit=${Number(args.limit)}`);
      if (args.offset) taqs.push(`offset=${Number(args.offset)}`);
      return callAPI(`/api/context/quality/trace-analysis-assignments${taqs.length ? '?' + taqs.join('&') : ''}`);
    }
    case 'context_quality_get_trace_analysis_assignment': {
      const assignmentId = String(args.assignment_id ?? '');
      if (!assignmentId) return { error: 'assignment_id is required' };
      return callAPI(`/api/context/quality/trace-analysis-assignments/${encodeURIComponent(assignmentId)}`);
    }
    case 'context_quality_update_trace_analysis_assignment':
      return callAPI(`/api/context/quality/trace-analysis-assignments/${String(args.assignment_id ?? '')}`, 'PATCH', {
        status: args.status,
        workerExecutionId: args.worker_execution_id ?? args.workerExecutionId,
        workerAgentName: args.worker_agent_name ?? args.workerAgentName,
        evaluatedCount: args.evaluated_count ?? args.evaluatedCount,
        skippedCount: args.skipped_count ?? args.skippedCount,
        failedCount: args.failed_count ?? args.failedCount,
        findingCount: args.finding_count ?? args.findingCount,
        error: args.error,
        terminalReason: args.terminal_reason ?? args.terminalReason,
      });
    case 'context_quality_list_source_evaluations': {
      const seqs: string[] = [];
      const seSessionId = String(args.session_id ?? args.sessionId ?? '');
      if (!seSessionId) return { error: 'session_id is required' };
      seqs.push(`sessionId=${encodeURIComponent(seSessionId)}`);
      if (args.source_type ?? args.sourceType) seqs.push(`sourceType=${encodeURIComponent(String(args.source_type ?? args.sourceType))}`);
      if (args.decision) seqs.push(`decision=${encodeURIComponent(String(args.decision))}`);
      if (args.limit) seqs.push(`limit=${Number(args.limit)}`);
      return callAPI(`/api/context/quality/source-evaluations?${seqs.join('&')}`);
    }
    case 'context_quality_list_findings': {
      const fqs: string[] = [];
      if (args.judgeRunId) fqs.push(`judgeRunId=${encodeURIComponent(String(args.judgeRunId))}`);
      if (args.scope) fqs.push(`scope=${encodeURIComponent(String(args.scope))}`);
      if (args.status) fqs.push(`status=${encodeURIComponent(String(args.status))}`);
      if (args.limit) fqs.push(`limit=${Math.min(Number(args.limit), 100)}`);
      if (args.offset) fqs.push(`offset=${Number(args.offset)}`);
      return callAPI(`/api/context/quality/findings${fqs.length ? '?' + fqs.join('&') : ''}`);
    }
    case 'context_quality_update_worker_assignment':
      return callAPI(`/api/context/quality/worker-assignments/${String(args.assignment_id)}`, 'PATCH', {
        status: args.status, notes: args.notes, result: args.result,
        agentRunId: args.agentRunId, agentExecutionId: args.agentExecutionId,
        workerRole: args.workerRole ?? args.worker_role,
        agentName: args.agentName ?? args.agent_name,
      });
    case 'context_quality_create_worker_assignment':
      return callAPI('/api/context/quality/worker-assignments', 'POST', {
        maxBatch: args.maxBatch, workerAgentName: args.workerAgentName, workerRole: args.workerRole,
        remediationIds: args.remediationIds ?? args.remediation_ids,
        repairMode: args.repairMode ?? args.repair_mode,
        rootExecutionId: args.rootExecutionId ?? args.root_execution_id,
        sessionId: args.sessionId ?? args.session_id,
      });
    case 'context_quality_patch_finding':
      return callAPI(`/api/context/quality/findings/${String(args.finding_id)}`, 'PATCH', {
        status: args.status, suggestedRemediation: args.suggestedRemediation,
      });
    case 'context_quality_create_remediation_task':
      return callAPI('/api/context/quality/remediation-tasks', 'POST', {
        // GAP 6: pass required fields matching the REST route contract
        taskId: args.taskId,
        findingId: args.findingId,
        judgeRunId: args.judgeRunId,
        // actionKind takes priority; fixType is backwards-compat alias handled by route
        actionKind: args.actionKind,
        remediationKind: args.remediationKind,
        fixType: args.fixType,
        workerRole: args.workerRole,
        targetEntryId: args.targetEntryId,
        targetEntryIds: args.targetEntryIds,
        targetRefId: args.targetRefId,
        targetRefIds: args.targetRefIds,
        targetMappingId: args.targetMappingId,
        targetMappingIds: args.targetMappingIds,
        targetRepoId: args.targetRepoId,
        sourceEvaluationIds: args.sourceEvaluationIds ?? args.source_evaluation_ids,
        affectedRefIds: args.affectedRefIds ?? args.affected_ref_ids,
        proposedPatch: args.proposedPatch,
        retrievalReplayId: args.retrievalReplayId,
        validationPlan: args.validationPlan,
        estimatedRisk: args.estimatedRisk,
        confidence: args.confidence,
        humanGateRequired: args.humanGateRequired,
      });
    case 'context_quality_list_remediation_tasks': {
      const rqs: string[] = [];
      if (args.taskId) rqs.push(`taskId=${encodeURIComponent(String(args.taskId))}`);
      if (args.remediationId) rqs.push(`remediationId=${encodeURIComponent(String(args.remediationId))}`);
      if (args.workerRole) rqs.push(`workerRole=${encodeURIComponent(String(args.workerRole))}`);
      if (args.status) rqs.push(`status=${encodeURIComponent(String(args.status))}`);
      if (args.limit) rqs.push(`limit=${Number(args.limit)}`);
      if (args.offset) rqs.push(`offset=${Number(args.offset)}`);
      return callAPI(`/api/context/quality/remediation-tasks${rqs.length ? '?' + rqs.join('&') : ''}`);
    }
    case 'context_quality_dispatch_remediation_task':
      return callAPI(`/api/context/quality/remediation-tasks/${String(args.task_id)}/dispatch`, 'POST', {});
    case 'context_quality_create_learning_promotion':
      return callAPI('/api/context/quality/learning-promotions', 'POST', {
        learningId: args.learningId, rootExecutionId: args.rootExecutionId, sessionId: args.sessionId, reviewTaskId: args.reviewTaskId,
        action: args.action, targetRepoId: args.targetRepoId, targetEntryId: args.targetEntryId,
        targetRepoIds: args.targetRepoIds, targetEntryIds: args.targetEntryIds, targetRefIds: args.targetRefIds,
        affectedRefIds: args.affectedRefIds, sourceEvaluationIds: args.sourceEvaluationIds,
        proposedPatch: args.proposedPatch, confidence: args.confidence,
        estimatedRisk: args.estimatedRisk, humanGateRequired: args.humanGateRequired,
        sourceValidationStatus: args.sourceValidationStatus,
        conflictStatus: args.conflictStatus,
        remediationId: args.remediationId, scope: args.scope,
        suggestedContent: args.suggestedContent,
        proposedCuratedText: args.proposedCuratedText,
      });
    case 'context_quality_decide_learning_promotion':
      return callAPI(`/api/context/quality/learning-promotions/${String(args.promotion_id)}/decisions`, 'POST', {
        decision: args.decision, reason: args.reason,
      });
    case 'context_quality_apply_curated_edit':
      return callAPI(`/api/context/quality/curated-edits/${pathSegment(args.repo_id)}/${pathSegment(args.entry_id)}`, 'POST', {
        action: args.action, content: args.content, patch: args.patch, proposedPatch: args.proposedPatch, metadataUpdates: args.metadataUpdates,
        sourceReviewTaskId: args.sourceReviewTaskId, sourceLearningId: args.sourceLearningId,
        sourcePromotionId: args.sourcePromotionId, remediationId: args.remediationId,
        expectedEntryVersionId: args.expectedEntryVersionId ?? args.expected_entry_version_id,
      });
    case 'context_quality_get_curated_entry':
      return callAPI(`/api/context/quality/curated-entries/${pathSegment(args.repo_id)}/${pathSegment(args.entry_id)}`);
    case 'context_quality_get_curation_history':
      return callAPI(`/api/context/quality/curated-edits/${pathSegment(args.repo_id)}/${pathSegment(args.entry_id)}/history`);
    case 'context_quality_revert_curated_edit':
      return callAPI(`/api/context/quality/curated-edits/${pathSegment(args.repo_id)}/${pathSegment(args.entry_id)}/revert/${pathSegment(args.revision_id)}`, 'POST', {});
    default: {
      // Fallback dispatcher: forward any tool not handled above to the generic
      // /api/chat/tools/:toolName endpoint, which dispatches via executeChatTool().
      // This is how the phase-4 meta tools (create_team, create_agent, etc.)
      // become callable from spawned agents — they're registered in chatTools[]
      // server-side, the generic endpoint picks them up automatically, and we
      // don't need a hardcoded case here for every new tool.
      try {
        const url = `${API_BASE}/api/chat/tools/${encodeURIComponent(name)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { error: `Tool "${name}" failed: HTTP ${res.status} ${text}` };
        }
        return await res.json();
      } catch (err) {
        return { error: `Tool "${name}" call failed: ${(err as Error).message}` };
      }
    }
  }
}

// ── MCP JSON-RPC Protocol ──

let initialized = false;

async function handleMessage(msg: { jsonrpc: string; id: string | number; method: string; params?: unknown }): Promise<unknown> {
  switch (msg.method) {
    case 'initialize':
      initialized = true;
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '1.0.0' },
      };

    case 'notifications/initialized':
      return undefined; // No response needed

    case 'tools/list':
      return {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(t.params).map(([k, v]) => [k, {
                type: paramJsonType(v as string),
                description: v,
              }]),
            ),
          },
        })),
      };

    case 'tools/call': {
      const p = msg.params as { name: string; arguments?: Record<string, unknown> };
      try {
        const result = await executeTool(p.name, p.arguments ?? {});
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    }

    default:
      return undefined;
  }
}

// ── Stdio Transport ──

process.stderr.write(`${BRAND_NAME} MCP server running on stdio\n`);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      const result = await handleMessage(msg);
      if (result !== undefined && msg.id !== undefined) {
        process.stdout.write(JSON.stringify({ result, jsonrpc: '2.0', id: msg.id }) + '\n');
      }
    } catch (err) {
      if ((JSON.parse(line)).id !== undefined) {
        process.stdout.write(JSON.stringify({
          error: { code: -32603, message: (err as Error).message },
          jsonrpc: '2.0',
          id: JSON.parse(line).id,
        }) + '\n');
      }
    }
  }
});
