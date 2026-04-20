#!/usr/bin/env node
/**
 * Allen MCP Server
 * Exposes all 16 built-in chat tools as an MCP server (stdio transport).
 * Both Codex CLI and Claude CLI can connect to this as a native MCP server.
 *
 * Usage: node allen-mcp-server.js
 * Env: ALLEN_API_URL (default: http://localhost:4023)
 */

// This runs as a standalone process — communicates via stdin/stdout JSON-RPC.
// It calls the Allen API (HTTP) to execute tools instead of importing chat-tools.ts directly.
// This way it works without a database connection — just needs the API server running.

import { BRAND_NAME, MCP_SERVER_NAME } from '@allen/engine';

const API_BASE = process.env.ALLEN_API_URL ?? `http://localhost:${process.env.PORT ?? '4023'}`;

// Spawn-tree context — passed in by whoever launched this MCP server (a
// workflow node's claude-cli, or an already-spawned agent's claude-cli).
// These are propagated via env because the Claude Code SDK passes parent
// env to its stdio MCP children. When this process invokes `spawn_agent`,
// we forward them to the HTTP endpoint so chat-tools can record
// parent/root linkage on the newly-created execution row.
const SPAWN_PARENT_EXECUTION_ID = process.env.ALLEN_PARENT_EXECUTION_ID || undefined;
const SPAWN_PARENT_CALLER = process.env.ALLEN_PARENT_CALLER || undefined;
const SPAWN_ROOT_EXECUTION_ID = process.env.ALLEN_ROOT_EXECUTION_ID || undefined;

// ── Auth: mint a short-lived JWT using the shared secret ──
// The MCP server runs as a child process of the main server and shares
// JWT_ACCESS_SECRET via env. We mint a system-admin token on demand and
// cache it for a few minutes to avoid re-signing on every call.

import jwt, { type SignOptions } from 'jsonwebtoken';

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
  return originalFetch(input, { ...init, headers: mergedHeaders });
};

// ── Helpers ──

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
  // ── Workflows ──
  { name: 'list_workflows', description: 'List all workflows with name, description, node count, validation status.', params: {} },
  { name: 'get_workflow', description: 'Get full details of a specific workflow: YAML source, parsed nodes, edges, input schema, version.', params: { name: 'string — workflow name', id: 'string — workflow MongoDB _id (use name OR id)' } },
  { name: 'run_workflow', description: 'Start executing a workflow. Returns execution ID.', params: { workflow_name: 'string (required)', input: 'object — workflow input parameters' } },
  { name: 'validate_workflow', description: 'Validate a workflow YAML or parsed object against the live agent registry. Returns { valid, errors, warnings }. Read-only.', params: { yaml: 'string — YAML source', parsed: 'object — parsed workflow object (alternative to yaml)' } },
  { name: 'create_workflow', description: 'Create a new workflow. ONLY workflow-builder-agent.', params: { yaml: 'string — YAML source (preferred)', parsed: 'object — parsed workflow object (alternative)', tags: 'object — optional tags array' } },
  { name: 'update_workflow', description: 'Update an existing workflow by name or id. ONLY workflow-builder-agent. Bumps version.', params: { id: 'string — MongoDB ObjectId', name: 'string — workflow name (used when id omitted)', yaml: 'string — new YAML source', parsed: 'object — new parsed workflow object' } },

  // ── Executions ──
  { name: 'wait_for_execution', description: 'Poll an execution until it completes. Blocks up to 90s. Returns response when done. If status="waiting", call again.', params: { execution_id: 'string (required)' } },
  { name: 'list_executions', description: 'List recent executions. Filter by status or workflow name.', params: { status: 'string', workflow_name: 'string', limit: 'number' } },
  { name: 'search_executions', description: 'Search executions with filters: date range, cost, failed nodes.', params: { workflow_name: 'string', status: 'string', since_hours: 'number', min_cost: 'number', has_failed_node: 'boolean', limit: 'number' } },
  { name: 'cancel_execution', description: 'Cancel a running execution.', params: { execution_id: 'string (required)' } },
  { name: 'submit_execution_input', description: 'Submit input to a paused workflow execution (e.g. answer a human node).', params: { execution_id: 'string (required)', node: 'string (required)', data: 'object (required)' } },
  { name: 'get_node_trace', description: 'Get detailed trace of a specific node execution: prompt, response, outputs, cost, duration.', params: { execution_id: 'string (required)', node_name: 'string (required)' } },
  { name: 'get_execution_logs', description: 'Get execution logs filtered by node, level, or category.', params: { execution_id: 'string (required)', node: 'string', level: 'string', category: 'string', limit: 'number' } },

  // ── Agents ──
  { name: 'list_agents', description: 'List all agents with minimal info: name, displayName, teamName, type, model, provider. Use get_agent for full details.', params: {} },
  { name: 'get_agent', description: 'Get full details of a specific agent: system prompt, tools, capabilities, model, provider, canDelegateTo, personality, description.', params: { name: 'string (required) — agent slug' } },
  { name: 'create_agent', description: 'Create a new agent in a team. Team must exist. ONLY builder agents.', params: { name: 'string (required) — lowercase slug', displayName: 'string (required)', description: 'string — short description of what the agent does', teamName: 'string (required) — existing team slug', teamRole: 'string (required) — "lead" or "member"', system: 'string (required) — full system prompt', provider: 'string (required) — "claude-cli" or "codex"', model: 'string', tools: 'object — array of tool names', capabilities: 'object — array of capability tags', canDelegateTo: 'object — array of agent names', personality: 'string', icon: 'string', color: 'string' } },
  { name: 'update_agent', description: 'Update an agent: system prompt, model, provider, tools, capabilities, canDelegateTo, personality, displayName, description.', params: { name: 'string (required)', displayName: 'string', description: 'string', system: 'string', tools: 'object', capabilities: 'object', canDelegateTo: 'object', personality: 'string', model: 'string', provider: 'string' } },
  { name: 'delete_agent', description: 'Delete an agent. Refuses built-in agents and team leads. Requires confirm=true.', params: { name: 'string (required)', confirm: 'boolean (required) — must be true' } },
  { name: 'move_agent_to_team', description: 'Move one or more agents to a different team. Works for any cross-team move including unassigned → team.', params: { agent_names: 'object — array of agent name strings (required)', team_name: 'string (required) — target team slug' } },
  { name: 'spawn_agent', description: 'Spawn an agent in the background. Returns immediately with execution_id. Pass session_id to resume a previous session.', params: { agent_name: 'string (required)', prompt: 'string (required)', repo_path: 'string — optional repo path', session_id: 'string — session ID from previous spawn to resume' } },

  // ── Teams ──
  { name: 'list_teams', description: 'List all teams: name, displayName, mission, lead, parent, isBuiltIn.', params: {} },
  { name: 'get_team', description: 'Get a team\'s metadata and member list (names + roles, without system prompts). Use get_team_blueprint for the deep view.', params: { name: 'string (required) — team slug' } },
  { name: 'get_team_blueprint', description: 'Full team blueprint: metadata, all members WITH system prompts, delegation edges. Use before adding agents.', params: { team_name: 'string (required) — team slug' } },
  { name: 'list_team_members', description: 'List agents in a team with name, displayName, teamRole, capabilities, tools, canDelegateTo.', params: { team_name: 'string (required) — team slug' } },
  { name: 'create_team', description: 'Create a team. Lead agent must exist first. ONLY team-builder-agent.', params: { name: 'string (required) — lowercase slug', displayName: 'string (required)', description: 'string', mission: 'string', leadAgentName: 'string (required) — lead agent name', parentTeamName: 'string — optional parent team' } },
  { name: 'update_team', description: 'Update a team\'s displayName, description, mission, or parent. ONLY team-builder-agent.', params: { name: 'string (required)', displayName: 'string', description: 'string', mission: 'string', parentTeamName: 'string' } },
  { name: 'delete_team', description: 'Delete a team. Refuses if it has members. Requires confirm=true. ONLY team-builder-agent.', params: { name: 'string (required)', confirm: 'boolean (required) — must be true' } },

  // ── Repos ──
  { name: 'list_repos', description: 'List registered repositories with tech stack.', params: {} },
  { name: 'get_repo_context', description: 'Get the deep agent-generated context document for a repo (markdown describing each module).', params: { repo_path: 'string (required) — absolute path of a registered repo or workspace worktree' } },
  { name: 'find_repo_for_pr_url', description: 'Given a GitHub PR URL, find the registered Allen repo whose remote matches (owner/repo). Returns null if the repo is not registered.', params: { pr_url: 'string (required) — https://github.com/<owner>/<repo>/pull/<n>' } },

  // ── Pull Requests ──
  { name: 'find_pr_by_url', description: 'Look up a pull_requests row by full PR URL. Returns the stored metadata (workspaceId, originatingExecutionId, processedCommentIds, resolutionAttempts, …) or null.', params: { pr_url: 'string (required)' } },
  { name: 'mark_pr_synced', description: 'Stamp a pull_requests row with a completed CodeRabbit-resolution round. Appends processedCommentIds, increments resolutionAttempts, records lastReviewedHeadSha.', params: { pr_id: 'string (required) — pull_requests _id', head_sha: 'string (required)', processed_comment_ids: 'object — array of GH comment id strings that were applied' } },

  // ── Workspaces ──
  { name: 'get_workspace', description: 'Fetch a workspace row by id. Returns worktreePath, branch, baseBranch, status, repoId, prUrl, services, and more.', params: { workspace_id: 'string (required) — workspaces _id' } },
  { name: 'create_workspace_for_pr', description: 'Create a fresh workspace from a PR branch (Flow B). Used when a PR has no linked workspace. Polls until setup completes. Returns { workspace_id, worktree_path, branch, base_branch }.', params: { pr_url: 'string (required)', repo_id: 'string (required)', branch: 'string (required) — PR head branch', base_branch: 'string (required) — PR base branch', pr_number: 'number (required)', pr_title: 'string — optional display name' } },

  // ── Delegation & Communication ──
  { name: 'delegate_to_agent', description: 'Delegate a task to another agent. Pass conversation_id to continue an existing thread.', params: { agent_name: 'string (required)', task: 'string (required)', context: 'object — relevant context', conversation_id: 'string — existing conversation ID to continue' } },
  { name: 'wait_for_delegation', description: 'Wait for a delegated task to finish. Blocks up to 90s. If "waiting" call again. If "question" — answer via answer_delegator then call again.', params: { conversation_id: 'string (required)' } },
  { name: 'answer_delegator', description: 'Answer a question from an agent you delegated to. Use when wait_for_delegation returns status="question".', params: { conversation_id: 'string (required)', answer: 'string (required)' } },
  { name: 'ask_delegator', description: 'Ask a question to the agent who delegated this task to you. Blocks until they answer.', params: { question: 'string (required)', conversation_id: 'string — optional, auto-detected from context' } },
  { name: 'ask_user', description: 'Ask the user a question directly. Blocks until they answer. Only use when no agent can help.', params: { question: 'string (required)' } },
  { name: 'report_to_user', description: 'Send a progress update to the user during a delegation chain.', params: { message: 'string (required)', status: 'string — in_progress | completed | needs_input' } },

  // ── Self-introspection ──
  { name: 'get_my_session_history', description: 'Get your own chat session message history. Use to re-read the user\'s original request or see your prior responses.', params: { limit: 'number — max messages (default 30, max 100)' } },
  { name: 'get_my_delegation_thread', description: 'Get messages in your current delegation thread. Only works for delegated agents.', params: {} },

  // ── Knowledge & Data ──
  { name: 'search_learnings', description: 'Search the learning system. Filter by workflow, type, or limit.', params: { workflow_name: 'string', type: 'string', limit: 'number' } },
  { name: 'save_learning', description: 'Save a learning/correction to memory. Call when user corrects you or states a preference.', params: { content: 'string (required) — generalized rule', type: 'string (required) — fact, pattern, mistake, or preference' } },
  { name: 'get_dashboard_stats', description: 'Get dashboard statistics: workflow count, executions, success rate, agent count.', params: {} },
  { name: 'query_database', description: 'Read-only MongoDB query. Allowed collections: workflows, executions, agents, repos, learnings, chat_sessions, execution_logs, node_traces.', params: { collection: 'string (required)', filter: 'object', projection: 'object', sort: 'object', limit: 'number (max 20)' } },

  // ── File upload ──
  { name: 'upload_file', description: 'Upload a file to Allen storage. Returns a permanent public URL.', params: { content: 'string (required) — file content', filename: 'string (required) — e.g. "report.md"', mime_type: 'string — MIME type (default: text/plain)' } },
];

// ── API Call Helper ──

async function callAPI(endpoint: string, method = 'GET', body?: unknown): Promise<unknown> {
  const url = `${API_BASE}${endpoint}`;
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) return { error: `API ${res.status}: ${await res.text().catch(() => 'unknown')}` };
  return res.json();
}

// ── Tool Execution via API ──

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_workflows': return callAPI('/api/workflows');
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
          return data;
        }
        process.stderr.write(`[mcp] waiting for execution ${execId} (${Math.round(eWait / 1000)}s interval)\n`);
        await new Promise(r => setTimeout(r, eWait));
        eWait = Math.min(eWait * 1.3, eMaxWait);
      }
      return { id: execId, status: 'waiting', message: 'Execution still running. Call wait_for_execution again.' };
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
      const url = `${API_BASE}/api/executions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId: wf._id, input: args.input ?? {} }),
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
          return {
            workspace_id: wsId,
            worktree_path: cur.worktreePath,
            branch: cur.branch,
            base_branch: cur.baseBranch,
            status: cur.status,
          };
        }
        if (cur?.status === 'failed') return { error: 'workspace setup failed' };
        await new Promise(r => setTimeout(r, 2000));
      }
      return { error: 'workspace setup timed out (10 min)' };
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
        provider: a.provider ?? 'claude-cli',
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
          repo_path: args.repo_path,
          session_id: args.session_id,
          // Spawn-tree linkage — lets the execution row carry its caller
          // label, parent pointer, and root pointer so the parent workflow's
          // execution page can find and track its spawned children.
          parent_execution_id: SPAWN_PARENT_EXECUTION_ID,
          parent_caller: SPAWN_PARENT_CALLER,
          root_execution_id: SPAWN_ROOT_EXECUTION_ID,
        }),
      });
      return res.json();
    }
    case 'query_database': {
      const collection = args.collection as string;
      const allowed = ['workflows', 'executions', 'agents', 'repos', 'learnings', 'chat_sessions', 'execution_logs', 'node_traces'];
      if (!allowed.includes(collection)) return { error: `Collection "${collection}" not allowed. Allowed: ${allowed.join(', ')}` };
      const params = new URLSearchParams();
      if (args.limit) params.set('limit', String(args.limit));
      const res = await fetch(`${API_BASE}/api/${collection === 'chat_sessions' ? 'chat/sessions' : collection}?${params}`);
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
    case 'delegate_to_agent': {
      const url = `${API_BASE}/api/chat/delegate`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_name: args.agent_name, task: args.task, context: args.context, conversation_id: args.conversation_id }),
      });
      return res.json();
    }
    case 'wait_for_delegation': {
      // Chunked long-poll: wait up to 90s (under MCP's 120s transport timeout), then return
      // If still active, return { status: "waiting" } so the LLM calls again
      const convId = args.conversation_id;
      let waitMs = 5000;
      const maxWait = 30_000;
      const chunkDeadline = Date.now() + 90_000; // 90s max per call
      while (Date.now() < chunkDeadline) {
        const res = await fetch(`${API_BASE}/api/chat/delegation/${convId}/status`);
        const data = await res.json() as Record<string, unknown>;
        // Return immediately for anything except 'active' (completed, failed, waiting_for_answer)
        if (data.status !== 'active') {
          // Map waiting_for_answer to 'question' for the LLM
          if (data.status === 'waiting_for_answer') data.status = 'question';
          return data;
        }
        process.stderr.write(`[mcp] waiting for delegation ${convId} (${Math.round(waitMs / 1000)}s interval)\n`);
        await new Promise(r => setTimeout(r, waitMs));
        waitMs = Math.min(waitMs * 1.3, maxWait);
      }
      // Return "waiting" so the LLM calls wait_for_delegation again
      return {
        conversation_id: convId,
        status: 'waiting',
        message: 'Agent is still working. Call wait_for_delegation again — it will continue waiting.',
      };
    }
    case 'answer_delegator': {
      const url = `${API_BASE}/api/chat/delegate`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'answer_delegator', conversation_id: args.conversation_id, answer: args.answer }),
      });
      return res.json();
    }
    case 'ask_delegator': {
      // Blocks server-side until the caller answers
      const url = `${API_BASE}/api/chat/ask-caller`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: args.conversation_id, question: args.question }),
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
        data.publicUrl = `${API_BASE}${data.url}`;
      }
      return data;
    }
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
