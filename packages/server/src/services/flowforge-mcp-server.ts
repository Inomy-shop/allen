#!/usr/bin/env node
/**
 * FlowForge MCP Server
 * Exposes all 16 built-in chat tools as an MCP server (stdio transport).
 * Both Codex CLI and Claude CLI can connect to this as a native MCP server.
 *
 * Usage: node flowforge-mcp-server.js
 * Env: FLOWFORGE_API_URL (default: http://localhost:4023)
 */

// This runs as a standalone process — communicates via stdin/stdout JSON-RPC.
// It calls the FlowForge API (HTTP) to execute tools instead of importing chat-tools.ts directly.
// This way it works without a database connection — just needs the API server running.

const API_BASE = process.env.FLOWFORGE_API_URL ?? `http://localhost:${process.env.PORT ?? '4023'}`;

// ── Tool Definitions ──

const TOOLS = [
  { name: 'list_workflows', description: 'List all available workflows with name, description, node count, validation status', params: {} },
  { name: 'run_workflow', description: 'Start executing a workflow. Returns execution ID.', params: { workflow_name: 'string (required)', input: 'object — workflow input parameters' } },
  { name: 'get_execution', description: 'Get status and details of a workflow execution', params: { execution_id: 'string (required)' } },
  { name: 'list_executions', description: 'List recent executions. Filter by status or workflow name.', params: { status: 'string', workflow_name: 'string', limit: 'number' } },
  { name: 'cancel_execution', description: 'Cancel a running execution', params: { execution_id: 'string (required)' } },
  { name: 'list_repos', description: 'List registered repositories with tech stack', params: {} },
  { name: 'list_roles', description: 'List available agent roles with provider, model, tools', params: {} },
  { name: 'get_dashboard_stats', description: 'Get dashboard statistics: workflow count, executions, success rate', params: {} },
  { name: 'get_learnings', description: 'Get learnings from the learning system', params: { workflow_name: 'string', type: 'string', limit: 'number' } },
  { name: 'get_node_trace', description: 'Get detailed trace of a node execution for debugging', params: { execution_id: 'string (required)', node_name: 'string (required)' } },
  { name: 'get_execution_logs', description: 'Get execution logs filtered by node, level, category', params: { execution_id: 'string (required)', node: 'string', level: 'string', category: 'string', limit: 'number' } },
  { name: 'spawn_role', description: 'Spawn a one-shot agent with a specific role to perform a task. The agent runs with the role system prompt, model, and tools.', params: { role_name: 'string (required)', prompt: 'string (required)', repo_path: 'string — optional repo path' } },
  { name: 'query_database', description: 'Run a read-only query against FlowForge MongoDB. Allowed collections: workflows, executions, roles, repos, learnings, chat_sessions, execution_logs, node_traces.', params: { collection: 'string (required)', filter: 'object', projection: 'object', sort: 'object', limit: 'number (max 20)' } },
  { name: 'search_executions_advanced', description: 'Search executions with advanced filters: date range, cost, failed nodes.', params: { workflow_name: 'string', status: 'string', since_hours: 'number', min_cost: 'number', has_failed_node: 'boolean', limit: 'number' } },
  { name: 'submit_execution_input', description: 'Submit input to a paused workflow execution', params: { execution_id: 'string (required)', node: 'string (required)', data: 'object (required)' } },
  { name: 'save_learning', description: 'Save a learning/correction to system memory. Call silently when user corrects you or states a preference.', params: { content: 'string (required) — generalized rule', type: 'string (required) — fact, pattern, mistake, or preference' } },
];

// ── API Call Helper ──

async function callAPI(endpoint: string, method = 'GET', body?: unknown): Promise<unknown> {
  const url = `${API_BASE}${endpoint}`;
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url);
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
    case 'get_execution': return callAPI(`/api/executions/${args.execution_id}`);
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
    case 'list_roles': return callAPI('/api/roles');
    case 'get_dashboard_stats': return callAPI('/api/dashboard/stats');
    case 'get_learnings': {
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
    case 'spawn_role': {
      const url = `${API_BASE}/api/chat/spawn-role`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_name: args.role_name, prompt: args.prompt, repo_path: args.repo_path }),
      });
      return res.json();
    }
    case 'query_database': {
      const collection = args.collection as string;
      const allowed = ['workflows', 'executions', 'roles', 'repos', 'learnings', 'chat_sessions', 'execution_logs', 'node_traces'];
      if (!allowed.includes(collection)) return { error: `Collection "${collection}" not allowed. Allowed: ${allowed.join(', ')}` };
      // Use the learnings endpoint as a proxy for simple queries, or call MongoDB directly
      // For now, route to a generic query endpoint
      const params = new URLSearchParams();
      if (args.limit) params.set('limit', String(args.limit));
      // Simple list query
      const res = await fetch(`${API_BASE}/api/${collection === 'chat_sessions' ? 'chat/sessions' : collection}?${params}`);
      return res.json();
    }
    case 'search_executions_advanced': {
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
    default: return { error: `Unknown tool: ${name}` };
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
        serverInfo: { name: 'flowforge', version: '1.0.0' },
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
                type: typeof v === 'string' && v.startsWith('object') ? 'object' : typeof v === 'string' && v.startsWith('number') ? 'number' : 'string',
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

process.stderr.write('FlowForge MCP server running on stdio\n');

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
