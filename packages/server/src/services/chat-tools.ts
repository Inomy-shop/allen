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
  /** Broadcast SSE events to the chat listeners */
  broadcastEvent: (event: string, data: Record<string, unknown>) => void;
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
  description: 'Get the current status and details of a workflow execution by its ID.',
  inputSchema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'The execution ID to check' },
    },
    required: ['execution_id'],
  },
  async execute(args, db) {
    const executionService = new ExecutionService(db);
    const exec = await executionService.getById(args.execution_id as string);
    if (!exec) {
      return { error: `Execution "${args.execution_id}" not found.` };
    }
    return {
      id: exec.id,
      workflow_name: exec.workflowName,
      status: exec.status,
      current_nodes: exec.currentNodes,
      completed_nodes: exec.completedNodes,
      failed_node: exec.failedNode,
      error: exec.errorMessage,
      cost: exec.cost,
      duration_ms: exec.durationMs,
      started_at: exec.startedAt,
      completed_at: exec.completedAt,
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
  description: 'Spawn a technical agent to perform a task. Pass session_id from a previous spawn to continue with context (the agent resumes where it left off). Use this for coding, analysis, review, and investigation tasks.',
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
    const startMs = Date.now();

    const role = await db.collection('agents').findOne({ name: agentName });
    if (!role) {
      return { error: `Agent "${agentName}" not found. Use list_agents to see available agents.` };
    }

    // Create execution record
    const { randomUUID } = await import('node:crypto');
    const executionId = randomUUID();
    await db.collection('executions').insertOne({
      id: executionId,
      workflowName: `chat:spawn_agent/${agentName}`,
      workflowId: null,
      workflowVersion: 0,
      status: 'running',
      source: 'chat',
      input: { prompt, agent_name: agentName, repo_path: args.repo_path, session_id: resumeSession },
      state: {},
      sessions: {},
      retryCounts: {},
      currentNodes: [agentName],
      completedNodes: [],
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: new Date(),
    });

    try {
      const { query } = await import('@anthropic-ai/claude-code');
      const provider = role.provider ?? 'claude';

      let response = '';
      let costUsd = 0;
      let sessionId: string | undefined;

      if (provider === 'claude') {
        // Load MCP servers so spawned agent can access Linear, Postgres, etc.
        const { loadAllMcpServers } = await import('@flowforge/engine');
        const mcpServers = await loadAllMcpServers(db);

        const sdkOptions: Record<string, unknown> = {
          model: role.model ?? 'sonnet',
          maxTurns: 20,
          permissionMode: 'bypassPermissions',
          ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        };

        // Resume existing session or start new
        if (resumeSession) {
          sdkOptions.resume = resumeSession;
        } else {
          sdkOptions.customSystemPrompt = role.system as string;
        }

        const conversation = query({ prompt, options: sdkOptions as any });

        for await (const msg of conversation) {
          if ('session_id' in msg && msg.session_id) sessionId = msg.session_id as string;
          if (msg.type === 'assistant') {
            const blocks = msg.message.content as Array<{ type: string; text?: string }>;
            response = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
          }
          if (msg.type === 'result') {
            costUsd = (msg as any).total_cost_usd ?? 0;
            if ((msg as any).subtype === 'success' && (msg as any).result) {
              response = (msg as any).result;
            }
            if ((msg as any).session_id) sessionId = (msg as any).session_id;
          }
        }
      } else if (provider === 'codex') {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const codexArgs = ['exec', '--json', '--full-auto', '-m', role.model ?? 'codex-mini', prompt];
        const cwd = (args.repo_path as string) || process.cwd();
        const { stdout } = await execFileAsync('codex', codexArgs, { cwd, timeout: 120000 });
        for (const line of stdout.trim().split('\n')) {
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
              const text = evt.item.content?.filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
              if (text) response = text;
            }
          } catch { /* skip */ }
        }
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }

      const durationMs = Date.now() - startMs;

      // Update execution record as completed
      await db.collection('executions').updateOne(
        { id: executionId },
        { $set: {
          status: 'completed',
          completedNodes: [agentName],
          currentNodes: [],
          cost: { actual: costUsd, estimated: costUsd },
          durationMs,
          completedAt: new Date(),
        } },
      );

      // Save node trace for debugging
      await db.collection('execution_traces').insertOne({
        executionId,
        node: agentName,
        attempt: 1,
        status: 'completed',
        type: 'agent',
        agent: agentName,
        inputState: { prompt },
        renderedPrompt: prompt,
        rawResponse: response,
        output: { response },
        activity: [],
        cost: { actual: costUsd, estimated: costUsd, model: role.model ?? 'sonnet', method: 'sdk_reported' },
        durationMs,
        startedAt: new Date(startMs),
        completedAt: new Date(),
      });

      // Save session ID to execution for future reference
      if (sessionId) {
        await db.collection('executions').updateOne(
          { id: executionId },
          { $set: { [`sessions.${agentName}`]: sessionId } },
        );
      }

      return {
        agent_name: agentName,
        execution_id: executionId,
        response,
        provider: provider as string,
        cost_usd: costUsd,
        duration_ms: durationMs,
        session_id: sessionId,
        hint: sessionId ? `To continue this agent with context, pass session_id="${sessionId}" in the next spawn_agent call.` : undefined,
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      await db.collection('executions').updateOne(
        { id: executionId },
        { $set: { status: 'failed', errorMessage: (err as Error).message, durationMs, completedAt: new Date() } },
      );
      return { error: `Failed to spawn agent "${agentName}": ${(err as Error).message}`, execution_id: executionId };
    }
  },
};

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
        role: t.role,
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

    const result = await db.collection('learnings').insertOne({
      content,
      type,
      target: 'agent',
      tags: ['chat', 'auto-extracted'],
      scope: { level: 'global' },
      source: { sourceType: 'human_correction', workflowName: 'chat', nodeName: 'chat', executionId: '', timestamp: new Date() },
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

    return { saved: true, content, type };
  },
};

// ── Delegation Tools ──────────────────────────────────────────────────────────

const delegateToAgent: ChatTool = {
  name: 'delegate_to_agent',
  description: `Delegate a task to another team agent or continue an existing conversation with them. The target agent processes the task and returns their response.

MULTI-TURN: To have a follow-up conversation, pass the conversation_id from a previous delegation. The target agent resumes from where they left off with full context. Use this to ask clarifying questions, request more detail, or give feedback.

Example flow:
1. delegate_to_agent(agent_name="engineer", task="Analyze feasibility of dark mode")  →  returns conversation_id
2. delegate_to_agent(agent_name="engineer", task="What about the CSS variable approach?", conversation_id="<id from step 1>")
3. delegate_to_agent(agent_name="engineer", task="Give me the effort estimate", conversation_id="<id from step 1>")

IMPORTANT: Have the full multi-turn conversation BEFORE you synthesize and respond to the user. The user should see the complete agent thread, then your final summary.`,
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

    // Read delegation context from the active session registry
    const activeCtx = getAnyActiveSession();
    const chatSessionId = activeCtx?.chatSessionId ?? 'unknown';
    const parentMessageId = activeCtx?.parentMessageId ?? 'unknown';
    const fromAgent = activeCtx?.currentAgent ?? 'assistant';
    const currentDepth = (activeCtx?.delegationDepth ?? 0) + 1;
    const onEvent = activeCtx?.broadcastEvent;

    // ── Continue existing conversation ──
    if (continueConvId) {
      const existing = await conversationService.get(continueConvId);
      if (!existing) return { error: `Conversation "${continueConvId}" not found.` };
      if (existing.toAgent !== targetName) return { error: `Conversation "${continueConvId}" is with "${existing.toAgent}", not "${targetName}".` };

      // Add the follow-up message
      await conversationService.addMessage(continueConvId, {
        agent: fromAgent,
        content: task,
        timestamp: new Date(),
      });

      if (onEvent) {
        onEvent('agent_thread_message', {
          conversationId: continueConvId,
          agent: fromAgent,
          type: 'follow_up',
          content: task.slice(0, 200),
        });
      }

      const startMs = Date.now();
      try {
        const result = await runAgentTurn(db, targetAgent, task, continueConvId, existing.agentSessionId, conversationService, onEvent, activeCtx, currentDepth);

        await conversationService.addMessage(continueConvId, {
          agent: targetName,
          content: result.responseText,
          toolCalls: result.toolCalls,
          timestamp: new Date(),
        });
        await conversationService.addCost(continueConvId, result.costUsd);
        if (result.sessionId) await conversationService.saveSessionId(continueConvId, result.sessionId);

        if (onEvent) {
          onEvent('agent_thread_message', {
            conversationId: continueConvId,
            agent: targetName,
            type: 'response',
            content: result.responseText.slice(0, 200),
          });
        }

        return {
          agent: targetName,
          response: result.responseText,
          conversation_id: continueConvId,
          cost_usd: result.costUsd,
          duration_ms: Date.now() - startMs,
          turn: 'continue',
        };
      } catch (err) {
        return { error: `Follow-up to "${targetName}" failed: ${(err as Error).message}`, conversation_id: continueConvId };
      }
    }

    // ── New conversation ──

    // Check depth limit
    if (!conversationService.canDelegate(currentDepth - 1)) {
      return {
        error: `Delegation depth limit reached (max ${conversationService.maxDepth}). Cannot delegate further. Summarize what you know and respond directly.`,
      };
    }

    // Check delegation permission
    if (fromAgent !== 'assistant') {
      const callingAgent = await db.collection('agents').findOne({ name: fromAgent });
      if (callingAgent?.canDelegateTo && !callingAgent.canDelegateTo.includes(targetName)) {
        return { error: `Agent "${fromAgent}" cannot delegate to "${targetName}". Allowed: ${(callingAgent.canDelegateTo as string[]).join(', ')}` };
      }
    }

    // Create conversation record
    const conversation = await conversationService.create({
      chatSessionId, parentMessageId, fromAgent, toAgent: targetName,
      task, context, depth: currentDepth, parentConversationId: undefined,
    });
    const convId = conversation._id!.toString();

    if (onEvent) {
      onEvent('agent_thread_start', { conversationId: convId, fromAgent, toAgent: targetName, task: task.slice(0, 200), depth: currentDepth });
    }

    await conversationService.addMessage(convId, { agent: fromAgent, content: task, timestamp: new Date() });

    const startMs = Date.now();

    try {
      // Build the user prompt with context
      let fullPrompt = task;
      if (Object.keys(context).length > 0) {
        fullPrompt = `CONTEXT:\n${JSON.stringify(context, null, 2)}\n\nTASK:\n${task}`;
      }

      const result = await runAgentTurn(db, targetAgent, fullPrompt, convId, undefined, conversationService, onEvent, activeCtx, currentDepth);

      await conversationService.addMessage(convId, { agent: targetName, content: result.responseText, toolCalls: result.toolCalls, timestamp: new Date() });
      if (result.sessionId) await conversationService.saveSessionId(convId, result.sessionId);

      const durationMs = Date.now() - startMs;
      const summary = result.responseText.split('\n').find(l => l.trim().length > 10)?.trim().slice(0, 150) ?? result.responseText.slice(0, 150);

      // Don't auto-complete — the calling agent may want to continue
      // Mark as completed only if the tool description says so, or caller completes it later
      // For now: complete on first turn, caller can still continue via conversation_id
      await conversationService.complete(convId, result.responseText, summary, result.costUsd);

      if (onEvent) {
        onEvent('agent_thread_complete', { conversationId: convId, fromAgent, toAgent: targetName, summary, costUsd: result.costUsd, durationMs });
      }

      return {
        agent: targetName,
        response: result.responseText,
        summary,
        conversation_id: convId,
        cost_usd: result.costUsd,
        duration_ms: durationMs,
        depth: currentDepth,
        hint: 'To continue this conversation, call delegate_to_agent again with conversation_id="' + convId + '"',
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errorMsg = (err as Error).message;
      await conversationService.fail(convId, errorMsg);
      if (onEvent) {
        onEvent('agent_thread_complete', { conversationId: convId, fromAgent, toAgent: targetName, summary: `Failed: ${errorMsg}`, costUsd: 0, durationMs, error: true });
      }
      return { error: `Delegation to "${targetName}" failed: ${errorMsg}`, conversation_id: convId };
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
  let sessionId: string | undefined;
  const toolCalls: { tool: string; args: Record<string, unknown> }[] = [];
  const activeMcpCalls = new Map<string, { tool: string; startMs: number }>();

  /** Emit a thread event to the UI */
  function emit(type: string, data: Record<string, unknown>) {
    if (onEvent) onEvent('agent_thread_message', { conversationId: convId, agent: targetName, ...data, type });
  }

  if (provider === 'codex') {
    const { spawn } = await import('node:child_process');
    const systemPrompt = buildDelegationPrompt(targetAgent, fromAgent, currentDepth, conversationService.maxDepth);
    const codexPrompt = `${systemPrompt}\n\n${prompt}`;
    const codexArgs: readonly string[] = ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-m', model as string, codexPrompt];

    responseText = await new Promise<string>((resolvePromise, rejectPromise) => {
      const proc = spawn('codex', codexArgs as string[]);
      let output = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'message' && evt.item?.text) {
              output = evt.item.text;
              emit('text', { content: output.slice(0, 300) });
            }
          } catch {}
        }
      });
      proc.on('close', () => resolvePromise(output));
      proc.on('error', (err) => rejectPromise(err));
    });
  } else {
    // Claude CLI — full streaming
    const { query } = await import('@anthropic-ai/claude-code');
    const { resolve, dirname } = await import('node:path');

    const mcpServers: Record<string, unknown> = {};
    const serverPath = resolve(dirname(new URL(import.meta.url).pathname), 'flowforge-mcp-server.ts');
    mcpServers.flowforge = { type: 'stdio', command: 'npx', args: ['tsx', serverPath], env: { FLOWFORGE_API_URL: `http://localhost:${process.env.PORT ?? '4023'}` } };
    const { loadExternalMcpServers } = await import('./chat-mcp.js');
    Object.assign(mcpServers, await loadExternalMcpServers(db));

    const sdkOptions: Record<string, unknown> = {
      model, maxTurns: 50, permissionMode: 'bypassPermissions', cwd: '/tmp', mcpServers,
    };

    if (resumeSessionId) {
      sdkOptions.resume = resumeSessionId;
    } else {
      sdkOptions.customSystemPrompt = buildDelegationPrompt(targetAgent, fromAgent, currentDepth, conversationService.maxDepth);
    }

    // Save/restore context for nested delegation
    const prevCtx = activeCtx ? { ...activeCtx } : undefined;
    if (activeCtx) { activeCtx.currentAgent = targetName; activeCtx.delegationDepth = currentDepth; }

    try {
      for await (const message of query({ prompt, options: sdkOptions as any })) {
        // Capture session ID
        if ('session_id' in message && message.session_id) sessionId = message.session_id as string;

        if (message.type === 'assistant') {
          const blocks = (message as any).message.content as Array<{ type: string; text?: string; thinking?: string; name?: string; input?: unknown; id?: string }>;

          // Stream text
          const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('');
          if (text && text !== responseText) {
            responseText = text;
            emit('text', { content: text.slice(-300) });
          }

          // Stream thinking
          for (const block of blocks) {
            if (block.type === 'thinking' && (block.thinking || block.text)) {
              emit('thinking', { content: (block.thinking || block.text || '').slice(0, 200) });
            }
          }

          // Track tool calls
          for (const block of blocks) {
            if (block.type === 'tool_use' && block.name && block.id) {
              toolCalls.push({ tool: block.name, args: (block.input as Record<string, unknown>) ?? {} });
              activeMcpCalls.set(block.id, { tool: block.name, startMs: Date.now() });
              emit('tool_call', { tool: block.name, toolUseId: block.id });
            }
          }
        }

        // Track tool results
        if (message.type === 'user') {
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const pending = activeMcpCalls.get(block.tool_use_id);
                if (pending) {
                  const durationMs = Date.now() - pending.startMs;
                  emit('tool_result', { tool: pending.tool, toolUseId: block.tool_use_id, durationMs });
                  activeMcpCalls.delete(block.tool_use_id);
                }
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
    } finally {
      // Always restore context, even on error/abort
      if (activeCtx && prevCtx) { activeCtx.currentAgent = prevCtx.currentAgent; activeCtx.delegationDepth = prevCtx.delegationDepth; }
    }
  }

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

  if (canDelegateTo.length > 0 && depth < maxDepth) {
    parts.push(`You can delegate sub-tasks to: ${canDelegateTo.join(', ')} using the delegate_to_agent tool.`);
  } else if (depth >= maxDepth) {
    parts.push(`You are at the maximum delegation depth (${depth}/${maxDepth}). Do NOT delegate further — respond directly with what you know.`);
  }

  if (canTrigger.length > 0) {
    parts.push(`You can trigger these workflows: ${canTrigger.join(', ')} using the run_workflow tool.`);
  }

  // Team agents should delegate, not do hands-on work
  const agentType = (targetAgent.type as string) ?? 'technical';
  if (agentType === 'team') {
    parts.push(`\nIMPORTANT: You are a TEAM agent. Do NOT use filesystem tools (Read, Bash, Grep, Glob) directly. Instead, use spawn_agent to dispatch technical agents (coding-planner, coding-investigator, coding-reviewer, etc.) for hands-on work. Your job is to coordinate and synthesize.`);
  }

  parts.push(`\nBe concise. You are collaborating with another agent, not talking to a human. Use structured output with headers and bullets.`);

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
  // Delegation
  delegateToAgent,
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
