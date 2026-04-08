/**
 * Chat Tools — Functions available to the FlowForge Chat assistant.
 * Each tool has a name, description, input schema, and execute function.
 * The chat service registers these with the Anthropic Messages API for native tool calling.
 */

import type { Db, ObjectId } from 'mongodb';
import { ExecutionService } from './execution.service.js';
import { embedAndSave, invalidateCache } from './embedding.service.js';
import { AgentConversationService } from './agent-conversation.service.js';

// ── Active Session Registry ──────────────────────────────────────────────────
// When chat.service starts processing a message, it registers the session context.
// delegation tools (delegate_to_agent, report_to_user) read from this registry
// to know which session they're running in, even when called via MCP → API chain.

export interface ActiveSessionContext {
  chatSessionId: string;
  parentMessageId: string;
  /** Which agent is currently responding (undefined = FlowForge Assistant) */
  currentAgent?: string;
  /** Current delegation depth (0 = top-level chat, 1+ = delegated) */
  delegationDepth: number;
  /** Current conversation ID (for tracking parent-child delegation chains) */
  currentConversationId?: string;
  /** Broadcast SSE events to the chat listeners */
  broadcastEvent: (event: string, data: Record<string, unknown>) => void;
  /** Number of background tasks (delegations/spawns) still running */
  pendingBackgroundTasks: number;
}

// One active context per session (only one response at a time per session)
const activeSessions = new Map<string, ActiveSessionContext>();

/** Register a session context when starting to process a message */
export function registerActiveSession(ctx: ActiveSessionContext): void {
  activeSessions.set(ctx.chatSessionId, ctx);
}

/** Unregister when message processing completes */
export function unregisterActiveSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

/** Get the active context for a session (used by delegation tools) */
export function getActiveSession(sessionId: string): ActiveSessionContext | undefined {
  return activeSessions.get(sessionId);
}

/** Find any active session (for API-triggered delegations that don't know the session) */
export function getAnyActiveSession(): ActiveSessionContext | undefined {
  for (const ctx of activeSessions.values()) return ctx;
  return undefined;
}

/** Wait until all background tasks for a session are complete */
export async function waitForBackgroundTasks(sessionId: string, maxWaitMs = 3_600_000): Promise<void> {
  const startMs = Date.now();
  while (Date.now() - startMs < maxWaitMs) {
    const ctx = activeSessions.get(sessionId);
    if (!ctx || ctx.pendingBackgroundTasks <= 0) return;
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Tool Definition Shape ──

export interface ChatTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** If true, this tool mutates state (requires approval in guided/manual mode) */
  destructive?: boolean;
  execute: (args: Record<string, unknown>, db: Db) => Promise<Record<string, unknown>>;
}

/** Tools that mutate state — require approval in guided mode */
export const DESTRUCTIVE_TOOLS = new Set([
  'run_workflow', 'cancel_execution', 'spawn_agent', 'submit_execution_input', 'delegate_to_agent',
  // MCP tools that mutate (linear create/edit/delete)
  'mcp__linear__linear_create_issue', 'mcp__linear__linear_edit_issue',
  'mcp__linear__linear_delete_issue', 'mcp__linear__linear_create_comment',
  'mcp__linear__linear_bulk_update_issues',
]);

// ── Helpers ──

/** Recursively strip dangerous MongoDB operators from a filter object. */
function sanitizeFilter(obj: Record<string, unknown>, forbidden: string[]): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (forbidden.includes(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = sanitizeFilter(value as Record<string, unknown>, forbidden);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

// ── Tool Implementations ──

const listWorkflows: ChatTool = {
  name: 'list_workflows',
  description: 'List all available workflows. Returns name, description, node count, and validation status.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_args, db) {
    const workflows = await db.collection('workflows')
      .find({ archived: { $ne: true } })
      .project({ name: 1, description: 1, parsed: 1, validation: 1, version: 1, updatedAt: 1 })
      .sort({ updatedAt: -1 })
      .limit(50)
      .toArray();

    return {
      workflows: workflows.map(w => ({
        id: (w._id as ObjectId).toString(),
        name: w.name,
        description: w.description ?? '',
        nodeCount: w.parsed?.nodes ? Object.keys(w.parsed.nodes).length : 0,
        isValid: w.validation?.valid ?? false,
        version: w.version ?? 1,
      })),
    };
  },
};

const runWorkflow: ChatTool = {
  name: 'run_workflow',
  description: 'Start executing a workflow with given input parameters. Returns execution ID to track progress. Use list_workflows first to find the workflow name and ID.',
  inputSchema: {
    type: 'object',
    properties: {
      workflow_name: { type: 'string', description: 'Name of the workflow to run (e.g., "coding-agent", "blog-post")' },
      input: {
        type: 'object',
        description: 'Input parameters for the workflow. Check the workflow definition for required inputs (e.g., task, repo_path).',
        additionalProperties: true,
      },
    },
    required: ['workflow_name'],
  },
  async execute(args, db) {
    const name = args.workflow_name as string;
    const input = (args.input as Record<string, unknown>) ?? {};

    // Find workflow by name
    const workflow = await db.collection('workflows').findOne({ name, archived: { $ne: true } });
    if (!workflow) {
      return { error: `Workflow "${name}" not found. Use list_workflows to see available workflows.` };
    }

    // Check required inputs
    const wfDef = workflow.parsed as Record<string, unknown>;
    const inputDef = wfDef.input as Record<string, { required?: boolean }> | undefined;
    if (inputDef) {
      const missingFields: string[] = [];
      for (const [key, def] of Object.entries(inputDef)) {
        if (def.required && (input[key] === undefined || input[key] === null || input[key] === '')) {
          missingFields.push(key);
        }
      }
      if (missingFields.length > 0) {
        return {
          error: `Missing required inputs: ${missingFields.join(', ')}`,
          required_inputs: Object.entries(inputDef).map(([k, v]) => ({
            name: k,
            type: (v as Record<string, unknown>).type ?? 'string',
            required: (v as Record<string, unknown>).required ?? false,
          })),
        };
      }
    }

    const executionService = new ExecutionService(db);
    const result = await executionService.start((workflow._id as ObjectId).toString(), input);
    return {
      execution_id: result.id,
      status: result.status,
      workflow_name: result.workflowName,
      message: `Workflow "${name}" started. Execution ID: ${result.id}. Status: ${result.status}.`,
    };
  },
};

const getExecution: ChatTool = {
  name: 'get_execution',
  description: `Get the status of a workflow or spawned agent execution. If still running, blocks up to 90 seconds waiting for completion (like get_delegation_result). If status="waiting", call again. When completed, includes the agent's response.`,
  inputSchema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'The execution ID to check' },
    },
    required: ['execution_id'],
  },
  async execute(args, db) {
    const executionId = args.execution_id as string;
    const executionService = new ExecutionService(db);

    // Long-poll: wait up to 90s for completion (under MCP 120s timeout)
    let waitMs = 5000;
    const maxWaitMs = 30000;
    const deadline = Date.now() + 90_000;

    while (Date.now() < deadline) {
      const exec = await executionService.getById(executionId);
      if (!exec) return { error: `Execution "${executionId}" not found.` };

      if (exec.status !== 'running' && exec.status !== 'queued') {
        // Completed/failed — fetch the agent response from traces
        let response: string | undefined;
        let sessionId: string | undefined;
        if (exec.status === 'completed') {
          const trace = await db.collection('execution_traces')
            .findOne({ executionId, status: 'completed' }, { sort: { completedAt: -1 } });
          if (trace) {
            response = (trace.output as Record<string, unknown>)?.response as string
              ?? trace.rawResponse as string
              ?? undefined;
            sessionId = (trace.output as Record<string, unknown>)?.session_id as string ?? undefined;
          }
        }

        return {
          id: exec.id,
          workflow_name: exec.workflowName,
          status: exec.status,
          response,
          session_id: sessionId,
          completed_nodes: exec.completedNodes,
          failed_node: exec.failedNode,
          error: exec.errorMessage,
          cost: exec.cost,
          duration_ms: exec.durationMs,
          started_at: exec.startedAt,
          completed_at: exec.completedAt,
        };
      }

      // Still running — wait
      await new Promise(r => setTimeout(r, waitMs));
      waitMs = Math.min(waitMs * 1.3, maxWaitMs);
    }

    // Still running after 90s — return "waiting" so LLM calls again
    return {
      id: executionId,
      status: 'waiting',
      message: 'Execution is still running. Call get_execution again — it will continue waiting.',
    };
  },
};

const listExecutions: ChatTool = {
  name: 'list_executions',
  description: 'List recent workflow executions. Can filter by status or workflow name.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Filter by status: running, completed, failed, cancelled', enum: ['running', 'completed', 'failed', 'cancelled'] },
      workflow_name: { type: 'string', description: 'Filter by workflow name' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
  },
  async execute(args, db) {
    const executionService = new ExecutionService(db);
    const filter: Record<string, unknown> = {};
    if (args.status) filter.status = args.status;
    if (args.workflow_name) filter.workflowName = args.workflow_name;

    const all = await executionService.list(filter);
    const limit = (args.limit as number) || 10;
    const executions = all.slice(0, limit);

    return {
      executions: executions.map(e => ({
        id: e.id,
        workflow_name: e.workflowName,
        status: e.status,
        cost: (e.cost as Record<string, unknown>)?.estimated ?? 0,
        duration_ms: e.durationMs,
        started_at: e.startedAt,
        completed_at: e.completedAt,
      })),
      total: all.length,
    };
  },
};

const cancelExecution: ChatTool = {
  name: 'cancel_execution',
  description: 'Cancel a running workflow execution.',
  inputSchema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'The execution ID to cancel' },
    },
    required: ['execution_id'],
  },
  async execute(args, db) {
    const executionService = new ExecutionService(db);
    await executionService.cancel(args.execution_id as string);
    return { message: `Execution ${args.execution_id} cancelled.` };
  },
};

const listRepos: ChatTool = {
  name: 'list_repos',
  description: 'List all registered repositories with their detected tech stack.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute(_args, db) {
    const repos = await db.collection('repos')
      .find({})
      .sort({ lastUsedAt: -1 })
      .limit(50)
      .toArray();

    return {
      repos: repos.map(r => ({
        id: (r._id as ObjectId).toString(),
        name: r.name,
        path: r.path,
        language: r.detected?.language ?? [],
        framework: r.detected?.framework ?? [],
        remote_url: r.remoteUrl ?? null,
        execution_count: r.executionCount ?? 0,
      })),
    };
  },
};

const listAgents: ChatTool = {
  name: 'list_agents',
  description: 'List all available agents with their provider, model, and capabilities.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute(_args, db) {
    const roles = await db.collection('agents')
      .find({})
      .sort({ name: 1 })
      .toArray();

    return {
      roles: roles.map(r => ({
        name: r.name,
        provider: r.provider ?? 'claude',
        model: r.model ?? 'default',
        tools: r.tools ?? [],
        icon: r.icon,
        system_prompt_preview: r.system ? (r.system as string).slice(0, 100) + '...' : '',
      })),
    };
  },
};

const spawnAgent: ChatTool = {
  name: 'spawn_agent',
  description: `Spawn a technical agent in the background. Returns immediately with execution_id. The agent runs until done — use get_execution(execution_id) to check when finished (it may take minutes). Pass session_id from a previous spawn to resume with context.`,
  inputSchema: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the agent to spawn (e.g., "coding-reviewer", "coding-investigator", "coding-planner")' },
      prompt: { type: 'string', description: 'The task/prompt to send to the spawned agent' },
      repo_path: { type: 'string', description: 'Optional repo path for the agent to work in' },
      session_id: { type: 'string', description: 'Session ID from a previous spawn to resume with context. The agent picks up where it left off.' },
    },
    required: ['agent_name', 'prompt'],
  },
  async execute(args, db) {
    const agentName = args.agent_name as string;
    const prompt = args.prompt as string;
    const resumeSession = args.session_id as string | undefined;

    const role = await db.collection('agents').findOne({ name: agentName });
    if (!role) {
      return { error: `Agent "${agentName}" not found. Use list_agents to see available agents.` };
    }

    // Auto-resolve repo_path from linked workspace
    let repoPath = args.repo_path as string | undefined;
    if (!repoPath) {
      const activeCtx = getAnyActiveSession();
      if (activeCtx?.chatSessionId) {
        try {
          const ws = await db.collection('workspaces').findOne({ chatSessionId: activeCtx.chatSessionId, status: { $nin: ['archived', 'failed'] } });
          if (ws?.worktreePath) {
            repoPath = ws.worktreePath as string;
          }
        } catch {}
      }
    }

    const { randomUUID } = await import('node:crypto');
    const executionId = randomUUID();
    await db.collection('executions').insertOne({
      id: executionId,
      workflowName: `chat:spawn_agent/${agentName}`,
      workflowId: null,
      workflowVersion: 0,
      status: 'running',
      source: 'chat',
      input: { prompt, agent_name: agentName, repo_path: repoPath, session_id: resumeSession },
      state: {},
      sessions: {},
      retryCounts: {},
      currentNodes: [agentName],
      completedNodes: [],
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: new Date(),
    });

    // Run in background — return immediately so MCP doesn't timeout
    runSpawnInBackground(db, role, agentName, prompt, executionId, resumeSession, repoPath).catch(() => {});

    return {
      agent_name: agentName,
      execution_id: executionId,
      status: 'running',
      message: `Agent "${agentName}" started. Use get_execution(execution_id="${executionId}") to poll for the result.`,
    };
  },
};

/** Run spawn_agent in background — supports both Claude and Codex with MCP + tracing */
async function runSpawnInBackground(
  db: Db, role: Record<string, unknown>, agentName: string, prompt: string,
  executionId: string, resumeSession: string | undefined, repoPath: string | undefined,
): Promise<void> {
  const activeCtx = getAnyActiveSession();
  if (activeCtx) activeCtx.pendingBackgroundTasks++;
  const onEvent = activeCtx?.broadcastEvent;
  const startMs = Date.now();
  const provider = role.provider ?? 'claude';
  const model = (role.model as string) ?? 'sonnet';
  const activity: { type: string; tool?: string; timestamp: Date }[] = [];

  // Broadcast spawn started
  if (onEvent) onEvent('spawn_started', { executionId, agent: agentName, prompt: prompt.slice(0, 200), provider, model });

  const MAX_SPAWN_RETRIES = 3;
  let currentResumeSession = resumeSession;

  for (let attempt = 0; attempt <= MAX_SPAWN_RETRIES; attempt++) {
  try {
    let response = '';
    let costUsd = 0;
    let sessionId: string | undefined = currentResumeSession;
    const toolCalls: { tool: string; args: Record<string, unknown>; result?: Record<string, unknown> }[] = [];

    // On retry, update prompt to "continue"
    if (attempt > 0) {
      console.log(`[spawn] Auto-retry #${attempt} for ${agentName} (session ${currentResumeSession?.slice(0, 12)}...)`);
      prompt = 'Continue from where you left off. Complete your task and provide the final response.';
    }

    if (provider === 'codex') {
      // ── Codex CLI with MCP ──
      const { spawn } = await import('node:child_process');
      const { syncMcpToCodex } = await import('./chat-providers.js');
      await syncMcpToCodex(db);

      const args: string[] = ['exec'];
      if (currentResumeSession) {
        args.push('resume', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', currentResumeSession, prompt);
      } else {
        args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
        if (model) args.push('-c', `model="${model}"`);
        args.push(`${(role.system as string) ?? ''}\n\n${prompt}`);
      }

      const result = await new Promise<{ text: string; threadId?: string }>((resolveP, rejectP) => {
        const proc = spawn('codex', args, { cwd: repoPath || '/tmp', env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdin.end();
        let text = '';
        let threadId: string | undefined = resumeSession;
        let buf = '';

        proc.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'thread.started' && evt.thread_id) threadId = evt.thread_id;
              if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
                const t = evt.item.text ?? evt.item.content?.filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('') ?? '';
                if (t) text = t;
              }
              if (evt.type === 'item.started' && (evt.item?.type === 'mcp_tool_call' || evt.item?.type === 'collab_tool_call')) {
                const server = evt.item.server ?? evt.item.serverLabel ?? '';
                const tool = evt.item.tool ?? evt.item.name ?? '';
                const name = server ? `mcp__${server}__${tool}` : tool;
                toolCalls.push({ tool: name, args: evt.item.arguments ?? evt.item.input ?? {} });
                activity.push({ type: 'tool_call', tool: name, timestamp: new Date() });
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_start', tool: name });
              }
              if (evt.type === 'item.completed' && (evt.item?.type === 'mcp_tool_call' || evt.item?.type === 'collab_tool_call')) {
                const server = evt.item.server ?? evt.item.serverLabel ?? '';
                const tool = evt.item.tool ?? evt.item.name ?? '';
                const name = server ? `mcp__${server}__${tool}` : tool;
                activity.push({ type: 'tool_result', tool: name, timestamp: new Date() });
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_done', tool: name });
              }
              if (evt.type === 'item.completed' && evt.item?.type === 'function_call') {
                const fn = evt.item.name ?? 'unknown';
                toolCalls.push({ tool: fn, args: {} });
                activity.push({ type: 'tool_call', tool: fn, timestamp: new Date() });
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_done', tool: fn });
              }
              if (evt.type === 'item.completed' && evt.item?.type === 'command_execution') {
                toolCalls.push({ tool: 'Bash', args: { command: evt.item.command ?? '' } });
                activity.push({ type: 'tool_call', tool: 'Bash', timestamp: new Date() });
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_done', tool: 'Bash', command: (evt.item.command ?? '').slice(0, 100) });
              }
              // Broadcast thinking
              if (evt.type === 'item.started' && evt.item?.type === 'agent_reasoning') {
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'thinking' });
              }
            } catch {}
          }
        });
        proc.on('close', () => resolveP({ text, threadId }));
        proc.on('error', (err) => rejectP(err));
      });

      response = result.text;
      sessionId = result.threadId;
      if (sessionId) currentResumeSession = sessionId; // for retries

    } else {
      // ── Claude CLI with MCP ──
      const { query } = await import('@anthropic-ai/claude-code');
      const { loadAllMcpServers } = await import('@flowforge/engine');
      const mcpServers = await loadAllMcpServers(db);

      const sdkOptions: Record<string, unknown> = {
        model, maxTurns: 50, permissionMode: 'bypassPermissions',
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      };
      if (currentResumeSession) sdkOptions.resume = currentResumeSession;
      else sdkOptions.customSystemPrompt = (role.system as string) ?? '';

      for await (const msg of query({ prompt, options: sdkOptions as any })) {
        if ('session_id' in msg && msg.session_id) sessionId = msg.session_id as string;
        if (msg.type === 'assistant') {
          const blocks = msg.message.content as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
          const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
          if (text) response = text;
          for (const block of blocks) {
            if (block.type === 'tool_use' && block.name) {
              toolCalls.push({ tool: block.name, args: (block.input as Record<string, unknown>) ?? {} });
              activity.push({ type: 'tool_call', tool: block.name, timestamp: new Date() });
              if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_start', tool: block.name });
            }
          }
        }
        if (msg.type === 'result') {
          costUsd = (msg as any).total_cost_usd ?? 0;
          if ((msg as any).subtype === 'success' && (msg as any).result) response = (msg as any).result;
          if ((msg as any).session_id) { sessionId = (msg as any).session_id; currentResumeSession = sessionId; }
        }
      }
    }

    const durationMs = Date.now() - startMs;

    // Save execution as completed
    await db.collection('executions').updateOne(
      { id: executionId },
      { $set: {
        status: 'completed', completedNodes: [agentName], currentNodes: [],
        cost: { actual: costUsd, estimated: costUsd }, durationMs, completedAt: new Date(),
        ...(sessionId ? { [`sessions.${agentName}`]: sessionId } : {}),
      } },
    );

    // Broadcast completion
    if (onEvent) onEvent('spawn_completed', { executionId, agent: agentName, durationMs, toolCount: toolCalls.length, response: response.slice(0, 300) });

    // Save full trace with response, tool calls, and activity
    await db.collection('execution_traces').insertOne({
      executionId, node: agentName, attempt: 1, status: 'completed', type: 'agent', agent: agentName,
      inputState: { prompt }, renderedPrompt: prompt, rawResponse: response,
      output: { response, session_id: sessionId },
      toolCalls,
      activity: activity.map(a => ({ ...a, type: a.type as any, content: a.tool ?? '' })),
      cost: { actual: costUsd, estimated: costUsd, model, method: 'sdk_reported' as const },
      durationMs, startedAt: new Date(startMs), completedAt: new Date(),
    });
    // Success — break out of retry loop
    return;
  } catch (err) {
    const errorMsg = (err as Error).message ?? String(err);
    const isTimeout = errorMsg.toLowerCase().includes('timed out') || errorMsg.toLowerCase().includes('timeout');

    // If timeout and we have a session to resume, retry
    if (isTimeout && currentResumeSession && attempt < MAX_SPAWN_RETRIES) {
      console.log(`[spawn] ${agentName} timed out (attempt ${attempt + 1}), will retry...`);
      continue; // next iteration
    }

    const durationMs = Date.now() - startMs;
    await db.collection('executions').updateOne(
      { id: executionId },
      { $set: { status: 'failed', errorMessage: errorMsg, durationMs, completedAt: new Date() } },
    );
    await db.collection('execution_traces').insertOne({
      executionId, node: agentName, attempt: attempt + 1, status: 'failed', type: 'agent', agent: agentName,
      inputState: { prompt }, renderedPrompt: prompt, rawResponse: '',
      output: { error: errorMsg },
      activity: activity.map(a => ({ ...a, type: a.type as any, content: a.tool ?? '' })),
      cost: { actual: 0, estimated: 0, model, method: 'sdk_reported' as const },
      durationMs, startedAt: new Date(startMs), completedAt: new Date(),
    });
    if (activeCtx) activeCtx.pendingBackgroundTasks--;
    return; // failed, don't retry
  }
  } // end retry loop

  // If we exhausted retries without success or explicit return, decrement
  if (activeCtx) activeCtx.pendingBackgroundTasks--;
}

const getLearnings: ChatTool = {
  name: 'get_learnings',
  description: 'Get recent learnings from the learning system. Learnings capture patterns, mistakes, and optimizations from workflow executions.',
  inputSchema: {
    type: 'object',
    properties: {
      workflow_name: { type: 'string', description: 'Filter by workflow name' },
      type: { type: 'string', description: 'Filter by type: fact, pattern, mistake, preference, skill, optimization' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
  },
  async execute(args, db) {
    const query: Record<string, unknown> = { status: 'active' };
    if (args.workflow_name) query['source.workflowName'] = args.workflow_name;
    if (args.type) query.type = args.type;

    const limit = (args.limit as number) || 10;
    const learnings = await db.collection('learnings')
      .find(query)
      .sort({ confidence: -1, updatedAt: -1 })
      .limit(limit)
      .toArray();

    return {
      learnings: learnings.map(l => ({
        content: l.content,
        type: l.type,
        target: l.target,
        confidence: l.confidence,
        workflow: l.source?.workflowName,
        node: l.source?.nodeName,
        tags: l.tags,
      })),
      total: learnings.length,
    };
  },
};

// ── Phase 5: Database Queries ──

const queryDatabase: ChatTool = {
  name: 'query_database',
  description: 'Run a read-only query against the FlowForge MongoDB database. Can query collections: workflows, executions, agents, repos, learnings, chat_sessions. Returns up to 20 results.',
  inputSchema: {
    type: 'object',
    properties: {
      collection: { type: 'string', description: 'MongoDB collection name (e.g., "workflows", "executions", "agents", "repos", "learnings")' },
      filter: { type: 'object', description: 'MongoDB query filter (e.g., {"status": "completed"})', additionalProperties: true },
      projection: { type: 'object', description: 'Fields to include/exclude (e.g., {"name": 1, "status": 1})', additionalProperties: true },
      sort: { type: 'object', description: 'Sort order (e.g., {"createdAt": -1})', additionalProperties: true },
      limit: { type: 'number', description: 'Max results (default 10, max 20)' },
    },
    required: ['collection'],
  },
  async execute(args, db) {
    const allowedCollections = ['workflows', 'executions', 'agents', 'repos', 'learnings', 'chat_sessions', 'execution_logs', 'node_traces'];
    const collection = args.collection as string;
    if (!allowedCollections.includes(collection)) {
      return { error: `Collection "${collection}" not allowed. Allowed: ${allowedCollections.join(', ')}` };
    }

    const rawFilter = (args.filter as Record<string, unknown>) ?? {};
    // Strip dangerous MongoDB operators that can execute arbitrary code
    const dangerousOps = ['$where', '$function', '$accumulator', '$expr'];
    const filter = sanitizeFilter(rawFilter, dangerousOps);
    const projection = (args.projection as Record<string, unknown>) ?? {};
    const sort = (args.sort as Record<string, unknown>) ?? { _id: -1 };
    const limit = Math.min((args.limit as number) || 10, 20);

    const results = await db.collection(collection)
      .find(filter)
      .project(projection)
      .sort(sort as any)
      .limit(limit)
      .toArray();

    return {
      collection,
      count: results.length,
      results: results.map(r => {
        const doc = { ...r, _id: r._id.toString() };
        // Truncate large fields
        for (const [k, v] of Object.entries(doc)) {
          if (typeof v === 'string' && v.length > 500) {
            (doc as Record<string, unknown>)[k] = v.slice(0, 500) + '... (truncated)';
          }
        }
        return doc;
      }),
    };
  },
};

const searchExecutionsAdvanced: ChatTool = {
  name: 'search_executions_advanced',
  description: 'Search executions with advanced filters: date range, cost range, duration, node-level details. More powerful than list_executions.',
  inputSchema: {
    type: 'object',
    properties: {
      workflow_name: { type: 'string', description: 'Filter by workflow name' },
      status: { type: 'string', description: 'Filter by status', enum: ['running', 'completed', 'failed', 'cancelled', 'queued'] },
      since_hours: { type: 'number', description: 'Only executions from the last N hours' },
      min_cost: { type: 'number', description: 'Minimum estimated cost (USD)' },
      has_failed_node: { type: 'boolean', description: 'Only executions with failed nodes' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
  },
  async execute(args, db) {
    const filter: Record<string, unknown> = {};
    if (args.workflow_name) filter.workflowName = args.workflow_name;
    if (args.status) filter.status = args.status;
    if (args.since_hours) {
      const since = new Date();
      since.setHours(since.getHours() - (args.since_hours as number));
      filter.startedAt = { $gte: since };
    }
    if (args.min_cost) filter['cost.estimated'] = { $gte: args.min_cost };
    if (args.has_failed_node) filter.failedNode = { $exists: true, $ne: null };

    const limit = Math.min((args.limit as number) || 10, 20);

    const results = await db.collection('executions')
      .find(filter)
      .project({
        id: 1, workflowName: 1, status: 1, cost: 1, durationMs: 1,
        currentNodes: 1, completedNodes: 1, failedNode: 1, errorMessage: 1,
        startedAt: 1, completedAt: 1,
      })
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();

    return {
      count: results.length,
      executions: results.map(e => ({
        id: e.id,
        workflow_name: e.workflowName,
        status: e.status,
        cost_estimated: e.cost?.estimated ?? 0,
        duration_ms: e.durationMs,
        completed_nodes: e.completedNodes?.length ?? 0,
        failed_node: e.failedNode ?? null,
        error: e.errorMessage ?? null,
        started_at: e.startedAt,
        completed_at: e.completedAt,
      })),
    };
  },
};

// ── Phase 6: Execution Node Traces ──

const getNodeTrace: ChatTool = {
  name: 'get_node_trace',
  description: 'Get detailed trace of a specific node execution, including the rendered prompt, raw LLM response, tool calls, and timing. Use this to debug why a node produced unexpected output.',
  inputSchema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'The execution ID' },
      node_name: { type: 'string', description: 'The node name to inspect' },
    },
    required: ['execution_id', 'node_name'],
  },
  async execute(args, db) {
    const traces = await db.collection('node_traces')
      .find({
        executionId: args.execution_id,
        node: args.node_name,
      })
      .sort({ attempt: -1 })
      .limit(3)
      .toArray();

    if (traces.length === 0) {
      return { error: `No traces found for node "${args.node_name}" in execution "${args.execution_id}".` };
    }

    return {
      node: args.node_name,
      attempts: traces.map(t => ({
        attempt: t.attempt,
        status: t.status,
        agent: t.agent ?? t.role,
        prompt_preview: t.renderedPrompt ? (t.renderedPrompt as string).slice(0, 500) + '...' : null,
        response_preview: t.rawResponse ? (t.rawResponse as string).slice(0, 500) + '...' : null,
        outputs: t.output,
        cost: t.cost,
        duration_ms: t.durationMs,
        activity_count: t.activity?.length ?? 0,
      })),
    };
  },
};

const getExecutionLogs: ChatTool = {
  name: 'get_execution_logs',
  description: 'Get execution logs for debugging. Can filter by node, log level, and category. Returns the most recent logs.',
  inputSchema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'The execution ID' },
      node: { type: 'string', description: 'Filter by node name' },
      level: { type: 'string', description: 'Filter by level: info, debug, warn, error', enum: ['info', 'debug', 'warn', 'error'] },
      category: { type: 'string', description: 'Filter by category: agent, tool, condition, routing, system, gate', enum: ['agent', 'tool', 'condition', 'routing', 'system', 'gate'] },
      limit: { type: 'number', description: 'Max logs (default 30)' },
    },
    required: ['execution_id'],
  },
  async execute(args, db) {
    const filter: Record<string, unknown> = { executionId: args.execution_id };
    if (args.node) filter.node = args.node;
    if (args.level) filter.level = args.level;
    if (args.category) filter.category = args.category;

    const limit = Math.min((args.limit as number) || 30, 100);

    const logs = await db.collection('execution_logs')
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    logs.reverse(); // chronological order

    return {
      count: logs.length,
      logs: logs.map(l => ({
        timestamp: l.timestamp,
        level: l.level,
        category: l.category,
        node: l.node ?? null,
        message: typeof l.message === 'string' && l.message.length > 300 ? l.message.slice(0, 300) + '...' : l.message,
      })),
    };
  },
};

const getDashboardStats: ChatTool = {
  name: 'get_dashboard_stats',
  description: 'Get FlowForge dashboard statistics: total workflows, executions, success rate, cost totals, active agents, registered repos.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute(_args, db) {
    const [workflowCount, executionCount, repoCount, agentCount] = await Promise.all([
      db.collection('workflows').countDocuments({ archived: { $ne: true } }),
      db.collection('executions').countDocuments({}),
      db.collection('repos').countDocuments({}),
      db.collection('agents').countDocuments({}),
    ]);

    const recentExecs = await db.collection('executions')
      .find({})
      .sort({ startedAt: -1 })
      .limit(100)
      .project({ status: 1, cost: 1, durationMs: 1 })
      .toArray();

    const completed = recentExecs.filter(e => e.status === 'completed').length;
    const failed = recentExecs.filter(e => e.status === 'failed').length;
    const running = recentExecs.filter(e => e.status === 'running').length;
    const totalCost = recentExecs.reduce((sum, e) => sum + (e.cost?.estimated ?? 0), 0);

    return {
      workflows: workflowCount,
      executions: executionCount,
      repos: repoCount,
      agents: agentCount,
      recent_100: {
        completed,
        failed,
        running,
        success_rate: executionCount > 0 ? `${Math.round((completed / Math.max(completed + failed, 1)) * 100)}%` : 'N/A',
        total_cost_estimated: `$${totalCost.toFixed(2)}`,
      },
    };
  },
};

// ── Export all tools ──

// ── Human-in-the-Loop ──

const submitExecutionInput: ChatTool = {
  name: 'submit_execution_input',
  description: 'Submit human input to a paused workflow execution. Use this when get_execution shows status "waiting_for_input" — it means a human node or auto-gate clarify is waiting for the user\'s response.',
  inputSchema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'The execution ID that is waiting for input' },
      node: { type: 'string', description: 'The node name that is waiting (from get_execution current_nodes)' },
      data: { type: 'object', description: 'The input data to submit. For human nodes: field values. For clarify: { response: "user answer", __clarify_action: "retry" or "continue" }', additionalProperties: true },
    },
    required: ['execution_id', 'node', 'data'],
  },
  async execute(args, db) {
    const executionService = new ExecutionService(db);
    const execId = args.execution_id as string;
    const node = args.node as string;
    const data = (args.data as Record<string, unknown>) ?? {};

    const exec = await executionService.getById(execId);
    if (!exec) return { error: `Execution "${execId}" not found.` };
    if (exec.status !== 'waiting_for_input') {
      return { error: `Execution is not waiting for input. Current status: ${exec.status}` };
    }

    const delivered = await executionService.submitInput(execId, node, data);
    if (!delivered) {
      return { error: `No pending input request found for node "${node}" in execution "${execId}".` };
    }

    return {
      message: `Input submitted to node "${node}" in execution "${execId}". The workflow is continuing.`,
      execution_id: execId,
      node,
    };
  },
};

// ── Learning Capture ──

const saveLearning: ChatTool = {
  name: 'save_learning',
  description: 'Save a learning/correction to the system memory. Call this automatically when the user corrects you, provides a preference, or shares a fact that should be remembered for future conversations. Do NOT ask the user before saving — just save it silently.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The learning content — write it as a generalized rule, not specific to this conversation. E.g., "Always use staging database for testing" not "User said use staging"' },
      type: { type: 'string', description: 'Learning type: fact, pattern, mistake, preference', enum: ['fact', 'pattern', 'mistake', 'preference'] },
    },
    required: ['content', 'type'],
  },
  async execute(args, db) {
    const content = args.content as string;
    const type = args.type as string;
    const activeCtx = getAnyActiveSession();
    const agentName = activeCtx?.currentAgent;

    // Auto-scope to the active agent if one is selected
    const scope = agentName
      ? { level: 'agent' as const, agentName }
      : { level: 'global' as const };

    const result = await db.collection('learnings').insertOne({
      content,
      type,
      target: 'agent',
      tags: ['chat', 'auto-extracted', ...(agentName ? [`agent:${agentName}`] : [])],
      scope,
      source: { sourceType: 'human_correction', workflowName: 'chat', nodeName: agentName ?? 'chat', executionId: '', timestamp: new Date() },
      confidence: 0.9,
      confirmations: 1,
      contradictions: 0,
      usageCount: 0,
      tokenCount: content.length,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Generate and save embedding (async, non-blocking)
    embedAndSave(db, result.insertedId.toString(), content).catch(() => {});

    return { saved: true, content, type, scope: scope.level, agent: agentName ?? 'global' };
  },
};

// ── Delegation Tools ──────────────────────────────────────────────────────────

const delegateToAgent: ChatTool = {
  name: 'delegate_to_agent',
  description: `Delegate a task to another team agent. Returns immediately with a conversation_id. Then call get_delegation_result(conversation_id) which BLOCKS until the agent finishes — no polling loop needed.

WORKFLOW:
1. delegate_to_agent(agent_name="engineer", task="Analyze feasibility") → { conversation_id: "abc" }
2. get_delegation_result(conversation_id="abc") → WAITS → { status: "completed", response: "..." }
3. Optional follow-up: delegate_to_agent(agent_name="engineer", task="What about CSS?", conversation_id="abc")
4. get_delegation_result(conversation_id="abc") → WAITS → { status: "completed", response: "..." }

CRITICAL RULES:
- ALWAYS call get_delegation_result after delegate_to_agent.
- If get_delegation_result returns status="waiting", call it again immediately. Keep calling until "completed" or "failed".
- NEVER respond to the user before ALL delegations are complete.
- NEVER give up — the agent WILL finish. Just keep calling get_delegation_result.
- After getting "completed", you MAY send follow-ups via delegate_to_agent(conversation_id=...) then get_delegation_result again.
- Only after ALL delegation results are in, synthesize and respond to the user.`,
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the agent to delegate to (e.g., "engineer", "qa-engineer", "data-analyst")' },
      task: { type: 'string', description: 'The task, question, or follow-up message for the target agent' },
      context: { type: 'object', description: 'Any relevant context (repo path, ticket info, etc.)', additionalProperties: true },
      conversation_id: { type: 'string', description: 'ID of an existing conversation to continue (for multi-turn). Omit for new delegation.' },
    },
    required: ['agent_name', 'task'],
  },
  async execute(args, db) {
    const targetName = args.agent_name as string;
    const task = args.task as string;
    const context = (args.context as Record<string, unknown>) ?? {};
    const continueConvId = args.conversation_id as string | undefined;
    const conversationService = new AgentConversationService(db);

    // Find the target agent
    const targetAgent = await db.collection('agents').findOne({ name: targetName });
    if (!targetAgent) {
      return { error: `Agent "${targetName}" not found. Use list_agents to see available agents.` };
    }

    const activeCtx = getAnyActiveSession();
    const chatSessionId = activeCtx?.chatSessionId ?? 'unknown';
    const parentMessageId = activeCtx?.parentMessageId ?? 'unknown';
    const fromAgent = activeCtx?.currentAgent ?? 'assistant';
    const currentDepth = (activeCtx?.delegationDepth ?? 0) + 1;
    const onEvent = activeCtx?.broadcastEvent;

    // ── Continue existing conversation (explicit ID or auto-find) ──
    let existingConvId = continueConvId;
    if (!existingConvId) {
      // Auto-find active conversation between caller and target
      const existing = await conversationService.findActiveConversation(chatSessionId, fromAgent, targetName);
      if (existing) existingConvId = existing._id!.toString();
    }

    if (existingConvId) {
      const existing = await conversationService.get(existingConvId);
      if (!existing) return { error: `Conversation "${existingConvId}" not found.` };

      await conversationService.addMessage(existingConvId, { agent: fromAgent, type: 'message', content: task, timestamp: new Date() });
      if (onEvent) onEvent('thread_message', { conversationId: existingConvId, agent: fromAgent, type: 'message', content: task.slice(0, 200) });

      // Get the target agent's session for resume
      const targetSessionId = existing.sessions?.[targetName];

      // Run in background — return immediately
      runDelegationInBackground(db, targetAgent, task, existingConvId, targetSessionId, conversationService, onEvent, activeCtx, currentDepth, fromAgent, targetName).catch(() => {});

      return { conversation_id: existingConvId, status: 'started', turn: 'continue', message: `Message sent to ${targetName}. Use get_delegation_result to check the response.` };
    }

    // ── New conversation ──
    if (!conversationService.canDelegate(currentDepth - 1)) {
      return { error: `Delegation depth limit reached (max ${conversationService.maxDepth}). Respond directly.` };
    }

    if (fromAgent !== 'assistant') {
      const callingAgent = await db.collection('agents').findOne({ name: fromAgent });
      if (callingAgent?.canDelegateTo && !callingAgent.canDelegateTo.includes(targetName)) {
        return { error: `Agent "${fromAgent}" cannot delegate to "${targetName}". Allowed: ${(callingAgent.canDelegateTo as string[]).join(', ')}` };
      }
    }

    const conversation = await conversationService.create({ chatSessionId, parentMessageId, fromAgent, toAgent: targetName, task, context, depth: currentDepth, parentConversationId: activeCtx?.currentConversationId });
    const convId = conversation._id!.toString();

    if (onEvent) onEvent('thread_created', { conversationId: convId, fromAgent, toAgent: targetName, task: task.slice(0, 200), depth: currentDepth, parentConversationId: activeCtx?.currentConversationId });
    await conversationService.addMessage(convId, { agent: fromAgent, type: 'message', content: task, timestamp: new Date() });

    // Auto-inject workspace context if a workspace is linked to this chat session
    if (!context.repo_path && activeCtx?.chatSessionId) {
      try {
        const ws = await db.collection('workspaces').findOne({ chatSessionId: activeCtx.chatSessionId, status: { $nin: ['archived', 'failed'] } });
        if (ws?.worktreePath) {
          context.repo_path = ws.worktreePath as string;
          context.workspace_branch = ws.branch as string;
        }
      } catch {}
    }

    let fullPrompt = task;
    if (Object.keys(context).length > 0) fullPrompt = `CONTEXT:\n${JSON.stringify(context, null, 2)}\n\nTASK:\n${task}`;

    // Run in background — return immediately so MCP doesn't timeout
    runDelegationInBackground(db, targetAgent, fullPrompt, convId, undefined, conversationService, onEvent, activeCtx, currentDepth, fromAgent, targetName).catch(() => {});

    return { conversation_id: convId, status: 'started', agent: targetName, depth: currentDepth, message: `Delegation started. Use get_delegation_result(conversation_id="${convId}") to get the response.` };
  },
};

/** Run delegation in background — decoupled from MCP tool call timeout */
async function runDelegationInBackground(
  db: Db, targetAgent: Record<string, unknown>, prompt: string, convId: string,
  resumeSessionId: string | undefined, conversationService: AgentConversationService,
  onEvent: ((event: string, data: Record<string, unknown>) => void) | undefined,
  activeCtx: ActiveSessionContext | undefined, currentDepth: number,
  fromAgent: string, targetName: string,
): Promise<void> {
  if (activeCtx) activeCtx.pendingBackgroundTasks++;
  const startMs = Date.now();
  try {
    const result = await runAgentTurn(db, targetAgent, prompt, convId, resumeSessionId, conversationService, onEvent, activeCtx, currentDepth);
    console.log(`[delegation] ${targetName} completed: ${result.responseText.length}ch, ${result.toolCalls.length} toolCalls`);
    await conversationService.addMessage(convId, { agent: targetName, type: 'message', content: result.responseText, toolCalls: result.toolCalls, timestamp: new Date() });
    await conversationService.addCost(convId, result.costUsd);
    if (result.sessionId) await conversationService.saveSessionId(convId, targetName, result.sessionId);

    const durationMs = Date.now() - startMs;
    const summary = result.responseText.split('\n').find(l => l.trim().length > 10)?.trim().slice(0, 150) ?? result.responseText.slice(0, 150);
    await conversationService.complete(convId, result.responseText, summary, result.costUsd);
    if (onEvent) onEvent('thread_completed', { conversationId: convId, fromAgent, toAgent: targetName, summary, costUsd: result.costUsd, durationMs });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorMsg = (err as Error).message;
    await conversationService.fail(convId, errorMsg);
    if (onEvent) onEvent('thread_completed', { conversationId: convId, fromAgent, toAgent: targetName, summary: `Failed: ${errorMsg}`, costUsd: 0, durationMs, error: true });
  } finally {
    if (activeCtx) activeCtx.pendingBackgroundTasks--;
  }
}

/** Wait for delegation result — handles active, waiting_for_answer, completed, failed */
const getDelegationResult: ChatTool = {
  name: 'get_delegation_result',
  description: `Wait for a delegation to complete. Blocks up to 90 seconds per call.

Possible return statuses:
- "waiting" → agent still working. Call get_delegation_result again.
- "question" → agent is asking YOU a question. Read the question, then call answer_question(conversation_id, answer).
  After answering, call get_delegation_result again to wait for the agent to finish.
- "completed" → agent finished. Response is in the result.
- "failed" → agent errored.

RULES:
- If "waiting": call get_delegation_result again immediately. NEVER give up.
- If "question": answer it via answer_question, then call get_delegation_result again.
- If you can't answer the question yourself, use ask_caller to escalate to YOUR caller.
- NEVER respond to the user before status is "completed" or "failed".`,
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'Conversation ID from delegate_to_agent' },
    },
    required: ['conversation_id'],
  },
  async execute(args, db) {
    const convId = args.conversation_id as string;
    const conversationService = new AgentConversationService(db);
    let waitMs = 5000;
    const maxWaitMs = 30000;
    const maxTotalMs = 90_000; // 90s per call (MCP safe)
    const startMs = Date.now();

    while (Date.now() - startMs < maxTotalMs) {
      const conv = await conversationService.get(convId);
      if (!conv) return { error: `Conversation "${convId}" not found.` };

      // Agent asked a question — return immediately so caller can answer
      if (conv.status === 'waiting_for_answer' && conv.pendingQuestion?.status === 'pending') {
        return {
          conversation_id: convId,
          status: 'question',
          question: conv.pendingQuestion.question,
          from_agent: conv.pendingQuestion.fromAgent,
          message: `${conv.toAgent} is asking: "${conv.pendingQuestion.question}". Answer via answer_question(conversation_id, answer).`,
        };
      }

      // Completed or failed — return result
      if (conv.status === 'completed' || conv.status === 'failed') {
        return {
          conversation_id: convId,
          status: conv.status,
          agent: conv.toAgent,
          response: conv.response ?? conv.summary ?? '',
          summary: conv.summary,
          cost_usd: conv.costUsd,
          duration_ms: conv.durationMs,
          turn_count: conv.turnCount,
          hint: conv.status === 'completed' ? `To continue, call delegate_to_agent with conversation_id="${convId}"` : undefined,
        };
      }

      // Still active — wait
      await new Promise(r => setTimeout(r, waitMs));
      waitMs = Math.min(waitMs * 1.3, maxWaitMs);
    }

    return { conversation_id: convId, status: 'waiting', message: 'Agent is still working. Call get_delegation_result again.' };
  },
};

/** Answer a question from a delegated agent */
const answerQuestion: ChatTool = {
  name: 'answer_question',
  description: 'Answer a question from an agent you delegated to. Use when get_delegation_result returns status="question". After answering, call get_delegation_result again to wait for the agent to continue.',
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'Conversation ID' },
      answer: { type: 'string', description: 'Your answer to the agent\'s question' },
    },
    required: ['conversation_id', 'answer'],
  },
  async execute(args, db) {
    const convId = args.conversation_id as string;
    const answer = args.answer as string;
    const conversationService = new AgentConversationService(db);
    const activeCtx = getAnyActiveSession();
    const fromAgent = activeCtx?.currentAgent ?? 'assistant';

    const conv = await conversationService.get(convId);
    if (!conv) return { error: `Conversation "${convId}" not found.` };
    if (conv.status !== 'waiting_for_answer') return { error: `Conversation is not waiting for an answer (status: ${conv.status}).` };

    await conversationService.answerQuestion(convId, fromAgent, answer);

    // Emit SSE
    activeCtx?.broadcastEvent?.('thread_answer', {
      conversationId: convId, fromAgent, answer: answer.slice(0, 200),
    });

    return { answered: true, conversation_id: convId };
  },
};

/** Ask the caller (agent who delegated to you) a question. Blocks until they answer. */
const askCaller: ChatTool = {
  name: 'ask_caller',
  description: 'Ask a question to the agent who delegated this task to you. Use when you need clarification, context, or a decision before you can proceed. Your execution pauses until they answer. Do NOT guess — ask.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Your question for the caller' },
    },
    required: ['question'],
  },
  async execute(args, db) {
    const question = args.question as string;
    const activeCtx = getAnyActiveSession();
    const currentAgent = activeCtx?.currentAgent ?? 'unknown';
    // Accept conversation_id from API route (when called via MCP → HTTP) or from active context
    const convId = (args._conversation_id as string) ?? activeCtx?.currentConversationId;

    if (!convId) return { error: 'No active conversation context. ask_caller can only be used by a delegated agent.' };

    const conversationService = new AgentConversationService(db);

    // Write question and set status to waiting_for_answer
    await conversationService.askQuestion(convId, currentAgent, question);

    // Emit SSE
    activeCtx?.broadcastEvent?.('thread_question', {
      conversationId: convId, fromAgent: currentAgent, question: question.slice(0, 300),
    });

    // Block: poll until the caller answers
    let waitMs = 3000;
    const maxWaitMs = 30000;
    while (true) {
      const { answered, answer } = await conversationService.isQuestionAnswered(convId);
      if (answered && answer) {
        return { answer };
      }
      await new Promise(r => setTimeout(r, waitMs));
      waitMs = Math.min(waitMs * 1.3, maxWaitMs);
    }
  },
};

/** Ask the user a question directly. Only for the top-level team agent. Blocks until user answers. */
const askUser: ChatTool = {
  name: 'ask_user',
  description: 'Ask the user a question. Use when you need information, a decision, or clarification that no other agent can provide. Your execution pauses until the user responds. Only use as a last resort — try to answer from context first.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Your question for the user' },
    },
    required: ['question'],
  },
  async execute(args, db) {
    const question = args.question as string;
    const activeCtx = getAnyActiveSession();
    const fromAgent = activeCtx?.currentAgent ?? 'assistant';

    if (!activeCtx) return { error: 'No active session context.' };

    const sessionId = activeCtx.chatSessionId;

    // Store pending question on the chat session
    await db.collection('chat_sessions').updateOne(
      { _id: new (await import('mongodb')).ObjectId(sessionId) },
      {
        $set: {
          pendingUserQuestion: {
            question,
            fromAgent,
            status: 'pending',
            askedAt: new Date(),
          },
        },
      },
    );

    // Emit SSE so UI shows the question
    activeCtx.broadcastEvent('user_question', { question, fromAgent });

    // Block: poll until user answers
    let waitMs = 2000;
    const maxWaitMs = 30000;
    while (true) {
      const session = await db.collection('chat_sessions').findOne(
        { _id: new (await import('mongodb')).ObjectId(sessionId) },
      );
      const pq = session?.pendingUserQuestion;
      if (pq?.status === 'answered' && pq?.answer) {
        // Clear the pending question
        await db.collection('chat_sessions').updateOne(
          { _id: new (await import('mongodb')).ObjectId(sessionId) },
          { $set: { pendingUserQuestion: null } },
        );
        activeCtx.broadcastEvent('user_answer', { answer: pq.answer });
        return { answer: pq.answer };
      }
      await new Promise(r => setTimeout(r, waitMs));
      waitMs = Math.min(waitMs * 1.3, maxWaitMs);
    }
  },
};

/**
 * Run a single turn of an agent conversation.
 * Streams thinking, text, tool calls, and tool results to the UI in real-time.
 * No timeout — agents run until they finish.
 */
async function runAgentTurn(
  db: Db,
  targetAgent: Record<string, unknown>,
  prompt: string,
  convId: string,
  resumeSessionId: string | undefined,
  conversationService: AgentConversationService,
  onEvent: ((event: string, data: Record<string, unknown>) => void) | undefined,
  activeCtx: ActiveSessionContext | undefined,
  currentDepth: number,
): Promise<{ responseText: string; costUsd: number; sessionId?: string; toolCalls: { tool: string; args: Record<string, unknown> }[] }> {
  const targetName = targetAgent.name as string;
  const provider = targetAgent.provider ?? 'claude';
  const model = targetAgent.model ?? 'sonnet';
  // Capture fromAgent BEFORE mutating activeCtx (fixes stale context bug)
  const fromAgent = activeCtx?.currentAgent ?? 'assistant';

  let responseText = '';
  let costUsd = 0;
  let sessionId: string | undefined = resumeSessionId;
  const toolCalls: { tool: string; args: Record<string, unknown>; result?: Record<string, unknown> }[] = [];
  const activeMcpCalls = new Map<string, { tool: string; startMs: number }>();
  const MAX_RETRIES = 3;

  /** Emit a thread event to the UI */
  function emit(type: string, data: Record<string, unknown>) {
    if (onEvent) onEvent('thread_message', { conversationId: convId, agent: targetName, ...data, type });
  }

  // Save/restore context for nested delegation
  const prevCtx = activeCtx ? { ...activeCtx } : undefined;
  if (activeCtx) { activeCtx.currentAgent = targetName; activeCtx.delegationDepth = currentDepth; activeCtx.currentConversationId = convId; }

  let systemPrompt = resumeSessionId ? undefined : buildDelegationPrompt(targetAgent, fromAgent, currentDepth, conversationService.maxDepth);

  // Append agent-scoped learnings to the system prompt
  if (systemPrompt) {
    try {
      const agentLearnings = await db.collection('learnings')
        .find({ status: 'active', $or: [
          { 'scope.level': 'agent', 'scope.agentName': targetName },
          { 'scope.level': 'global' },
        ]})
        .sort({ confidence: -1 })
        .limit(5)
        .toArray();
      if (agentLearnings.length > 0) {
        const items = agentLearnings.map((l: any) => `- [${l.type}] ${l.content}`).join('\n');
        systemPrompt += `\n\nMemory from past work:\n${items}`;
      }
    } catch {}
  }

  // Retry loop — if CLI times out, resume the same session and continue
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // This is a retry — resume the session with "continue" prompt
      const isTimeout = true; // we only retry on timeout
      console.log(`[delegation] Auto-retry #${attempt} for ${targetName} (session ${sessionId?.slice(0, 12)}...)`);
      emit('text', { content: `Reconnecting to ${targetName} (retry ${attempt}/${MAX_RETRIES})...` });
      prompt = 'Continue from where you left off. Complete your task and provide the final response.';
    }

  try {
    if (provider === 'codex') {
      // ── Codex CLI with MCP ──
      const { spawn } = await import('node:child_process');

      // Sync MCP servers so Codex can access FlowForge tools
      const { syncMcpToCodex } = await import('./chat-providers.js');
      await syncMcpToCodex(db);

      const args: string[] = ['exec'];
      if (resumeSessionId) {
        args.push('resume', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', resumeSessionId, prompt);
      } else {
        args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
        if (model) args.push('-c', `model="${model}"`);
        args.push(`${systemPrompt}\n\n${prompt}`);
      }

      const result = await new Promise<{ text: string; threadId?: string; costUsd: number }>((resolveP, rejectP) => {
        const proc = spawn('codex', args, { cwd: '/tmp', env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdin.end();
        let text = '';
        let threadId: string | undefined = resumeSessionId;
        let buf = '';

        proc.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'thread.started' && evt.thread_id) threadId = evt.thread_id;
              // Text output
              if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
                const t = evt.item.text ?? evt.item.content?.filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('') ?? '';
                if (t) { text = t; emit('text', { content: t.slice(-300) }); }
              }
              // Log all event types for debugging
              if (evt.type && evt.item?.type) {
                console.log(`[delegation-codex] ${targetName}: evt=${evt.type} item=${evt.item.type}`);
              }
              // MCP / collab tool calls (Codex uses 'collab_tool_call' in exec mode)
              if (evt.type === 'item.started' && (evt.item?.type === 'mcp_tool_call' || evt.item?.type === 'collab_tool_call')) {
                const server = evt.item.server ?? evt.item.serverLabel ?? '';
                const tool = evt.item.tool ?? evt.item.name ?? '';
                const fullName = server ? `mcp__${server}__${tool}` : tool;
                toolCalls.push({ tool: fullName, args: evt.item.arguments ?? evt.item.input ?? {} });
                emit('tool_call', { tool: fullName });
              }
              if (evt.type === 'item.completed' && (evt.item?.type === 'mcp_tool_call' || evt.item?.type === 'collab_tool_call')) {
                const server = evt.item.server ?? evt.item.serverLabel ?? '';
                const tool = evt.item.tool ?? evt.item.name ?? '';
                const fullName = server ? `mcp__${server}__${tool}` : tool;
                // Capture result
                const resultContent = evt.item.result?.content ?? evt.item.output;
                if (resultContent) {
                  const lastTc = [...toolCalls].reverse().find((tc: any) => tc.tool === fullName && !tc.result);
                  if (lastTc) {
                    try {
                      const text = Array.isArray(resultContent) ? resultContent.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : String(resultContent);
                      lastTc.result = JSON.parse(text);
                    } catch { lastTc.result = { raw: String(resultContent).slice(0, 500) }; }
                  }
                }
                emit('tool_result', { tool: fullName });
              }
              // Function calls
              if (evt.type === 'item.completed' && evt.item?.type === 'function_call') {
                toolCalls.push({ tool: evt.item.name ?? 'unknown', args: {} });
                emit('tool_call', { tool: evt.item.name ?? 'unknown' });
              }
              // Bash commands
              if (evt.type === 'item.completed' && evt.item?.type === 'command_execution') {
                toolCalls.push({ tool: 'Bash', args: { command: evt.item.command ?? '' } });
                emit('tool_call', { tool: 'Bash' });
              }
            } catch {}
          }
        });
        proc.on('close', () => resolveP({ text, threadId, costUsd: 0 }));
        proc.on('error', (err) => rejectP(err));
      });

      responseText = result.text;
      sessionId = result.threadId;
      costUsd = result.costUsd;

    } else {
      // ── Claude CLI with MCP — full streaming ──
      const { query } = await import('@anthropic-ai/claude-code');
      const { resolve, dirname } = await import('node:path');

      const mcpServers: Record<string, unknown> = {};
      const serverPath = resolve(dirname(new URL(import.meta.url).pathname), 'flowforge-mcp-server.ts');
      mcpServers.flowforge = { type: 'stdio', command: 'npx', args: ['tsx', serverPath], env: { FLOWFORGE_API_URL: `http://localhost:${process.env.PORT ?? '4023'}` } };
      const { loadExternalMcpServers } = await import('./chat-mcp.js');
      Object.assign(mcpServers, await loadExternalMcpServers(db));

      const sdkOptions: Record<string, unknown> = { model, maxTurns: 50, permissionMode: 'bypassPermissions', cwd: '/tmp', mcpServers };
      if (resumeSessionId) sdkOptions.resume = resumeSessionId;
      else sdkOptions.customSystemPrompt = systemPrompt;

      for await (const message of query({ prompt, options: sdkOptions as any })) {
        if ('session_id' in message && message.session_id) sessionId = message.session_id as string;
        if (message.type === 'assistant') {
          const blocks = (message as any).message.content as Array<{ type: string; text?: string; thinking?: string; name?: string; input?: unknown; id?: string }>;
          const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('');
          if (text && text !== responseText) { responseText = text; emit('text', { content: text.slice(-300) }); }
          for (const block of blocks) {
            if (block.type === 'thinking' && (block.thinking || block.text)) emit('thinking', { content: (block.thinking || block.text || '').slice(0, 200) });
            if (block.type === 'tool_use' && block.name && block.id) {
              toolCalls.push({ tool: block.name, args: (block.input as Record<string, unknown>) ?? {} });
              activeMcpCalls.set(block.id, { tool: block.name, startMs: Date.now() });
              emit('tool_call', { tool: block.name, toolUseId: block.id });
            }
          }
        }
        if (message.type === 'user') {
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const pending = activeMcpCalls.get(block.tool_use_id);
                if (pending) { emit('tool_result', { tool: pending.tool, toolUseId: block.tool_use_id, durationMs: Date.now() - pending.startMs }); activeMcpCalls.delete(block.tool_use_id); }
              }
            }
          }
        }
        if (message.type === 'result') {
          costUsd = (message as any).total_cost_usd ?? 0;
          if ((message as any).subtype === 'success' && (message as any).result) responseText = (message as any).result;
          if ((message as any).session_id) sessionId = (message as any).session_id;
        }
      }
    }
  } catch (err) {
    const errorMsg = (err as Error).message ?? String(err);
    const isTimeout = errorMsg.toLowerCase().includes('timed out') || errorMsg.toLowerCase().includes('timeout');

    // If timeout and we have a session to resume, retry
    if (isTimeout && sessionId && attempt < MAX_RETRIES) {
      console.log(`[delegation] ${targetName} timed out (attempt ${attempt + 1}), will retry with session ${sessionId.slice(0, 12)}...`);
      continue; // next iteration of retry loop
    }

    // Not a timeout or out of retries — restore context and re-throw
    if (activeCtx && prevCtx) { activeCtx.currentAgent = prevCtx.currentAgent; activeCtx.delegationDepth = prevCtx.delegationDepth; activeCtx.currentConversationId = prevCtx.currentConversationId; }
    throw err;
  }

  // Success — break out of retry loop
  break;
  } // end retry loop

  // Restore context after success
  if (activeCtx && prevCtx) { activeCtx.currentAgent = prevCtx.currentAgent; activeCtx.delegationDepth = prevCtx.delegationDepth; activeCtx.currentConversationId = prevCtx.currentConversationId; }

  return { responseText, costUsd, sessionId, toolCalls };
}

function buildDelegationPrompt(
  targetAgent: Record<string, unknown>,
  fromAgent: string,
  depth: number,
  maxDepth: number,
): string {
  const systemBase = (targetAgent.system as string) ?? '';
  const personality = (targetAgent.personality as string) ?? '';
  const canDelegateTo = (targetAgent.canDelegateTo as string[]) ?? [];
  const canTrigger = (targetAgent.canTrigger as string[]) ?? [];

  const parts = [systemBase];

  if (personality) parts.push(`\nYour personality: ${personality}`);

  parts.push(`\nYou were delegated a task by ${fromAgent}. Respond with a clear, actionable answer.`);

  // ask_caller — always available to delegated agents
  parts.push(`
ASKING QUESTIONS:
- If you need clarification, context, or a decision from ${fromAgent}, use ask_caller(question).
- Your execution pauses until ${fromAgent} answers, then you continue with the answer.
- Do NOT guess when you're unsure — ASK.`);

  if (canDelegateTo.length > 0 && depth < maxDepth) {
    parts.push(`\nYou can delegate sub-tasks to: ${canDelegateTo.join(', ')} using delegate_to_agent.
When get_delegation_result returns "question", answer it via answer_question, then call get_delegation_result again.`);
  } else if (depth >= maxDepth) {
    parts.push(`\nYou are at the maximum delegation depth (${depth}/${maxDepth}). Do NOT delegate further — respond directly.`);
  }

  if (canTrigger.length > 0) {
    parts.push(`You can trigger these workflows: ${canTrigger.join(', ')} using run_workflow.`);
  }

  // Team agents should delegate, not do hands-on work
  const agentType = (targetAgent.type as string) ?? 'technical';
  if (agentType === 'team') {
    parts.push(`
YOU MUST call spawn_agent before making any claims about code. You have no filesystem access.
Available technical agents: coding-investigator, coding-planner, coding-reviewer, coding-developer, coding-tester, coding-writer, git-ops.
Pick the right agent for each sub-task. Call spawn_agent(agent_name, prompt_with_repo_path), then get_execution to wait.
NEVER fabricate analysis. Every technical claim must come from an agent's actual response.`);
  }

  parts.push(`\nBe concise. You are collaborating with another agent. Use structured output with headers and bullets.`);

  return parts.join('\n');
}

const reportToUser: ChatTool = {
  name: 'report_to_user',
  description: 'Send a progress update or result to the user during a long-running delegation chain. Use this for intermediate status updates (e.g., "Engineer is analyzing the codebase...") or final results.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The progress update or result to show the user' },
      status: { type: 'string', description: '"in_progress" | "completed" | "needs_input"', enum: ['in_progress', 'completed', 'needs_input'] },
    },
    required: ['message'],
  },
  async execute(args, _db) {
    const message = args.message as string;
    const status = (args.status as string) ?? 'in_progress';

    // Read from active session registry
    const activeCtx = getAnyActiveSession();
    const fromAgent = activeCtx?.currentAgent ?? 'assistant';

    if (activeCtx?.broadcastEvent) {
      activeCtx.broadcastEvent('agent_report', {
        agent: fromAgent,
        message,
        status,
        timestamp: new Date().toISOString(),
      });
    }

    return { reported: true, message, status };
  },
};

const createPullRequest: ChatTool = {
  name: 'create_pull_request',
  description: 'Create a PR from the active workspace. Pushes the branch and opens a GitHub PR. Only works if a workspace is linked to the current chat session.',
  destructive: true,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'PR title' },
      body: { type: 'string', description: 'PR description (markdown)' },
      skip_checks: { type: 'boolean', description: 'Skip pre-PR checks (lint/test)' },
    },
    required: ['title'],
  },
  async execute(args, db) {
    const activeCtx = getAnyActiveSession();
    if (!activeCtx?.chatSessionId) return { error: 'No active chat session' };

    const ws = await db.collection('workspaces').findOne({ chatSessionId: activeCtx.chatSessionId, status: { $nin: ['archived', 'failed'] } });
    if (!ws) return { error: 'No workspace linked to this chat session. Link one first with link_chat.' };

    const title = args.title as string;
    const body = (args.body as string) ?? '';

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);

      // Run pre-PR checks if not skipped
      if (!args.skip_checks) {
        const config = await db.collection('workspace_configs').findOne({ repoId: ws.repoId });
        if (config?.prePrScript?.length) {
          for (const cmd of config.prePrScript as string[]) {
            try {
              await exec('sh', ['-c', cmd], { cwd: ws.worktreePath as string, env: { ...process.env, ...(config.envVars ?? {}) } });
            } catch (err: any) {
              return { error: `Pre-PR check failed: ${cmd}`, output: err.stderr ?? err.message };
            }
          }
        }
      }

      // Push
      await exec('git', ['push', '-u', 'origin', ws.branch as string], { cwd: ws.worktreePath as string });

      // Create PR
      const { stdout } = await exec('gh', [
        'pr', 'create', '--title', title, '--body', body,
        '--base', ws.baseBranch as string, '--head', ws.branch as string,
        '--json', 'number,url',
      ], { cwd: ws.worktreePath as string });

      const result = JSON.parse(stdout);

      // Save to pull_requests collection
      await db.collection('pull_requests').insertOne({
        repoId: ws.repoId, repoName: ws.repoName, repoPath: ws.repoPath,
        number: result.number, title, description: body,
        branch: ws.branch, baseBranch: ws.baseBranch,
        status: 'open', author: 'flowforge-agent',
        url: result.url, additions: 0, deletions: 0, changedFiles: 0, labels: [],
        createdByAgent: activeCtx.currentAgent ?? 'assistant',
        chatSessionId: activeCtx.chatSessionId,
        workspaceId: ws._id?.toString(),
        createdAt: new Date(), updatedAt: new Date(),
      });

      return { success: true, pr_number: result.number, url: result.url, message: `PR #${result.number} created: ${result.url}` };
    } catch (err: any) {
      return { error: `Failed to create PR: ${err.message}` };
    }
  },
};

export const chatTools: ChatTool[] = [
  // Core
  listWorkflows,
  runWorkflow,
  getExecution,
  listExecutions,
  cancelExecution,
  listRepos,
  listAgents,
  spawnAgent,
  getLearnings,
  // Delegation & conversation
  delegateToAgent,
  getDelegationResult,
  answerQuestion,
  askCaller,
  askUser,
  reportToUser,
  // Advanced queries
  queryDatabase,
  searchExecutionsAdvanced,
  getDashboardStats,
  // Debugging
  getNodeTrace,
  getExecutionLogs,
  // Human-in-the-loop
  submitExecutionInput,
  // Learning capture
  saveLearning,
  // Workspace actions
  createPullRequest,
];

/**
 * Execute a tool by name. Returns the result or an error object.
 */
export async function executeChatTool(
  toolName: string,
  args: Record<string, unknown>,
  db: Db,
): Promise<Record<string, unknown>> {
  const tool = chatTools.find(t => t.name === toolName);
  if (!tool) return { error: `Unknown tool: ${toolName}` };
  try {
    return await tool.execute(args, db);
  } catch (err) {
    return { error: `Tool ${toolName} failed: ${(err as Error).message}` };
  }
}
