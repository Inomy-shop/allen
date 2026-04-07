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
  { name: 'get_execution', description: 'Wait for execution to complete. Blocks up to 90s. Returns response when done. If status="waiting", call again. Includes agent response from traces when completed.', params: { execution_id: 'string (required)' } },
  { name: 'list_executions', description: 'List recent executions. Filter by status or workflow name.', params: { status: 'string', workflow_name: 'string', limit: 'number' } },
  { name: 'cancel_execution', description: 'Cancel a running execution', params: { execution_id: 'string (required)' } },
  { name: 'list_repos', description: 'List registered repositories with tech stack', params: {} },
  { name: 'list_agents', description: 'List all available agents with provider, model, and tools', params: {} },
  { name: 'get_dashboard_stats', description: 'Get dashboard statistics: workflow count, executions, success rate, agent count', params: {} },
  { name: 'get_learnings', description: 'Get learnings from the learning system', params: { workflow_name: 'string', type: 'string', limit: 'number' } },
  { name: 'get_node_trace', description: 'Get detailed trace of a node execution for debugging', params: { execution_id: 'string (required)', node_name: 'string (required)' } },
  { name: 'get_execution_logs', description: 'Get execution logs filtered by node, level, category', params: { execution_id: 'string (required)', node: 'string', level: 'string', category: 'string', limit: 'number' } },
  { name: 'spawn_agent', description: 'Spawn a technical agent to perform a task. Pass session_id from a previous spawn to continue with context (agent resumes where it left off).', params: { agent_name: 'string (required)', prompt: 'string (required)', repo_path: 'string — optional repo path', session_id: 'string — session ID from previous spawn to resume with context' } },
  { name: 'query_database', description: 'Run a read-only query against FlowForge MongoDB. Allowed collections: workflows, executions, agents, repos, learnings, chat_sessions, execution_logs, node_traces.', params: { collection: 'string (required)', filter: 'object', projection: 'object', sort: 'object', limit: 'number (max 20)' } },
  { name: 'search_executions_advanced', description: 'Search executions with advanced filters: date range, cost, failed nodes.', params: { workflow_name: 'string', status: 'string', since_hours: 'number', min_cost: 'number', has_failed_node: 'boolean', limit: 'number' } },
  { name: 'submit_execution_input', description: 'Submit input to a paused workflow execution', params: { execution_id: 'string (required)', node: 'string (required)', data: 'object (required)' } },
  { name: 'save_learning', description: 'Save a learning/correction to system memory. Call silently when user corrects you or states a preference.', params: { content: 'string (required) — generalized rule', type: 'string (required) — fact, pattern, mistake, or preference' } },
  { name: 'delegate_to_agent', description: 'Delegate a task to another team agent or continue a multi-turn conversation. Pass conversation_id to continue an existing thread with follow-up questions.', params: { agent_name: 'string (required) — target agent', task: 'string (required) — task or follow-up message', context: 'object — relevant context', conversation_id: 'string — existing conversation ID to continue (for multi-turn)' } },
  { name: 'get_delegation_result', description: 'Wait for delegation result. Blocks up to 90s. If "waiting" call again. If "question" — agent is asking you something, answer via answer_question then call this again. If "completed" — done.', params: { conversation_id: 'string (required)' } },
  { name: 'answer_question', description: 'Answer a question from an agent you delegated to. Use when get_delegation_result returns status="question".', params: { conversation_id: 'string (required)', answer: 'string (required)' } },
  { name: 'ask_caller', description: 'Ask a question to the agent who delegated this task to you. Blocks until they answer. Use when you need clarification.', params: { question: 'string (required)', conversation_id: 'string — conversation ID (optional, auto-detected from context)' } },
  { name: 'ask_user', description: 'Ask the user a question directly. Blocks until user answers. Only use when no agent can answer.', params: { question: 'string (required)' } },
  { name: 'report_to_user', description: 'Send a progress update to the user during a delegation chain.', params: { message: 'string (required)', status: 'string — in_progress | completed | needs_input' } },
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
    case 'get_execution': {
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
      return { id: execId, status: 'waiting', message: 'Execution still running. Call get_execution again.' };
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
    case 'list_agents': return callAPI('/api/agents');
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
    case 'spawn_agent': {
      const url = `${API_BASE}/api/chat/spawn-agent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_name: args.agent_name, prompt: args.prompt, repo_path: args.repo_path, session_id: args.session_id }),
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
    case 'delegate_to_agent': {
      const url = `${API_BASE}/api/chat/delegate`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_name: args.agent_name, task: args.task, context: args.context, conversation_id: args.conversation_id }),
      });
      return res.json();
    }
    case 'get_delegation_result': {
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
      // Return "waiting" so the LLM calls get_delegation_result again
      return {
        conversation_id: convId,
        status: 'waiting',
        message: 'Agent is still working. Call get_delegation_result again — it will continue waiting.',
      };
    }
    case 'answer_question': {
      const url = `${API_BASE}/api/chat/delegate`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'answer_question', conversation_id: args.conversation_id, answer: args.answer }),
      });
      return res.json();
    }
    case 'ask_caller': {
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
