/**
 * Chat Tools — Functions available to the Allen Chat assistant.
 * Each tool has a name, description, input schema, and execute function.
 * The chat service registers these with the Anthropic Messages API for native tool calling.
 */

import { ObjectId, type Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { logger } from '../logger.js';
import { ExecutionService } from './execution.service.js';
import { InterventionService } from './intervention.service.js';
import { embedAndSave, invalidateCache } from './embedding.service.js';
import { AgentConversationService } from './agent-conversation.service.js';
import { AgentActivityService } from './agent-activity.service.js';
import { metaChatTools, META_DESTRUCTIVE_TOOLS } from './chat-tools-meta.js';
import { monitoringAgentTools } from './monitoring-agent-tools.js';
import { buildRepoContextBlock } from './context/scanner/repo-context-builder.js';
import { RepoContextPacketService } from './context/core/repo-context-packet.service.js';
import { ContextEvaluationService } from './context/evaluation/context-evaluation.service.js';
import { isContextEngineEnabled } from './context/config/context-provider-config.js';
import { AGENT_FALLBACK_CWD } from './chat-providers.js';
import { MonitoringService } from './self-healing-monitor.service.js';
import { MCP_SERVER_NAME, normalizeModelAlias, ARTIFACTS_GUIDANCE, NON_INTERACTIVE_GUIDANCE, hasRepoContextLoadingGuidance, withMandatoryRepoContext, withRepoContextLoadingGuidance, getAllenMcpConfig, buildHumanResumeInput, type HumanInterventionPayload } from '@allen/engine';
import {
  getRuntimeApiBaseUrl,
  getRuntimeJwtAccessSecret,
  getRuntimePublicBaseUrl,
} from '../runtime/config.js';

/**
 * Claude-spawn-only system-prompt notice. Appended (via appendSystemPrompt
 * or inlined into customSystemPrompt) to every Claude-path spawn so the
 * model doesn't emit `ToolSearch` calls out of habit from the interactive
 * Claude Code harness. `ToolSearch` has no handler in the SDK/CLI spawn
 * environment — emitting it used to stall the stream for ~15 min until
 * Anthropic's idle watchdog fired. Not applied on the Codex path (Codex
 * doesn't emit this pattern and has its own prompt conventions).
 */
const CLAUDE_SPAWN_NOTICE = `
## Execution environment

You are running as a spawned agent via the Claude CLI / SDK, NOT the
interactive Claude Code harness. Therefore:

- MCP tools are loaded eagerly according to this agent's MCP configuration — call the tool you want
  directly by its full name (for example \`mcp__allen__*\`,
  \`mcp__pipeline-api-server__*\`, \`mcp__documentdb__*\`, \`mcp__postgres__*\`,
  \`mcp__opensearch__*\`, \`mcp__oxylabs-server__*\`, \`mcp__aws__*\`).
- The \`ToolSearch\` tool is NOT available in this environment. Never
  emit a \`ToolSearch\` call — it has no handler here and emitting it
  will stall the run until the idle watchdog fires.
- If you're unsure a tool exists, just attempt the call — an
  unknown-tool error surfaces in seconds, whereas \`ToolSearch\` hangs.
`.trim();

function toHumanInterventionPayload(doc: {
  stage: string;
  kind?: string;
  widget?: string;
  severity?: string;
  title?: string;
  summary?: string;
  question?: string;
  fields?: Array<any>;
  actions?: Array<any>;
  evidence?: Array<any>;
  retry_exhaustion?: Record<string, unknown>;
}): HumanInterventionPayload {
  return {
    kind: doc.kind === 'clarify' || doc.kind === 'review' || doc.kind === 'recover'
      ? doc.kind
      : doc.severity === 'approval'
        ? 'review'
        : doc.severity === 'escalation'
          ? 'recover'
        : 'clarify',
    widget: doc.widget === 'dynamic_form' || doc.widget === 'approval_gate' || doc.widget === 'retry_exhausted_gate' || doc.widget === 'escalation_gate'
      ? doc.widget
      : undefined,
    node: doc.stage,
    title: doc.title ?? doc.stage,
    summary: doc.summary,
    question: doc.question ?? '',
    severity: doc.severity === 'approval' || doc.severity === 'escalation' || doc.severity === 'question'
      ? doc.severity
      : 'question',
    fields: (doc.fields ?? []).map((field) => ({
      name: String(field.name ?? ''),
      type: (field.type === 'string' || field.type === 'text' || field.type === 'textarea' || field.type === 'boolean' || field.type === 'number' || field.type === 'select'
        ? field.type
        : 'text') as 'string' | 'text' | 'textarea' | 'boolean' | 'number' | 'select',
      label: typeof field.label === 'string' ? field.label : undefined,
      required: typeof field.required === 'boolean' ? field.required : undefined,
      options: Array.isArray(field.options) ? field.options.filter((item: unknown): item is string => typeof item === 'string') : undefined,
      default: field.default,
    })).filter((field) => field.name),
    actions: (doc.actions ?? []).map((action) => ({
      id: String(action.id ?? ''),
      label: typeof action.label === 'string' ? action.label : undefined,
      intent: typeof action.intent === 'string' ? action.intent as any : undefined,
      feedbackRequired: typeof action.feedbackRequired === 'boolean' ? action.feedbackRequired : undefined,
      feedbackOptional: typeof action.feedbackOptional === 'boolean' ? action.feedbackOptional : undefined,
      warning: typeof action.warning === 'string' ? action.warning : undefined,
      route: action.route && typeof action.route === 'object' && !Array.isArray(action.route)
        ? action.route as any
        : undefined,
    })).filter((action) => action.id),
    evidence: doc.evidence as HumanInterventionPayload['evidence'],
    retryExhaustion: doc.retry_exhaustion as HumanInterventionPayload['retryExhaustion'],
  };
}

const ALWAYS_ON_ALLEN_CONTEXT_TOOLS = [
  `mcp__${MCP_SERVER_NAME}__get_repo_context_body`,
  `mcp__${MCP_SERVER_NAME}__get_repo_skill_body`,
  `mcp__${MCP_SERVER_NAME}__get_node_context_usage`,
];

// Codex CLI spawn lifecycle controls. Without these, a hung codex child
// (or one blocked writing to stderr because nobody drains the pipe) holds
// the spawning Promise's closure alive forever — see the workspace
// memory-pressure incident on 2026-04-27 where this pattern drove the
// allen.service cgroup past MemoryHigh and triggered uv_thread_create
// failures across the box.
//
// Idle watchdog is the real protection: legitimate agent runs may take
// hours, but they emit stdout regularly (thinking, tool calls, messages),
// so 5 min of *pure silence* reliably means stuck. The total cap is just
// a backstop against runaway loops that keep streaming forever — set
// generously so it never trips a real run.
const CODEX_STREAM_IDLE_MS = 5 * 60_000;        // kill if no stdout for 5 min
const CODEX_TOTAL_TIMEOUT_MS = 12 * 60 * 60_000; // backstop: 12 h wall time
const CODEX_KILL_GRACE_MS = 5_000;              // SIGTERM → SIGKILL escalation
const CODEX_STDERR_TAIL_BYTES = 4096;           // bounded stderr tail for diagnostics

/** Resolve cwd for agent/chat spawns. Never falls back to process.cwd() —
 * we don't want agents running inside the server's own source tree. */
function resolveAgentCwd(...candidates: Array<string | undefined>): string {
  const picked = candidates.find((c) => typeof c === 'string' && c.length > 0) ?? AGENT_FALLBACK_CWD;
  mkdirSync(picked, { recursive: true });
  return picked;
}

function externalMcpServersForAgent(agent: Record<string, unknown> | null | undefined): string[] {
  const configured = agent?.externalMcpServers;
  return Array.isArray(configured)
    ? configured.filter((name): name is string => typeof name === 'string' && name.length > 0)
    : [];
}

function disabledMcpToolsForAgent(agent: Record<string, unknown> | null | undefined): Record<string, string[]> {
  const configured = agent?.disabledMcpTools;
  const result: Record<string, string[]> = {};
  if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
    for (const [server, tools] of Object.entries(configured)) {
      if (Array.isArray(tools)) result[server] = tools.filter((name): name is string => typeof name === 'string' && name.length > 0);
    }
  }
  const legacyAllen = agent?.disabledAllenMcpTools;
  if (Array.isArray(legacyAllen)) {
    result[MCP_SERVER_NAME] = [
      ...new Set([
        ...(result[MCP_SERVER_NAME] ?? []),
        ...legacyAllen.filter((name): name is string => typeof name === 'string' && name.length > 0),
      ]),
    ];
  }
  return result;
}

/**
 * True when the given path is an ephemeral /tmp-style location. Used to gate
 * repo-context injection: when an agent's cwd is a real repo or workspace
 * clone, it can Read files directly — context is redundant. Only /tmp-based
 * cwds (where the agent has no filesystem access to the repo) still need the
 * injected summary. Handles Linux, macOS (`/private/tmp`), and `/var/tmp`.
 */
function isEphemeralCwd(path: string | undefined): boolean {
  if (!path) return false;
  const normalized = path.replace(/\/+$/, '');
  return (
    normalized === '/tmp' || normalized.startsWith('/tmp/') ||
    normalized === '/var/tmp' || normalized.startsWith('/var/tmp/') ||
    normalized === '/private/tmp' || normalized.startsWith('/private/tmp/')
  );
}

/**
 * Decide whether Claude agent execution uses the CLI (file-materialized)
 * path or the in-process SDK path. Resolution order:
 *   1. Explicit ALLEN_AGENT_EXECUTION_MODE=cli|sdk wins.
 *   2. Otherwise CLI. This keeps Claude-provider execution on the globally
 *      installed Claude Code CLI everywhere by default.
 */
function resolveExecutionMode(_cwd: string | undefined): 'sdk' | 'cli' {
  const explicit = process.env.ALLEN_AGENT_EXECUTION_MODE;
  if (explicit === 'cli') return 'cli';
  if (explicit === 'sdk') return 'sdk';
  return 'cli';
}

// ── Active Session Registry ──────────────────────────────────────────────────
// When chat.service starts processing a message, it registers the session context.
// delegation tools (delegate_to_agent, report_to_user) read from this registry
// to know which session they're running in, even when called via MCP → API chain.

export interface ActiveSessionContext {
  chatSessionId: string;
  parentMessageId: string;
  /** Which agent is currently responding (undefined = Allen Assistant) */
  currentAgent?: string;
  /** Current delegation depth (0 = top-level chat, 1+ = delegated) */
  delegationDepth: number;
  /** Current conversation ID (for tracking parent-child delegation chains) */
  currentConversationId?: string;
  /** Broadcast SSE events to the chat listeners */
  broadcastEvent: (event: string, data: Record<string, unknown>) => void;
  /** Number of background tasks (delegations/spawns) still running */
  pendingBackgroundTasks: number;
  /** Resolved working directory — set by chat.service.ts, inherited by all spawned/delegated agents */
  resolvedCwd?: string;
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

/**
 * Resolve the active session for a tool call from explicit context only.
 * The context is threaded through from the MCP subprocess's
 * `x-allen-chat-session-id` header. Missing context intentionally returns
 * undefined instead of probing the global active-session map.
 */
export function resolveActiveSession(context?: ChatToolContext): ActiveSessionContext | undefined {
  if (!context?.chatSessionId) return undefined;
  return getActiveSession(context.chatSessionId);
}

// ── Process Registry — track PIDs for agent executions so they can be killed on cancel ──

const runningProcesses = new Map<string, { pid: number; kill: () => void }>();

/** Register a running process for an execution */
export function registerExecutionProcess(executionId: string, pid: number, killFn: () => void): void {
  runningProcesses.set(executionId, { pid, kill: killFn });
}

/** Kill and clean up a running execution process */
export function killExecutionProcess(executionId: string): boolean {
  const proc = runningProcesses.get(executionId);
  if (proc) {
    try { proc.kill(); } catch {}
    runningProcesses.delete(executionId);
    return true;
  }
  return false;
}

/** Build a human-readable description from tool name + args */
function toolDescription(tool: string, args: Record<string, unknown>): string {
  // Common Claude Code / Codex tools
  if (tool === 'Read' || tool === 'read_file') return `Read ${args.file_path ?? args.path ?? ''}`;
  if (tool === 'Write' || tool === 'write_file') return `Write ${args.file_path ?? args.path ?? ''}`;
  if (tool === 'Edit' || tool === 'edit_file') return `Edit ${args.file_path ?? args.path ?? ''}`;
  if (tool === 'Bash' || tool === 'bash' || tool === 'execute_command') return `$ ${(args.command as string ?? '').slice(0, 150)}`;
  if (tool === 'Glob' || tool === 'glob') return `Find files: ${args.pattern ?? ''} ${args.path ? `in ${args.path}` : ''}`;
  if (tool === 'Grep' || tool === 'grep' || tool === 'search') return `Search: ${args.pattern ?? args.query ?? ''} ${args.path ? `in ${args.path}` : ''}`;
  if (tool === 'ListDir' || tool === 'list_directory') return `List ${args.path ?? '.'}`;

  // MCP tools — extract meaningful info
  if (tool.startsWith('mcp__')) {
    const parts = tool.split('__');
    const server = parts[1] ?? '';
    const fn = parts.slice(2).join('__');
    // Allen MCP tools
    if (fn === 'list_workflows') return 'List workflows';
    if (fn === 'list_agents') return 'List agents';
    if (fn === 'list_repos') return 'List repos';
    if (fn === 'wait_for_execution') return `Get execution ${(args.execution_id as string ?? '').slice(0, 12)}`;
    if (fn === 'spawn_agent') return `Spawn ${args.agent_name ?? 'agent'}`;
    if (fn === 'delegate_to_agent') return `Delegate to ${args.agent_name ?? 'agent'}: ${(args.task as string ?? '').slice(0, 80)}`;
    if (fn === 'wait_for_delegation') return `Wait for delegation ${(args.conversation_id as string ?? '').slice(0, 12)}`;
    if (fn === 'run_workflow') return `Run workflow ${args.workflow_name ?? args.workflow_id ?? ''}`;
    if (fn === 'save_learning') return `Save learning: ${(args.content as string ?? '').slice(0, 60)}`;
    if (fn === 'query_database') return `Query: ${(args.query as string ?? '').slice(0, 80)}`;
    return `${server}/${fn}`;
  }

  // Generic — show first string arg
  const firstStr = Object.values(args).find(v => typeof v === 'string') as string | undefined;
  return firstStr ? `${tool}: ${firstStr.slice(0, 100)}` : tool;
}

/** Resolve workspace path — ONLY from explicitly linked session, no blind fallback */
async function resolveWorkspacePath(db: Db, chatSessionId?: string): Promise<string | null> {
  if (!chatSessionId) return null;
  try {
    const ws = await db.collection('workspaces').findOne({ chatSessionId, status: { $nin: ['archived', 'failed'] } });
    return (ws?.worktreePath as string) ?? null;
  } catch { return null; }
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

/**
 * Context threaded through to every tool execution so tools can look up
 * the exact chat / spawn-execution they belong to.
 *
 * The MCP subprocess sets env vars (ALLEN_CHAT_SESSION_ID,
 * ALLEN_PARENT_EXECUTION_ID, ALLEN_ROOT_EXECUTION_ID) and forwards them
 * as `x-allen-*` headers. The route dispatcher reads the headers and
 * passes them into `executeChatTool` → each tool's `execute`.
 *
 * All fields optional to stay backwards-compatible with direct callers
 * (linear.service, internal tests) that don't have the MCP header
 * context. When absent, chat-scoped tools leave the run unbound or return
 * a local context error; they must not infer another active chat.
 */
export interface ChatToolContext {
  chatSessionId?: string;
  parentExecutionId?: string;
  rootExecutionId?: string;
}

export interface ChatTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** If true, this tool mutates state (requires approval in guided/manual mode) */
  destructive?: boolean;
  execute: (args: Record<string, unknown>, db: Db, context?: ChatToolContext) => Promise<Record<string, unknown>>;
}

/** Tools that mutate state — require approval in guided mode */
export const DESTRUCTIVE_TOOLS = new Set([
  'run_workflow', 'cancel_execution', 'spawn_agent', 'submit_execution_input', 'delegate_to_agent',
  // MCP tools that mutate (linear create/edit/delete)
  'mcp__linear__linear_create_issue', 'mcp__linear__linear_edit_issue',
  'mcp__linear__linear_delete_issue', 'mcp__linear__linear_create_comment',
  'mcp__linear__linear_bulk_update_issues',
  'allen_monitoring_update_scan_cursor',
  'allen_monitoring_create_evidence_bundle',
  'allen_monitoring_upsert_incident',
  'allen_monitoring_update_incident',
  // Meta team tools (phase 4 — team-builder / agent-builder)
  ...META_DESTRUCTIVE_TOOLS,
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

function trimForTool(value: unknown, max = 220): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function hasMeaningfulRepoContextUsage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return [
    'module_identified',
    'context_preselected',
    'context_summary_used',
    'context_loaded',
    'context_applied',
    'context_skipped',
    'validation_performed',
  ].some((key) => {
    const current = record[key];
    return Array.isArray(current) ? current.length > 0 : current != null && current !== '';
  });
}

function formatActivityForCaller(row: Record<string, unknown>): string | undefined {
  const agent = trimForTool(row.agent, 60) ?? 'agent';
  const type = row.type;
  if (type === 'tool_call') {
    const tool = trimForTool(row.tool, 80) ?? 'tool';
    const content = trimForTool(row.content, 140);
    return content ? `${agent} called ${tool}: ${content}` : `${agent} called ${tool}`;
  }
  if (type === 'tool_result') {
    const tool = trimForTool(row.tool, 80) ?? 'tool';
    const content = trimForTool(row.content, 140);
    return content ? `${agent} got ${tool} result: ${content}` : `${agent} received ${tool} result`;
  }
  const content = trimForTool(row.content, 180);
  if (!content) return undefined;
  return `${agent}: ${content}`;
}

function formatLogForCaller(log: Record<string, unknown>): string | undefined {
  const msg = trimForTool(log.message ?? log.content ?? log.command ?? log.tool ?? log.type, 220);
  if (!msg) return undefined;
  const node = trimForTool(log.node, 60);
  const category = trimForTool(log.category, 40);
  const prefix = node ? `[${node}]` : category ? `[${category}]` : '';
  return prefix ? `${prefix} ${msg}` : msg;
}

async function readExecutionLogWindow(
  db: Db,
  executionId: string,
  since?: Date,
): Promise<{ top_logs: Array<Record<string, unknown>>; log_summary: string[]; latest_log_at?: string }> {
  const filter: Record<string, unknown> = { executionId };
  if (since && !Number.isNaN(since.getTime())) filter.timestamp = { $gt: since };
  const logs = await db.collection('execution_logs')
    .find(filter)
    .sort({ timestamp: -1, createdAt: -1 })
    .limit(8)
    .toArray();
  logs.reverse();
  const topLogs = logs.map((log) => ({
    timestamp: log.timestamp ?? log.createdAt,
    level: log.level,
    category: log.category ?? log.type,
    node: log.node ?? null,
    message: trimForTool(log.message ?? log.content ?? log.command ?? log.tool ?? log.type, 300) ?? '',
  }));
  const logSummary = logs
    .map((log) => formatLogForCaller(log))
    .filter((line): line is string => Boolean(line))
    .slice(-5);
  const latest = logs.length > 0 ? logs[logs.length - 1] : null;
  const latestAt = latest?.timestamp instanceof Date
    ? latest.timestamp.toISOString()
    : latest?.createdAt instanceof Date
      ? latest.createdAt.toISOString()
      : undefined;
  return { top_logs: topLogs, log_summary: logSummary, latest_log_at: latestAt };
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

const getWorkflow: ChatTool = {
  name: 'get_workflow',
  description: 'Get full workflow details, including parsed.input. Call this before run_workflow and pass input using the exact parsed.input field names.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Workflow name' },
      id: { type: 'string', description: 'Workflow MongoDB _id' },
    },
  },
  async execute(args, db) {
    const id = typeof args.id === 'string' ? args.id : undefined;
    const name = typeof args.name === 'string' ? args.name : undefined;
    if (!id && !name) return { error: 'Provide either name or id' };

    const filter: Record<string, unknown> = { archived: { $ne: true } };
    if (id) {
      if (!ObjectId.isValid(id)) return { error: `Invalid workflow id "${id}"` };
      filter._id = new ObjectId(id);
    } else {
      filter.name = name;
    }

    const workflow = await db.collection('workflows').findOne(filter);
    if (!workflow) return { error: 'Workflow not found' };
    return {
      id: (workflow._id as ObjectId).toString(),
      name: workflow.name,
      description: workflow.description ?? '',
      version: workflow.version ?? 1,
      input: workflow.parsed?.input ?? {},
      nodes: workflow.parsed?.nodes ?? {},
      edges: workflow.parsed?.edges ?? [],
      parsed: {
        input: workflow.parsed?.input ?? {},
        nodes: workflow.parsed?.nodes ?? {},
        edges: workflow.parsed?.edges ?? [],
      },
      validation: workflow.validation ?? null,
      yaml: workflow.yaml ?? '',
    };
  },
};

const runWorkflow: ChatTool = {
  name: 'run_workflow',
  description: 'Start executing a workflow with given input parameters. Returns execution ID to track progress. Use list_workflows to choose a workflow, then get_workflow to inspect parsed.input. The input object must use the exact schema field names.',
  inputSchema: {
    type: 'object',
    properties: {
      workflow_name: { type: 'string', description: 'Name of the workflow to run (e.g., "coding-agent", "blog-post")' },
      input: {
        type: 'object',
        description: 'Input parameters for the workflow, matching get_workflow.parsed.input exactly. Do not use aliases such as task when the workflow requires user_request.',
        additionalProperties: true,
      },
    },
    required: ['workflow_name'],
  },
  async execute(args, db, context) {
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
          hint: 'Call get_workflow first and rebuild input with the exact parsed.input field names.',
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
    const executionId = String(result.id ?? '');
    const activeCtx = resolveActiveSession(context);
    const chatSessionId = activeCtx?.chatSessionId ?? context?.chatSessionId;
    if (chatSessionId) {
      const chatMeta: Record<string, unknown> = {
        source: 'chat',
        'meta.origin': 'chat',
        'meta.chatSessionId': chatSessionId,
      };
      if (activeCtx?.parentMessageId) chatMeta['meta.parentMessageId'] = activeCtx.parentMessageId;
      if (typeof input.linear_title === 'string') chatMeta['meta.linearTitle'] = input.linear_title;
      if (typeof input.linear_identifier === 'string') chatMeta['meta.linearIdentifier'] = input.linear_identifier;
      if (typeof input.linear_url === 'string') chatMeta['meta.linearUrl'] = input.linear_url;
      if (typeof input.task === 'string') chatMeta['meta.requestText'] = input.task;
      else if (typeof input.request === 'string') chatMeta['meta.requestText'] = input.request;
      else if (typeof input.prompt === 'string') chatMeta['meta.requestText'] = input.prompt;
      if (typeof input.workspace_id === 'string') chatMeta['meta.workspaceId'] = input.workspace_id;
      if (typeof input.repo_path === 'string') chatMeta['meta.workspacePath'] = input.repo_path;
      if (typeof input.worktree_path === 'string') chatMeta['meta.workspacePath'] = input.worktree_path;
      await db.collection('executions').updateOne(
        { id: executionId },
        { $set: chatMeta },
      ).catch((err) => logger.warn('[chat-tools] failed to attach chat metadata to workflow execution', {
        component: 'chat-tools',
        executionId,
        chatSessionId,
        error: (err as Error).message,
      }));
    }
    return {
      execution_id: result.id,
      status: result.status,
      workflow_name: result.workflowName,
      message: `Workflow "${name}" started. Execution ID: ${result.id}. Status: ${result.status}.`,
    };
  },
};

const getExecution: ChatTool = {
  name: 'wait_for_execution',
  description: `Get the status of a workflow or spawned agent execution. If still running, blocks up to 90 seconds waiting for completion (like wait_for_delegation). If status="waiting", call again. When completed, includes the agent's response. Also returns recent_activity, top_logs, and activity_summary since activity_since so the caller can narrate what is happening inside the execution — pass the returned activity_cursor back as activity_since on the next call to stream forward.`,
  inputSchema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'The execution ID to check' },
      activity_since: { type: 'string', description: 'ISO timestamp cursor. Pass activity_cursor from the previous wait_for_execution response to fetch only newer events.' },
    },
    required: ['execution_id'],
  },
  async execute(args, db) {
    const executionId = args.execution_id as string;
    const activitySince = typeof args.activity_since === 'string' ? new Date(args.activity_since) : undefined;
    const executionService = new ExecutionService(db);

    // Helper — pulls the latest activity window for this execution. Used
    // both when the execution has finished (so the tool's final response
    // still includes recent events) and when we're about to return
    // status: "waiting" (so the caller can narrate progress).
    const { AgentActivityService } = await import('./agent-activity.service.js');
    const activityService = new AgentActivityService(db);
    const readActivity = async () => {
      const rows = await activityService.recent(executionId, { since: activitySince, limit: 10 });
      const logWindow = await readExecutionLogWindow(db, executionId, activitySince);
      const activitySummary = [
        ...rows.map((row) => formatActivityForCaller(row as unknown as Record<string, unknown>)),
        ...logWindow.log_summary,
      ].filter((line): line is string => Boolean(line)).slice(-8);
      const cursorCandidates = [
        rows.length > 0 ? rows[rows.length - 1].at : undefined,
        logWindow.latest_log_at,
        activitySince?.toISOString(),
      ].filter((value): value is string => Boolean(value));
      const activityCursor = cursorCandidates
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
      return {
        recent_activity: rows,
        top_logs: logWindow.top_logs,
        activity_summary: activitySummary,
        progress_message: activitySummary.length > 0 ? activitySummary[activitySummary.length - 1] : undefined,
        activity_cursor: activityCursor,
      };
    };

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

        // When paused waiting for input, surface the clarify payload so the
        // LLM can explain to the user what the workflow is asking for.
        let inputRequest: Record<string, unknown> | undefined;
        let pendingIntervention: Record<string, unknown> | undefined;
        if (exec.status === 'waiting_for_input') {
          const st = (exec.state ?? {}) as Record<string, unknown>;
          const waitingNode = Array.isArray(exec.currentNodes) && exec.currentNodes[0] ? exec.currentNodes[0] : undefined;
          const reason = (st.__reason as string) ?? 'The workflow is waiting for your input.';
          const fields = (st.__clarify_fields as unknown[]) ?? [
            { name: 'response', type: 'text', label: 'Your response', required: true },
          ];
          const reviewContent = typeof st.__clarify_content === 'string'
            ? st.__clarify_content
            : st.__clarify_content != null
              ? JSON.stringify(st.__clarify_content, null, 2)
              : undefined;
          inputRequest = {
            node: waitingNode,
            prompt: reason,
            fields,
            review_content: reviewContent,
            review_content_type: st.__clarify_content_type ?? 'markdown',
            clarify_action: st.__clarify_action ?? 'retry',
          };

          // Also look up any pending intervention for this execution so the
          // LLM can offer intervention_id shortcuts (used by InterventionsPage).
          try {
            const interventionService = new InterventionService(db);
            const pending = await interventionService.listForWorkflowRun(executionId);
            const active = pending.find(p => p.status === 'pending');
            if (active) {
              pendingIntervention = {
                intervention_id: active.intervention_id,
                severity: active.severity,
                title: active.title,
                stage: active.stage,
              };
            }
          } catch {
            // Intervention service lookup is best-effort — not fatal if it fails.
          }
        }

        const finalActivity = await readActivity();
        return {
          id: exec.id,
          workflow_name: exec.workflowName,
          status: exec.status,
          response,
          session_id: sessionId,
          completed_nodes: exec.completedNodes,
          current_nodes: exec.currentNodes,
          failed_node: exec.failedNode,
          error: exec.errorMessage,
          cost: exec.cost,
          duration_ms: exec.durationMs,
          started_at: exec.startedAt,
          completed_at: exec.completedAt,
          input_request: inputRequest,
          pending_intervention: pendingIntervention,
          ...finalActivity,
        };
      }

      // Still running — wait
      await new Promise(r => setTimeout(r, waitMs));
      waitMs = Math.min(waitMs * 1.3, maxWaitMs);
    }

    // Still running after 90s — return "waiting" so LLM calls again.
    // Include the latest activity window so the caller can narrate what
    // the delegated agent is doing instead of silently polling.
    const waitingActivity = await readActivity();
    return {
      id: executionId,
      status: 'waiting',
      message: 'Execution is still running. Call wait_for_execution again — it will continue waiting.',
      ...waitingActivity,
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

const resumeExecution: ChatTool = {
  name: 'resume_execution',
  description: 'Resume a cancelled/failed/completed execution after the user explicitly chooses resume. Spawned agents/team leads resume their prior agent session when available. Workflows resume from a checkpoint; latest checkpoint is used if checkpoint_id is omitted.',
  inputSchema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'Cancelled/failed/completed execution ID to resume' },
      prompt: { type: 'string', description: 'Follow-up prompt for agent/team-lead resumes. Optional for workflows.' },
      checkpoint_id: { type: 'string', description: 'Workflow checkpoint ID to resume from. If omitted, uses latest checkpoint.' },
    },
    required: ['execution_id'],
  },
  async execute(args, db) {
    const executionId = String(args.execution_id ?? '');
    if (!executionId) return { error: 'execution_id is required' };
    const exec = await db.collection('executions').findOne({ id: executionId });
    if (!exec) return { error: `Execution "${executionId}" not found.` };

    const workflowName = String(exec.workflowName ?? '');
    const isAgentExecution =
      workflowName.includes(':spawn_agent/') ||
      exec.source === 'spawn' ||
      (!exec.workflowId && exec.source === 'chat');
    logger.debug('resume.tool.routed', { executionId, route: isAgentExecution ? 'agent' : 'workflow', workflowName });
    if (isAgentExecution) {
      const input = ((exec.input ?? {}) as Record<string, unknown>) ?? {};
      const prompt = typeof args.prompt === 'string' && args.prompt.trim()
        ? args.prompt.trim()
        : `Resume the interrupted task. Original task: ${String(input.prompt ?? input.task ?? workflowName)}`;
      return resumeAgentExecution(db, executionId, prompt);
    }

    const executionService = new ExecutionService(db);
    let checkpointId = typeof args.checkpoint_id === 'string' && args.checkpoint_id.trim()
      ? args.checkpoint_id.trim()
      : '';
    if (!checkpointId) {
      const checkpoints = await executionService.listCheckpoints(executionId);
      checkpointId = String(checkpoints[0]?._id ?? '');
    }
    if (!checkpointId) {
      return {
        error: `Workflow execution "${executionId}" has no checkpoints to resume from. Ask the user if they want a fresh start instead.`,
      };
    }
    return executionService.runFromCheckpoint(executionId, checkpointId);
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
  description: `Spawn a technical agent in the background. Returns immediately with execution_id. The agent runs until done — use wait_for_execution(execution_id) to check when finished (it may take minutes). Pass session_id from a previous spawn to resume with context.`,
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
  async execute(args, db, context) {
    const agentName = args.agent_name as string;
    const prompt = args.prompt as string;
    const resumeSession = args.session_id as string | undefined;

    const role = await db.collection('agents').findOne({ name: agentName });
    if (!role) {
      return { error: `Agent "${agentName}" not found. Use list_agents to see available agents.` };
    }

    // Resolve repo_path: explicit arg > session context cwd > workspace linked
    // to session > agent's sourceRepoPath (set when imported from a repo).
    // The imported-repo fallback lets agents that were pulled from a Claude
    // agents file auto-run in their source repo without the caller passing
    // it every time. Explicit caller paths still win — this is a *default*,
    // not a lock.
    let repoPath = args.repo_path as string | undefined;
    if (!repoPath) {
      const activeCtx = resolveActiveSession(context);
      const sessionId = activeCtx?.chatSessionId ?? context?.chatSessionId;
      repoPath = activeCtx?.resolvedCwd ?? await resolveWorkspacePath(db, sessionId) ?? undefined;
    }
    if (!repoPath && typeof role.sourceRepoPath === 'string' && role.sourceRepoPath) {
      repoPath = role.sourceRepoPath;
    }

    const { randomUUID } = await import('node:crypto');
    const executionId = randomUUID();
    const activeCtxForMeta = resolveActiveSession(context);
    const chatSessionIdForMeta = activeCtxForMeta?.chatSessionId ?? context?.chatSessionId;

    // ── Spawn-tree linkage (Phase 1 of the workflow-spawn visibility plan) ──
    //
    // The Allen MCP server propagates these three fields via env vars
    // captured from whichever claude-cli subprocess launched it. For
    // workflow-node-initiated spawns they're set by node-executor.ts; for
    // nested spawns (a spawned agent spawning another) they're set below
    // by runSpawnInBackground when it launches the child's subprocess.
    //
    //   parent_execution_id → immediate parent's execution id
    //   parent_caller       → immediate parent's label (node name OR agent name)
    //   root_execution_id   → top-of-tree execution id (workflow run or chat run)
    //
    // For top-level chat-initiated spawns, none of these are set and we
    // fall back to the chat session context (`chat` as caller, this
    // execution as its own root).
    const parentExecutionId = (args.parent_execution_id as string | undefined) || null;
    const parentCaller = (args.parent_caller as string | undefined)?.trim() || null;
    const providedRoot = (args.root_execution_id as string | undefined) || null;
    const providedArtifactRootType = (args.artifact_root_type as string | undefined) || undefined;
    const providedArtifactRootId = (args.artifact_root_id as string | undefined) || undefined;
    const providedRepoKnowledgePacketId = (args.repo_knowledge_packet_id as string | undefined) || null;
    const providedRepoKnowledgeRepoId = (args.repo_knowledge_repo_id as string | undefined) || null;
    const providedRepoKnowledgeIndexId = (args.repo_knowledge_index_id as string | undefined) || null;
    const providedRepoKnowledgeRepoName = (args.repo_knowledge_repo_name as string | undefined) || null;
    const providedRepoKnowledgeFreshness = (args.repo_knowledge_freshness as string | undefined) || null;
    const callerLabel = parentCaller || 'chat';
    const workflowName = `${callerLabel}:spawn_agent/${agentName}`;
    // Root defaults to this new execution if no upstream root was passed.
    // Used by Phase 3 log fan-out to broadcast the entire spawn subtree up
    // to the top-of-tree execution page in one indexed lookup.
    const rootExecutionId = providedRoot || executionId;
    // Depth = 1 if we have a parent, else 0 (root). Walks aren't needed —
    // parents send us their depth implicitly by being a parent at all.
    // We compute the real depth at nested-spawn time by looking up the
    // parent row; if missing, we fall back to 1.
    let spawnDepth = 0;
    if (parentExecutionId) {
      try {
        const parentDoc = await db.collection('executions').findOne(
          { id: parentExecutionId },
          { projection: { spawnDepth: 1 } },
        );
        spawnDepth = ((parentDoc?.spawnDepth as number | undefined) ?? 0) + 1;
      } catch {
        spawnDepth = 1;
      }
    }

    await db.collection('executions').insertOne({
      id: executionId,
      workflowName,
      workflowId: null,
      workflowVersion: 0,
      status: 'running',
      source: parentCaller ? 'spawn' : 'chat',
      input: { prompt, agent_name: agentName, repo_path: repoPath, session_id: resumeSession },
      // Execution metadata for tracing
      meta: {
        cwd: repoPath || AGENT_FALLBACK_CWD,
        provider: (role.provider as string) ?? 'claude',
        model: (role.model as string) ?? 'sonnet',
        spawnedBy: activeCtxForMeta?.currentAgent ?? parentCaller ?? 'user',
        chatSessionId: chatSessionIdForMeta,
        parentMessageId: activeCtxForMeta?.parentMessageId,
        repoKnowledgeParent: providedRepoKnowledgePacketId ? {
          packetId: providedRepoKnowledgePacketId,
          repoId: providedRepoKnowledgeRepoId,
          indexId: providedRepoKnowledgeIndexId,
          repoName: providedRepoKnowledgeRepoName,
          freshness: providedRepoKnowledgeFreshness,
        } : undefined,
      },
      // Spawn-tree linkage — indexed for the /children query and Phase 3 fan-out.
      parentExecutionId,
      parentCaller,
      rootExecutionId,
      spawnDepth,
      state: {},
      sessions: {},
      retryCounts: {},
      currentNodes: [agentName],
      completedNodes: [],
      cost: { actual: null, estimated: 0 },
      durationMs: 0,
      startedAt: new Date(),
    });

    // Run in background — return immediately so MCP doesn't timeout.
    // Pass the spawn-tree context so runSpawnInBackground can propagate the
    // env vars onward to this agent's own claude-cli subprocess, allowing
    // grandchild spawns (`agent A spawns agent B`) to carry correct
    // parent/root linkage.
    // Decide the artifact root. Precedence:
    //   1. Explicit artifact_root_* from the tool call (forwarded by the
    //      Allen MCP when a nested spawn inherits from its parent).
    //   2. Chat session context (top-level chat-initiated spawns) — files
    //      belong to the chat, not the agent exec.
    //   3. Workflow/root execution id when the caller came from a workflow.
    //   4. This execution's own id — only hit for standalone agent runs
    //      that don't have a chat or workflow parent.
    let artifactRootType: string | undefined = providedArtifactRootType;
    let artifactRootId: string | undefined = providedArtifactRootId;
    if (!artifactRootType || !artifactRootId) {
      if (chatSessionIdForMeta) {
        artifactRootType = 'chat';
        artifactRootId = chatSessionIdForMeta;
      } else if (providedRoot) {
        // A workflow-initiated spawn has a root execution id. Default
        // artifact root to that — it's the top of the workflow run.
        artifactRootType = 'workflow';
        artifactRootId = providedRoot;
      } else {
        artifactRootType = 'agent';
        artifactRootId = executionId;
      }
    }

    runSpawnInBackground(db, role, agentName, prompt, executionId, resumeSession, repoPath, {
      parentExecutionId,
      parentCaller,
      rootExecutionId,
      spawnDepth,
      artifactRootType,
      artifactRootId,
      repoKnowledgePacketId: providedRepoKnowledgePacketId,
      repoKnowledgeRepoId: providedRepoKnowledgeRepoId,
      repoKnowledgeIndexId: providedRepoKnowledgeIndexId,
      repoKnowledgeRepoName: providedRepoKnowledgeRepoName,
      repoKnowledgeFreshness: providedRepoKnowledgeFreshness,
    }, 1, context).catch(() => {});

    return {
      agent_name: agentName,
      execution_id: executionId,
      status: 'running',
      message: `Agent "${agentName}" started. Use wait_for_execution(execution_id="${executionId}") to poll for the result.`,
    };
  },
};

/**
 * Context passed from spawnAgent.execute to runSpawnInBackground so the
 * spawned agent's claude-cli subprocess can propagate the spawn-tree env
 * vars onward. Lets grandchild spawns (an agent calling spawn_agent from
 * inside its own session) receive correct parent/root linkage instead of
 * defaulting back to `chat:`.
 */
interface SpawnTreeContext {
  parentExecutionId: string | null;
  parentCaller: string | null;
  rootExecutionId: string;
  spawnDepth: number;
  /** Artifact-root overrides — when set, propagated into the spawned
   *  subprocess's env so `allen_save_artifact` files under the original
   *  top-level run (chat session / workflow exec / root agent) instead
   *  of each nested spawn creating its own root. */
  artifactRootType?: string;
  artifactRootId?: string;
  repoKnowledgePacketId?: string | null;
  repoKnowledgeRepoId?: string | null;
  repoKnowledgeIndexId?: string | null;
  repoKnowledgeRepoName?: string | null;
  repoKnowledgeFreshness?: string | null;
}

async function markSpawnCompletedUnlessTerminal(
  db: Db,
  executionId: string,
  agentName: string,
  costUsd: number,
  durationMs: number,
  sessionId?: string,
): Promise<boolean> {
  const completionFields: Record<string, unknown> = {
    status: 'completed',
    completedNodes: [agentName],
    currentNodes: [],
    cost: { actual: costUsd, estimated: costUsd },
    durationMs,
    completedAt: new Date(),
  };
  if (sessionId) completionFields[`sessions.${agentName}`] = sessionId;

  const result = await db.collection('executions').updateOne(
    { id: executionId, status: { $nin: ['completed', 'cancelled', 'canceled', 'failed'] } },
    { $set: completionFields },
  );

  if (result.matchedCount > 0) return true;

  if (sessionId) {
    await db.collection('executions').updateOne(
      { id: executionId },
      { $set: { [`sessions.${agentName}`]: sessionId, durationMs } },
    );
  }
  return false;
}

/** Run spawn_agent in background — supports both Claude and Codex with MCP + tracing */
async function runSpawnInBackground(
  db: Db, role: Record<string, unknown>, agentName: string, prompt: string,
  executionId: string, resumeSession: string | undefined, repoPath: string | undefined,
  spawnTree?: SpawnTreeContext,
  /** 1 for a fresh execution; >1 when this invocation continues an existing
   *  execution (agent resume). Threaded into trace inserts so the execution
   *  detail page can show per-attempt tabs. */
  baseAttempt: number = 1,
  /** Tool-call context forwarded from the caller. When the spawn is
   *  initiated via the MCP dispatcher, this carries the x-allen-chat-
   *  session-id header so we attach SSE / artifact state to the right
   *  chat. */
  context?: ChatToolContext,
): Promise<void> {
  const activeCtx = resolveActiveSession(context);
  const contextChatSessionId = activeCtx?.chatSessionId ?? context?.chatSessionId;
  if (activeCtx) activeCtx.pendingBackgroundTasks++;
  const onEvent = activeCtx?.broadcastEvent;
  const startMs = Date.now();
  const provider = role.provider ?? 'claude';
  // Normalize alias → full model ID. The bundled Claude Code CLI (used in SDK
  // mode) has stale alias tables that resolve `haiku` → claude-3-5-haiku-20241022
  // which returns 404. We pin current IDs in packages/engine/src/model-alias.ts.
  const model = normalizeModelAlias((role.model as string) ?? 'sonnet') ?? 'sonnet';
  const activity: { type: string; tool?: string; timestamp: Date }[] = [];

  // Persist spawn activity to agent_activity so the wait tools can return
  // a `recent_activity` cursor and the UI replay route can hydrate this
  // execution's event log on refresh. Fire-and-forget — failures here
  // must never stall the delegation stream.
  const activityService = new AgentActivityService(db);
  const persistSpawnActivity = (
    rawType: 'tool_start' | 'tool_done' | 'thinking' | 'text',
    data: { tool?: string; content?: string; toolUseId?: string; command?: string },
  ): void => {
    const type =
      rawType === 'tool_start' ? 'tool_call'
      : rawType === 'tool_done' ? 'tool_result'
      : rawType;
    void activityService.record({
      scope: 'execution',
      refId: executionId,
      chatSessionId: contextChatSessionId,
      agent: agentName,
      type,
      tool: data.tool,
      content: data.content ?? data.command,
      toolUseId: data.toolUseId,
    });
  };

  // Broadcast spawn started + persist log
  if (onEvent) onEvent('spawn_started', {
    executionId,
    agent: agentName,
    prompt: prompt.slice(0, 200),
    provider,
    model,
    parentExecutionId: spawnTree?.parentExecutionId ?? null,
    parentCaller: spawnTree?.parentCaller ?? null,
    rootExecutionId: spawnTree?.rootExecutionId ?? executionId,
    spawnDepth: spawnTree?.spawnDepth ?? 0,
  });

  // ── Phase 3 log fan-out setup ──
  //
  // When this spawn is part of a workflow-initiated spawn tree, we want its
  // log entries to appear LIVE on the parent workflow's execution detail
  // page, not just on the child's own page. We achieve this by:
  //
  //   1. Keeping the primary write to execution_logs under the child's
  //      executionId (unchanged — child's own /logs endpoint still works).
  //   2. Broadcasting an SSE-only mirror to the ROOT execution's channel
  //      with the entry reshaped into the engine's log schema + extra
  //      child-tag fields (childExecutionId, childAgentName, childCaller)
  //      so the parent UI can render it as an indented child log line.
  //
  // The /api/executions/:id/logs endpoint also does a union query so
  // refresh / initial load reconstructs the same merged view from
  // persisted rows (see execution.routes.ts).
  const spawnTreeRoot = spawnTree?.rootExecutionId ?? executionId;
  const spawnTreeParentCaller = spawnTree?.parentCaller ?? null;
  const fanOutEnabled = !!spawnTree?.parentExecutionId || spawnTreeRoot !== executionId;
  const streamSvc = await import('./stream.service.js');
  const liveLog = (entry: { type: string; tool?: string; command?: string; content?: string; toolUseId?: string; args?: Record<string, unknown> }) => {
    const now = new Date();
    // Primary write — child's own execution_logs row, unchanged schema.
    db.collection('execution_logs').insertOne({
      executionId, agent: agentName, ...entry, timestamp: now,
    }).catch(() => {});

    // Fan-out to the root execution's SSE channel when this spawn is part
    // of a workflow-rooted tree. Reshape the entry into the engine's log
    // schema so useExecution.handleEvent (which expects `category` /
    // `node` / `message`) renders it without special-casing.
    if (fanOutEnabled) {
      const category: 'tool' | 'agent' | 'system' =
        entry.type === 'tool_use' || entry.tool ? 'tool'
        : entry.type === 'text' ? 'agent'
        : 'system';
      const message = entry.content ?? (entry.tool ? `Tool: ${entry.tool}` : entry.type);
      streamSvc.broadcastSSEOnly(spawnTreeRoot, {
        event: 'execution_log',
        data: {
          executionId: spawnTreeRoot,
          timestamp: now,
          level: 'info',
          category,
          // Attribute the child log to the node that spawned the top-level
          // ancestor of this chain. For direct children this is the
          // workflow node name (e.g. 'develop'). For grandchildren it's
          // whatever their direct parent's parentCaller was — the parent
          // log line will already show the nested relationship.
          node: spawnTreeParentCaller ?? agentName,
          message: typeof message === 'string' ? message : String(message),
          data: {
            childExecutionId: executionId,
            childAgentName: agentName,
            childParentCaller: spawnTreeParentCaller,
            childDepth: spawnTree?.spawnDepth ?? 1,
            originalType: entry.type,
            originalTool: entry.tool,
          },
        },
      });
    }
  };
  liveLog({ type: 'started', content: `Agent ${agentName} spawned in ${repoPath || '/tmp/allen'}` });

  // Inject workspace constraint with port info
  let workspaceConstraint = '';
  if (repoPath && repoPath !== '/tmp/allen') {
    let portInfo = '';
    try {
      const ws = await db.collection('workspaces').findOne({ worktreePath: repoPath, status: { $nin: ['archived', 'failed'] } });
      if (ws?.services?.length) {
        portInfo = `\nWorkspace services:\n${(ws.services as any[]).map((s: any) => `- ${s.name}: port ${s.port}`).join('\n')}`;
        portInfo += `\nWhen writing tests or making HTTP requests, use these ports — NOT the default ports (4023, 5173, etc.)`;
      }
    } catch {}
    workspaceConstraint = `\n\nWORKSPACE CONSTRAINT:\nYour working directory is: ${repoPath}\nCRITICAL: ALL file operations (Read, Write, Edit, Grep, Glob, Bash) MUST use paths within this directory.\n- Use relative paths or absolute paths starting with "${repoPath}/"\n- NEVER read, write, or modify files outside this directory\n- If search results show paths outside this directory, replace the base with "${repoPath}/"${portInfo}\n`;
  }

  // Inject the deep repo context block only when the agent's cwd is an
  // ephemeral /tmp location where it can't Read repo files directly. When cwd
  // is the repo or a workspace clone (the common case), the agent has
  // filesystem access via Read/Grep/Glob — context injection is redundant and
  // burns tokens. Always skip for the scanner itself to avoid circularity.
  const contextEngineEnabled = isContextEngineEnabled();
  let repoContextBlock = '';
  if (contextEngineEnabled && repoPath && agentName !== 'repo-scanner' && isEphemeralCwd(repoPath)) {
    try {
      repoContextBlock = await buildRepoContextBlock(db, repoPath);
      if (repoContextBlock) {
        liveLog({ type: 'started', content: `Injected repo context (${repoContextBlock.length} chars)` });
      }
    } catch (err) {
      logger.error('[spawn] failed to build repo context block', { executionId, agentName, error: (err as Error).message });
    }
  }

  let repoKnowledgePacketSummary: {
    packetId: string;
    repoId: string;
    repoName?: string;
    indexId?: string;
    indexFreshness?: string;
    mandatoryContextInjectedCount?: number;
    mandatoryContextSkippedProviderNativeCount?: number;
    mandatoryContextTargetLayer?: string;
    systemPromptContextInjected?: boolean;
  } | null = null;
  let repoKnowledgeSystemPromptBlock = '';
  if (contextEngineEnabled && repoPath) {
    try {
      const repoKnowledge = new RepoContextPacketService(db);
      const packet = await repoKnowledge.buildNodeContextPacket({
        executionId,
        workflowName: spawnTree?.parentCaller ? `${spawnTree.parentCaller}:spawn_agent/${agentName}` : `chat:spawn_agent/${agentName}`,
        nodeName: agentName,
        nodeRole: agentName,
        executionKind: 'spawned_agent',
        targetRole: agentName,
        callerRole: spawnTree?.parentCaller ?? undefined,
        attempt: baseAttempt,
        state: { repo_path: repoPath, worktree_path: repoPath },
        prompt,
        parentPacketId: spawnTree?.repoKnowledgePacketId ?? undefined,
        parentExecutionId: spawnTree?.parentExecutionId ?? undefined,
        rootExecutionId: spawnTree?.rootExecutionId ?? executionId,
        provider: provider === 'codex' ? 'codex' : 'claude',
      });
      if (packet) {
        repoKnowledgeSystemPromptBlock = packet.systemPromptBlock ?? '';
        repoKnowledgePacketSummary = packet.traceSummary;
        liveLog({ type: 'started', content: `Resolved repo knowledge packet ${packet.packetId}` });
      }
    } catch (err) {
      logger.warn('[spawn] failed to build repo knowledge packet', { executionId, agentName, error: (err as Error).message });
    }
  }

  const repoKnowledgeEnv = (): Record<string, string> => {
    if (!contextEngineEnabled) return {};
    if (repoKnowledgePacketSummary) {
      return {
        ALLEN_REPO_KNOWLEDGE_PACKET_ID: repoKnowledgePacketSummary.packetId,
        ALLEN_REPO_KNOWLEDGE_REPO_ID: repoKnowledgePacketSummary.repoId,
        ALLEN_REPO_KNOWLEDGE_INDEX_ID: repoKnowledgePacketSummary.indexId ?? '',
        ALLEN_REPO_KNOWLEDGE_REPO_NAME: repoKnowledgePacketSummary.repoName ?? '',
        ALLEN_REPO_KNOWLEDGE_FRESHNESS: repoKnowledgePacketSummary.indexFreshness ?? '',
      };
    }
    if (spawnTree?.repoKnowledgePacketId) {
      return {
        ALLEN_REPO_KNOWLEDGE_PACKET_ID: spawnTree.repoKnowledgePacketId,
        ALLEN_REPO_KNOWLEDGE_REPO_ID: spawnTree.repoKnowledgeRepoId ?? '',
        ALLEN_REPO_KNOWLEDGE_INDEX_ID: spawnTree.repoKnowledgeIndexId ?? '',
        ALLEN_REPO_KNOWLEDGE_REPO_NAME: spawnTree.repoKnowledgeRepoName ?? '',
        ALLEN_REPO_KNOWLEDGE_FRESHNESS: spawnTree.repoKnowledgeFreshness ?? '',
      };
    }
    return {};
  };

  const initialRenderedPrompt = prompt;
  const roleSystem = (role.system as string) ?? '';
  const repoContextLoadingGuidanceAlreadyPresent = hasRepoContextLoadingGuidance(roleSystem);
  const roleSystemWithRepoContextGuidance = contextEngineEnabled
    ? withRepoContextLoadingGuidance(roleSystem)
    : roleSystem;
  const roleSystemWithMandatoryRepoContext = contextEngineEnabled
    ? withMandatoryRepoContext(roleSystemWithRepoContextGuidance, repoKnowledgeSystemPromptBlock)
    : roleSystemWithRepoContextGuidance;
  const repoContextLoadingGuidancePresent = hasRepoContextLoadingGuidance(roleSystemWithRepoContextGuidance);
  const repoContextLoadingGuidanceInjected =
    !repoContextLoadingGuidanceAlreadyPresent && repoContextLoadingGuidancePresent;

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
      logger.info('[spawn] Auto-retry', { executionId, agentName, attempt, session: currentResumeSession?.slice(0, 12) });
      prompt = 'Continue from where you left off. Complete your task and provide the final response.';
    }
    const promptForThisAttempt = attempt === 0 ? initialRenderedPrompt : prompt;

    if (provider === 'codex') {
      // ── Codex CLI with MCP ──
      // Note: no per-call syncMcpToCodex — sync happens once on server boot
      // to avoid races between parallel chats rebuilding the Codex config.
      const { spawn } = await import('node:child_process');

      // Same spawn-tree + artifact context as the Claude path below — the
      // Allen MCP server running inside Codex reads these to tag nested
      // spawns + route artifacts to the correct root.
      const codexSpawnEnv: Record<string, string> = {
        ALLEN_PARENT_EXECUTION_ID: executionId,
        ALLEN_PARENT_CALLER: agentName,
        ALLEN_ROOT_EXECUTION_ID: spawnTree?.rootExecutionId ?? executionId,
        ALLEN_ARTIFACT_ROOT_TYPE: spawnTree?.artifactRootType ?? 'agent',
        ALLEN_ARTIFACT_ROOT_ID: spawnTree?.artifactRootId ?? executionId,
        ALLEN_ARTIFACT_AGENT_NAME: agentName,
        ALLEN_ARTIFACT_AGENT_EXECUTION_ID: executionId,
        ALLEN_ARTIFACT_PARENT_ID: executionId,
        ...repoKnowledgeEnv(),
        // Session marker so callbacks from this spawn's MCP subprocess
        // carry x-allen-chat-session-id on outbound /api/chat/* calls.
        // Only set when the spawn tree is rooted in a chat; omitted for
        // workflow-initiated spawns so the server doesn't mis-route
        // them to a chat context.
        ...(contextChatSessionId ? { ALLEN_CHAT_SESSION_ID: contextChatSessionId } : {}),
      };

      // Per-call MCP env overrides — codex doesn't forward parent env
      // to MCP children, so the codexSpawnEnv values above never reach
      // the Allen MCP. Inject them via -c TOML overrides instead.
      const mcpEnvOverrides: string[] = [];
      for (const [k, v] of Object.entries(codexSpawnEnv)) {
        mcpEnvOverrides.push('-c', `mcp_servers.${MCP_SERVER_NAME}.env.${k}="${v.replace(/"/g, '\\"')}"`);
      }
      mcpEnvOverrides.push(
        '-c', `mcp_servers.${MCP_SERVER_NAME}.env.ALLEN_API_URL="${getRuntimeApiBaseUrl()}"`,
        '-c', `mcp_servers.${MCP_SERVER_NAME}.env.JWT_ACCESS_SECRET="${getRuntimeJwtAccessSecret()}"`,
        '-c', `mcp_servers.${MCP_SERVER_NAME}.env.ALLEN_PUBLIC_URL="${getRuntimePublicBaseUrl()}"`,
      );

      const args: string[] = ['exec'];
      if (currentResumeSession) {
        args.push('resume', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
        if (mcpEnvOverrides.length > 0) args.push(...mcpEnvOverrides);
        args.push('--', currentResumeSession, promptForThisAttempt);
      } else {
        args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
        if (model) args.push('-c', `model="${model}"`);
        if (mcpEnvOverrides.length > 0) args.push(...mcpEnvOverrides);
        args.push(`${roleSystemWithMandatoryRepoContext}${repoContextBlock}${workspaceConstraint}${ARTIFACTS_GUIDANCE}${NON_INTERACTIVE_GUIDANCE}\n\n${promptForThisAttempt}`);
      }

      const result = await new Promise<{ text: string; threadId?: string }>((resolveP, rejectP) => {
        const proc = spawn('codex', args, { cwd: resolveAgentCwd(repoPath), env: { ...process.env, ...codexSpawnEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
        const spawnStartMs = Date.now();
        let text = '';
        let threadId: string | undefined = resumeSession;
        let buf = '';
        let stderrTail = '';
        let settled = false;
        let idleTimer: NodeJS.Timeout | undefined;
        let totalTimer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;

        const clearTimers = () => {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
          if (totalTimer) { clearTimeout(totalTimer); totalTimer = undefined; }
          if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
        };

        // Persist threadId to outer scope as soon as it's observed so the
        // retry loop can resume even when this spawn is killed by a watchdog.
        const settle = (action: () => void) => {
          if (settled) return;
          settled = true;
          clearTimers();
          if (threadId) currentResumeSession = threadId;
          action();
        };

        const escalateKill = (reason: string) => {
          try { proc.kill('SIGTERM'); } catch {}
          if (killTimer) clearTimeout(killTimer);
          killTimer = setTimeout(() => {
            logger.error('[codex] sigkill', { executionId, agentName, pid: proc.pid ?? '?', reason });
            try { proc.kill('SIGKILL'); } catch {}
          }, CODEX_KILL_GRACE_MS);
        };

        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            logger.error('[codex] timeout-idle', { executionId, agentName, pid: proc.pid ?? '?', idleSec: CODEX_STREAM_IDLE_MS / 1000, thread: threadId?.slice(0, 12) ?? 'none' });
            escalateKill('idle');
            settle(() => rejectP(new Error(`codex stream idle for ${CODEX_STREAM_IDLE_MS / 1000}s (timeout)${stderrTail ? `; stderr tail: ${stderrTail.slice(-512)}` : ''}`)));
          }, CODEX_STREAM_IDLE_MS);
        };

        proc.on('error', (err) => {
          logger.error('[codex] spawn error', { executionId, agentName, pid: proc.pid ?? '?', error: err.message });
          settle(() => rejectP(new Error(`Failed to spawn codex: ${err.message}. Is codex CLI installed?`)));
        });
        proc.stdin.end();
        // Register PID for cancel support
        if (proc.pid) {
          registerExecutionProcess(executionId, proc.pid, () => { try { proc.kill('SIGTERM'); } catch {} });
          db.collection('executions').updateOne({ id: executionId }, { $set: { 'meta.pid': proc.pid } }).catch(() => {});
        }
        logger.info('[codex] start', { executionId, agentName, pid: proc.pid ?? '?', resume: currentResumeSession ? currentResumeSession.slice(0, 12) : 'new' });

        totalTimer = setTimeout(() => {
          logger.error('[codex] timeout-total', { executionId, agentName, pid: proc.pid ?? '?', totalSec: CODEX_TOTAL_TIMEOUT_MS / 1000, thread: threadId?.slice(0, 12) ?? 'none' });
          escalateKill('total-timeout');
          settle(() => rejectP(new Error(`codex exceeded ${CODEX_TOTAL_TIMEOUT_MS / 1000}s total timeout${stderrTail ? `; stderr tail: ${stderrTail.slice(-512)}` : ''}`)));
        }, CODEX_TOTAL_TIMEOUT_MS);
        resetIdleTimer();

        // Drain stderr so codex doesn't block on a full pipe buffer (default
        // 64 KiB on Linux); keep a bounded tail for diagnostics on failure.
        proc.stderr.on('data', (chunk: Buffer) => {
          stderrTail += chunk.toString();
          if (stderrTail.length > CODEX_STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-CODEX_STDERR_TAIL_BYTES);
        });

        proc.stdout.on('data', (chunk: Buffer) => {
          resetIdleTimer();
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'thread.started' && evt.thread_id) {
                threadId = evt.thread_id;
                // Persist to outer scope immediately so retry-on-timeout can
                // resume — waiting for Promise resolution loses threadId if
                // the spawn is killed by a watchdog.
                currentResumeSession = evt.thread_id;
                // Eagerly persist to executions.sessions so a SIGTERM/crash
                // after this point still leaves a resumable session id.
                db.collection('executions').updateOne(
                  { id: executionId },
                  { $set: { [`sessions.${agentName}`]: evt.thread_id } },
                ).catch((err) => logger.warn('[codex] session.eager_persist_failed', { executionId, agentName, error: (err as Error).message }));
                logger.info('[codex] thread.started', { executionId, agentName, pid: proc.pid ?? '?', thread: String(evt.thread_id).slice(0, 12) });
              }
              if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
                const t = evt.item.text ?? evt.item.content?.filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('') ?? '';
                if (t) { text = t; liveLog({ type: 'text', content: t.slice(-300) }); }
              }
              // Capture reasoning/thinking
              if (evt.type === 'item.started' && evt.item?.type === 'agent_reasoning') {
                liveLog({ type: 'thinking' });
              }
              if (evt.type === 'item.completed' && evt.item?.type === 'agent_reasoning') {
                const thought = evt.item.text ?? '';
                if (thought) liveLog({ type: 'thinking', content: thought.slice(-300) });
              }
              if (evt.type === 'item.started' && (evt.item?.type === 'mcp_tool_call' || evt.item?.type === 'collab_tool_call')) {
                const server = evt.item.server ?? evt.item.serverLabel ?? '';
                const tool = evt.item.tool ?? evt.item.name ?? '';
                const name = server ? `mcp__${server}__${tool}` : tool;
                const args = evt.item.arguments ?? evt.item.input ?? {};
                const itemId = evt.item.id ?? '';
                toolCalls.push({ tool: name, args });
                activity.push({ type: 'tool_call', tool: name, timestamp: new Date() });
                // Build description from args for readability
                const desc = toolDescription(name, args);
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_start', tool: name, content: desc, toolUseId: itemId });
                persistSpawnActivity('tool_start', { tool: name, content: desc, toolUseId: itemId });
                liveLog({ type: 'tool_start', tool: name, content: desc, toolUseId: itemId, args });
              }
              if (evt.type === 'item.completed' && (evt.item?.type === 'mcp_tool_call' || evt.item?.type === 'collab_tool_call')) {
                const server = evt.item.server ?? evt.item.serverLabel ?? '';
                const tool = evt.item.tool ?? evt.item.name ?? '';
                const name = server ? `mcp__${server}__${tool}` : tool;
                const output = evt.item.output ?? evt.item.result ?? '';
                const outStr = typeof output === 'string' ? output.slice(0, 150) : JSON.stringify(output).slice(0, 150);
                const itemId = evt.item.id ?? '';
                activity.push({ type: 'tool_result', tool: name, timestamp: new Date() });
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_done', tool: name, content: outStr, toolUseId: itemId });
                persistSpawnActivity('tool_done', { tool: name, content: outStr, toolUseId: itemId });
                liveLog({ type: 'tool_done', tool: name, content: outStr, toolUseId: itemId });
              }
              if (evt.type === 'item.completed' && evt.item?.type === 'function_call') {
                const fn = evt.item.name ?? 'unknown';
                const fnArgs = evt.item.arguments ? JSON.parse(evt.item.arguments) : {};
                const desc = toolDescription(fn, fnArgs);
                const callId = evt.item.call_id ?? evt.item.id ?? '';
                toolCalls.push({ tool: fn, args: fnArgs });
                activity.push({ type: 'tool_call', tool: fn, timestamp: new Date() });
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_done', tool: fn, content: desc, toolUseId: callId });
                persistSpawnActivity('tool_done', { tool: fn, content: desc, toolUseId: callId });
                liveLog({ type: 'tool_done', tool: fn, content: desc, toolUseId: callId, args: fnArgs });
              }
              if (evt.type === 'item.completed' && evt.item?.type === 'command_execution') {
                const cmd = (evt.item.command ?? '').slice(0, 200);
                const exitCode = evt.item.exit_code ?? '';
                const itemId = evt.item.id ?? '';
                toolCalls.push({ tool: 'Bash', args: { command: cmd } });
                activity.push({ type: 'tool_call', tool: 'Bash', timestamp: new Date() });
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_done', tool: 'Bash', command: cmd, toolUseId: itemId });
                persistSpawnActivity('tool_done', { tool: 'Bash', content: cmd, toolUseId: itemId });
                liveLog({ type: 'tool_done', tool: 'Bash', command: cmd, content: exitCode !== '' ? `exit ${exitCode}` : undefined, toolUseId: itemId, args: { command: cmd } });
              }
              // Broadcast thinking
              if (evt.type === 'item.started' && evt.item?.type === 'agent_reasoning') {
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'thinking' });
                persistSpawnActivity('thinking', {});
                liveLog({ type: 'thinking' });
              }
            } catch {}
          }
        });
        proc.on('close', (code, signal) => {
          const durationMs = Date.now() - spawnStartMs;
          if (code != null && code !== 0) {
            logger.error('[codex] non-zero-exit', { executionId, agentName, pid: proc.pid ?? '?', code, signal: signal ?? 'null', durationMs, textBytes: text.length });
            settle(() => rejectP(new Error(`codex exited code=${code} signal=${signal ?? 'null'}${stderrTail ? `; stderr tail: ${stderrTail.slice(-512)}` : ''}`)));
            return;
          }
          logger.info('[codex] close', { executionId, agentName, pid: proc.pid ?? '?', code: code ?? 'null', signal: signal ?? 'null', durationMs, textBytes: text.length, thread: threadId?.slice(0, 12) ?? 'none' });
          settle(() => resolveP({ text, threadId }));
        });
      });

      response = result.text;
      sessionId = result.threadId;
      if (sessionId) currentResumeSession = sessionId; // for retries

    } else {
      // ── Claude CLI with MCP ──
      const { query } = await import('@anthropic-ai/claude-code');
      const { loadAllMcpServers } = await import('@allen/engine');

      // Spawn-tree env propagation for any grandchild spawn this agent
      // initiates. From the grandchild's perspective:
      //   PARENT_EXECUTION_ID → this (spawning) execution's id
      //   PARENT_CALLER       → this agent's name
      //   ROOT_EXECUTION_ID   → unchanged from above, so the whole subtree
      //                         shares one root for Phase 3 fan-out.
      // Top-level chat-initiated spawns still populate these so grandchild
      // spawns form a proper tree rooted at this execution.
      const spawnContextEnv: Record<string, string> = {
        ALLEN_PARENT_EXECUTION_ID: executionId,
        ALLEN_PARENT_CALLER: agentName,
        ALLEN_ROOT_EXECUTION_ID: spawnTree?.rootExecutionId ?? executionId,
        // Artifact-root propagation — the Allen MCP server reads these
        // when the spawned agent calls allen_save_artifact. Inherits
        // unchanged from this spawn's own tree context so nested spawns
        // file under the original top-level run.
        ALLEN_ARTIFACT_ROOT_TYPE: spawnTree?.artifactRootType ?? 'agent',
        ALLEN_ARTIFACT_ROOT_ID: spawnTree?.artifactRootId ?? executionId,
        ALLEN_ARTIFACT_AGENT_NAME: agentName,
        ALLEN_ARTIFACT_AGENT_EXECUTION_ID: executionId,
        ALLEN_ARTIFACT_PARENT_ID: executionId,
        ...repoKnowledgeEnv(),
        // Session marker — see codex spawn path above for rationale.
        ...(contextChatSessionId ? { ALLEN_CHAT_SESSION_ID: contextChatSessionId } : {}),
      };

      // Pass the spawn context directly into the MCP config loader so the
      // Allen MCP server subprocess gets the vars in its own env dict —
      // not relying on claude-cli's parent-env inheritance for MCP
      // children, which is implementation-defined.
      const externalMcpServers = externalMcpServersForAgent(role as Record<string, unknown>);
      const disabledMcpTools = disabledMcpToolsForAgent(role as Record<string, unknown>);
      const disallowedMcpToolNames = Object.entries(disabledMcpTools).flatMap(([server, tools]) =>
        tools.map((tool) => tool.startsWith('mcp__') ? tool : `mcp__${server}__${tool}`),
      );
      const mcpServers = await loadAllMcpServers(db, {
        extraEnv: spawnContextEnv,
        externalServerNames: externalMcpServers,
      });
      const sdkOptions: Record<string, unknown> = {
        model, permissionMode: 'bypassPermissions',
        // Pin cwd so the SDK doesn't implicitly inherit the server's own
        // process.cwd() — agents should never run in the server source tree.
        cwd: resolveAgentCwd(repoPath),
        // Also set env on the claude-cli subprocess itself, so any logic
        // inside the CLI (or tools that fall back to process.env) can see
        // the spawn tree. Merged on top of parent env.
        env: { ...process.env, ...spawnContextEnv },
        ...(disallowedMcpToolNames.length > 0 ? { disallowedTools: disallowedMcpToolNames } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      };
      if (currentResumeSession) sdkOptions.resume = currentResumeSession;
      else {
        // ALLEN_SYSTEM_PROMPT_MODE: 'append' (default) preserves Claude
        // Code's built-in agentic scaffolding; 'custom' reverts to the old
        // full-replacement behavior. Matches node-executor.ts wiring.
        // CLAUDE_SPAWN_NOTICE warns the model that ToolSearch isn't wired
        // here (claude-cli only — codex path above has its own prompt).
        const systemPromptBody = `${CLAUDE_SPAWN_NOTICE}\n\n${roleSystemWithMandatoryRepoContext}${repoContextBlock}${workspaceConstraint}${ARTIFACTS_GUIDANCE}${NON_INTERACTIVE_GUIDANCE}`;
        if (process.env.ALLEN_SYSTEM_PROMPT_MODE === 'custom') sdkOptions.customSystemPrompt = systemPromptBody;
        else sdkOptions.appendSystemPrompt = systemPromptBody;
      }

      // Register abort controller for cancel support
      const abortController = new AbortController();
      sdkOptions.abortController = abortController;
      registerExecutionProcess(executionId, process.pid, () => abortController.abort());

      // Execution mode. Claude-provider spawns default to CLI mode. Explicit
      // ALLEN_AGENT_EXECUTION_MODE=cli|sdk overrides. See cli-runner.ts.
      const useCliMode = resolveExecutionMode(sdkOptions.cwd as string | undefined) === 'cli';
      let msgStream: AsyncIterable<any>;
      if (useCliMode) {
        const { queryViaCli } = await import('@allen/engine');
        // Discover every registered MCP's tool list once so the
        // materialized agent file's `tools:` allowlist (if the agent
        // has one) gets the full mcp__<server>__<tool> set appended.
        // Without this, an agent with `tools: [Read, Write, Bash]`
        // can't see Linear / Postgres / GitHub tools even though
        // their MCPs are loaded — Claude Code treats the allowlist
        // as a hard cap. `loadMcpTools` is idempotent + caches
        // connections so repeated spawns don't re-spawn MCPs.
        let discoveredMcpTools: string[] = [];
        try {
          const { loadMcpTools } = await import('./chat-mcp-client.js');
          discoveredMcpTools = (await loadMcpTools(db, { externalServerNames: externalMcpServers })).map(t => t.fullName);
        } catch (err) {
          logger.warn('[spawn] MCP tool discovery failed (allowlist will lack mcp__* entries)', { executionId, agentName, error: (err as Error).message });
        }
        discoveredMcpTools = Array.from(new Set([...discoveredMcpTools, ...ALWAYS_ON_ALLEN_CONTEXT_TOOLS]));
        msgStream = queryViaCli({
          agent: {
            name: agentName,
            description: (role as any)?.description,
            // Mirror the SDK path — ARTIFACTS_GUIDANCE and CLAUDE_SPAWN_NOTICE
            // must be part of the system prompt for the CLI branch too.
            // Without ARTIFACTS_GUIDANCE, CLI-mode agents never see the
            // instruction to save via allen_save_artifact. Without
            // CLAUDE_SPAWN_NOTICE, CLI-mode agents emit `ToolSearch` out of
            // harness habit and stall their stream for ~15 min.
            system: `${CLAUDE_SPAWN_NOTICE}\n\n${roleSystemWithMandatoryRepoContext}${repoContextBlock}${workspaceConstraint}${ARTIFACTS_GUIDANCE}${NON_INTERACTIVE_GUIDANCE}`,
            model: sdkOptions.model as string | undefined,
            tools: Array.isArray((role as any)?.tools) ? (role as any).tools : undefined,
            mcpToolNames: discoveredMcpTools,
            disabledMcpTools,
            materializedNameSuffix: repoKnowledgeSystemPromptBlock ? `${executionId}-${agentName}-${repoKnowledgePacketSummary?.packetId ?? 'context'}` : undefined,
          },
          prompt: promptForThisAttempt,
          cwd: sdkOptions.cwd as string | undefined,
          model: sdkOptions.model as string | undefined,
          resume: sdkOptions.resume as string | undefined,
          permissionMode: 'bypassPermissions',
          env: sdkOptions.env as NodeJS.ProcessEnv | undefined,
          mcpServers: sdkOptions.mcpServers as Record<string, unknown> | undefined,
          abortSignal: abortController.signal,
          onMaterializedAgentFile: (metadata) => {
            db.collection('executions').updateOne(
              { id: executionId },
              {
                $set: {
                  'meta.materializedAgentFile': {
                    subagentName: metadata.subagentName,
                    path: metadata.path,
                    sha256: metadata.sha256,
                    byteLength: metadata.byteLength,
                    containsMandatoryRepoContext: metadata.containsMandatoryRepoContext,
                    createdAt: metadata.createdAt,
                  },
                },
              },
            ).catch(() => { /* non-fatal */ });
            logger.info('[spawn] materialized claude agent file', {
              executionId,
              agentName,
              subagentName: metadata.subagentName,
              sha256: metadata.sha256,
              byteLength: metadata.byteLength,
              containsMandatoryRepoContext: metadata.containsMandatoryRepoContext,
            });
            liveLog({
              type: 'tool_start',
              content: `[claude-cli] materialized agent file ${metadata.subagentName} sha256=${metadata.sha256}`,
            });
          },
          stderr: (chunk) => liveLog({ type: 'tool_start', content: `[claude-cli stderr] ${chunk.slice(0, 4000)}` }),
          // Record the claude binary's PID on the executions row so the
          // zombie reconciler can detect "running" rows whose process has
          // died and transition them to failed. Mirrors the codex path's
          // meta.pid update.
          onPid: (pid: number) => {
            db.collection('executions').updateOne(
              { id: executionId },
              { $set: { 'meta.pid': pid } },
            ).catch(() => { /* non-fatal */ });
          },
        });
      } else {
        msgStream = query({ prompt: promptForThisAttempt, options: sdkOptions as any });
      }

      // Client-side idle watchdog (claude-cli path only). Claude's server-
      // side stream-idle timeout is ~15 min, which is too generous when a
      // run stalls. We race every `next()` against a setTimeout whose
      // threshold depends on whether we've already seen a `ToolSearch`
      // tool_use in this stream:
      //   - Default: 5 min. Longer than any legit single tool call
      //     should run, so false positives are rare.
      //   - After ToolSearch: 5 min. ToolSearch has no handler in the
      //     spawn env, so the stream is very likely to stall from here
      //     on — but the model can sometimes recover by emitting a
      //     different tool call after a long pause. 5 min beats
      //     Anthropic's 15-min server-side watchdog by a comfortable
      //     margin while giving the model time to course-correct.
      //     Bumped from 60s after agent runs were getting prematurely
      //     failed by the tighter window.
      // On timeout we abort the controller and let the existing catch/
      // retry logic at `isTimeout` take over.
      const STREAM_IDLE_MS = 900_000; // 15 min — general stall
      const STREAM_IDLE_AFTER_TOOLSEARCH_MS = 300_000; // 5 min — after ToolSearch
      let toolSearchSeen = false;
      const streamIterator = (msgStream as AsyncIterable<any>)[Symbol.asyncIterator]();
      while (true) {
        const currentIdleMs = toolSearchSeen ? STREAM_IDLE_AFTER_TOOLSEARCH_MS : STREAM_IDLE_MS;
        const raced = await Promise.race([
          streamIterator.next().then(r => ({ kind: 'msg' as const, result: r })),
          new Promise<{ kind: 'timeout' }>(resolve =>
            setTimeout(() => resolve({ kind: 'timeout' }), currentIdleMs),
          ),
        ]);
        if (raced.kind === 'timeout') {
          const reason = toolSearchSeen ? 'post-ToolSearch' : 'general';
          const warn = `[spawn:${agentName}] claude-cli stream idle >${currentIdleMs / 1000}s (${reason}) — aborting`;
          logger.warn('[spawn] claude-cli stream idle', { executionId, agentName, idleSec: currentIdleMs / 1000, reason });
          if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'warn', content: warn });
          abortController.abort(new Error('Stream idle (client-side watchdog)'));
          throw new Error(`claude-cli stream idle timeout (${currentIdleMs / 1000}s, ${reason})`);
        }
        if (raced.result.done) break;
        const msg = raced.result.value;

        if ('session_id' in msg && msg.session_id) {
          const incoming = msg.session_id as string;
          // Eagerly persist on first observation so a SIGTERM/crash before
          // the terminal updateOne (line ~1687) still leaves a resumable
          // session id on executions.sessions[agentName]. Fire-and-forget;
          // failures here must not stall the stream.
          if (sessionId !== incoming) {
            db.collection('executions').updateOne(
              { id: executionId },
              { $set: { [`sessions.${agentName}`]: incoming } },
            ).catch((err) => logger.warn('[spawn] session.eager_persist_failed', { executionId, agentName, error: (err as Error).message }));
          }
          sessionId = incoming;
          currentResumeSession = sessionId;
        }

        if (msg.type === 'assistant') {
          const blocks = (msg as any).message?.content as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }> ?? [];
          const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
          if (text) {
            response = text;
            if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'text', content: text.slice(-200) });
            persistSpawnActivity('text', { content: text.slice(-200) });
            liveLog({ type: 'text', content: text.slice(-200) });
          }
          for (const block of blocks) {
            if (block.type === 'tool_use' && block.name) {
              // Guard: Claude sometimes emits `ToolSearch` out of habit
              // from the interactive harness. Spawned agents don't have
              // that tool registered, so the stream would stall until
              // Anthropic's 15-min idle watchdog. Rather than abort
              // immediately, mark the stream as post-ToolSearch so the
              // watchdog above uses the shorter 1-min threshold. This
              // gives a small grace window in case the model recovers
              // on its own, while still cutting total wait from ~15 min
              // to ≤1 min. The existing isTimeout retry path (the
              // watchdog throws an error containing "timeout") then
              // re-runs with CLAUDE_SPAWN_NOTICE in force.
              if (block.name === 'ToolSearch' && !toolSearchSeen) {
                const warn = `[spawn:${agentName}] model emitted ToolSearch — will abort in ${STREAM_IDLE_AFTER_TOOLSEARCH_MS / 1000}s if stream stays idle`;
                logger.warn('[spawn] model emitted ToolSearch', { executionId, agentName, abortInSec: STREAM_IDLE_AFTER_TOOLSEARCH_MS / 1000 });
                if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'warn', content: warn });
                toolSearchSeen = true;
              }
              const args = (block.input as Record<string, unknown>) ?? {};
              const desc = toolDescription(block.name, args);
              const toolUseId = block.id ?? '';
              toolCalls.push({ tool: block.name, args });
              activity.push({ type: 'tool_call', tool: block.name, timestamp: new Date() });
              if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_start', tool: block.name, content: desc, toolUseId });
              persistSpawnActivity('tool_start', { tool: block.name, content: desc, toolUseId });
              liveLog({ type: 'tool_start', tool: block.name, content: desc, toolUseId, args });
            }
            if (block.type === 'thinking' && block.text) {
              if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'thinking', content: block.text.slice(-200) });
              persistSpawnActivity('thinking', { content: block.text.slice(-200) });
              liveLog({ type: 'thinking', content: block.text.slice(-200) });
            }
          }
        }

        if ((msg as any).type === 'tool_result' || ((msg as any).message?.role === 'tool')) {
          const toolName = (msg as any).tool_name ?? (msg as any).name ?? '';
          const toolUseId = (msg as any).tool_use_id ?? (msg as any).id ?? '';
          activity.push({ type: 'tool_result', tool: toolName, timestamp: new Date() });
          if (onEvent) onEvent('spawn_activity', { executionId, agent: agentName, type: 'tool_done', tool: toolName, toolUseId });
          persistSpawnActivity('tool_done', { tool: toolName, toolUseId });
          liveLog({ type: 'tool_done', tool: toolName, toolUseId });
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
    // Clean up process registry
    runningProcesses.delete(executionId);

    const markedCompleted = await markSpawnCompletedUnlessTerminal(
      db,
      executionId,
      agentName,
      costUsd,
      durationMs,
      sessionId,
    );
    if (!markedCompleted) {
      logger.info('[spawn] completion skipped because execution is already terminal', { executionId, agentName });
      if (activeCtx) activeCtx.pendingBackgroundTasks--;
      return;
    }

    // Broadcast completion + log
    if (onEvent) onEvent('spawn_completed', { executionId, agent: agentName, durationMs, toolCount: toolCalls.length, response: response.slice(0, 300) });
    liveLog({ type: 'completed', content: `Done in ${(durationMs/1000).toFixed(1)}s, ${toolCalls.length} tools` });

    const traceOutput: Record<string, unknown> = { response, session_id: sessionId };
    const executionTraceId = randomUUID();
    let contextUsageTrace: { traceId?: string; preselectedCount?: number; loadedCount: number; appliedCount: number; skippedCount: number } | null = null;
    let contextEvaluationId: string | undefined;
    if (repoKnowledgePacketSummary) {
      try {
        const repoKnowledge = new RepoContextPacketService(db);
        const recordedUsage = await repoKnowledge.recordContextUsage({
          executionId,
          executionTraceId,
          workflowName: spawnTree?.parentCaller ? `${spawnTree.parentCaller}:spawn_agent/${agentName}` : `chat:spawn_agent/${agentName}`,
          nodeName: agentName,
          nodeRole: agentName,
          executionKind: 'spawned_agent',
          targetRole: agentName,
          callerRole: spawnTree?.parentCaller ?? undefined,
          attempt: baseAttempt + attempt,
          packetId: repoKnowledgePacketSummary.packetId,
          outputs: traceOutput,
          rawResponse: response,
          toolCalls,
          parentPacketId: spawnTree?.repoKnowledgePacketId ?? null,
          parentExecutionId: spawnTree?.parentExecutionId ?? null,
          rootExecutionId: spawnTree?.rootExecutionId ?? executionId,
          parentNodeName: spawnTree?.parentCaller ?? undefined,
          agentName,
        });
        contextUsageTrace = recordedUsage ? {
          traceId: recordedUsage.traceId,
          preselectedCount: recordedUsage.preselectedCount,
          loadedCount: recordedUsage.loadedCount,
          appliedCount: recordedUsage.appliedCount,
          skippedCount: recordedUsage.skippedCount,
        } : null;
        contextEvaluationId = typeof recordedUsage?.contextEvaluation?.evaluationId === 'string'
          ? recordedUsage.contextEvaluation.evaluationId
          : typeof recordedUsage?.contextEvaluation?.traceId === 'string'
            ? recordedUsage.contextEvaluation.traceId
            : undefined;
        if (recordedUsage?.repoContextUsage && !hasMeaningfulRepoContextUsage(traceOutput.repo_context_usage)) {
          traceOutput.repo_context_usage = recordedUsage.repoContextUsage;
        }
      } catch (err) {
        logger.warn('[spawn] failed to record repo knowledge usage', { executionId, agentName, error: (err as Error).message });
      }
    }

    // Save full trace with response, tool calls, and activity.
    // `baseAttempt` is the attempt number for THIS invocation of the agent
    // (1 for a fresh execution, 2+ for a user-triggered resume). The inner
    // retry counter (`attempt`) is the auto-retry count within this
    // invocation — add it so an invocation that auto-recovers doesn't
    // collide with the base attempt of the run that spawned it.
    await db.collection('execution_traces').insertOne({
      executionId, executionTraceId, node: agentName, attempt: baseAttempt + attempt, status: 'completed', type: 'agent', agent: agentName,
      inputState: { prompt: initialRenderedPrompt }, renderedPrompt: initialRenderedPrompt, rawResponse: response,
      output: traceOutput,
      toolCalls,
      activity: activity.map(a => ({ ...a, type: a.type as any, content: a.tool ?? '' })),
      contextAttemptId: repoKnowledgePacketSummary?.packetId,
      contextUsageTraceId: contextUsageTrace?.traceId,
      contextEvaluationId,
      runtimeContext: {
        repoContextLoadingGuidancePresent,
        repoContextLoadingGuidanceInjected,
        mandatoryRepoContextInjected: Boolean(repoKnowledgeSystemPromptBlock),
        mandatoryRepoContextInjectedCount: repoKnowledgePacketSummary?.mandatoryContextInjectedCount,
        mandatoryRepoContextSkippedProviderNativeCount: repoKnowledgePacketSummary?.mandatoryContextSkippedProviderNativeCount,
        mandatoryRepoContextTargetLayer: provider === 'codex' && repoKnowledgeSystemPromptBlock ? 'codex_prompt_instruction_prefix' : repoKnowledgePacketSummary?.mandatoryContextTargetLayer,
      },
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
      logger.info('[spawn] timed out, will retry', { executionId, agentName, attempt: attempt + 1, session: currentResumeSession.slice(0, 12) });
      continue; // next iteration
    }

    const durationMs = Date.now() - startMs;
    // Persist sessionId on failure too — without this, an agent that emitted
    // its session marker but later crashed/timed out / got SIGTERM'd loses
    // its session id and becomes un-resumable.
    const failedSessionId = currentResumeSession;
    const currentExec = await db.collection('executions').findOne(
      { id: executionId },
      { projection: { status: 1 } },
    ).catch(() => null);
    if (currentExec?.status === 'cancelled') {
      if (activeCtx) activeCtx.pendingBackgroundTasks--;
      return;
    }
    await db.collection('executions').updateOne(
      { id: executionId },
      { $set: {
        status: 'failed', errorMessage: errorMsg, durationMs, completedAt: new Date(),
        ...(failedSessionId ? { [`sessions.${agentName}`]: failedSessionId } : {}),
      } },
    );
    await db.collection('execution_traces').insertOne({
      executionId, executionTraceId: randomUUID(), node: agentName, attempt: baseAttempt + attempt, status: 'failed', type: 'agent', agent: agentName,
      inputState: { prompt: initialRenderedPrompt }, renderedPrompt: initialRenderedPrompt, rawResponse: '',
      output: { error: errorMsg, session_id: failedSessionId },
      activity: activity.map(a => ({ ...a, type: a.type as any, content: a.tool ?? '' })),
      contextAttemptId: repoKnowledgePacketSummary?.packetId,
      runtimeContext: {
        repoContextLoadingGuidancePresent,
        repoContextLoadingGuidanceInjected,
        mandatoryRepoContextInjected: Boolean(repoKnowledgeSystemPromptBlock),
        mandatoryRepoContextInjectedCount: repoKnowledgePacketSummary?.mandatoryContextInjectedCount,
        mandatoryRepoContextSkippedProviderNativeCount: repoKnowledgePacketSummary?.mandatoryContextSkippedProviderNativeCount,
        mandatoryRepoContextTargetLayer: provider === 'codex' && repoKnowledgeSystemPromptBlock ? 'codex_prompt_instruction_prefix' : repoKnowledgePacketSummary?.mandatoryContextTargetLayer,
      },
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

// Test-injection seam — allows unit tests to spy on runSpawnInBackground.
// The function is called via __internalsForTest so tests can replace the reference.
export const __internalsForTest = {
  runSpawnInBackground: (...args: Parameters<typeof runSpawnInBackground>) =>
    runSpawnInBackground(...args),
  markSpawnCompletedUnlessTerminal,
};

/**
 * Resume a completed/failed agent execution as a new attempt on the SAME
 * executionId. Computes the next attempt number from existing traces, sets
 * the execution back to running, and spawns the agent in the background
 * resuming its prior session. The UI stays on the same execution page and
 * renders attempts as tabs.
 */
export async function resumeAgentExecution(
  db: Db,
  executionId: string,
  prompt: string,
): Promise<{ execution_id: string; attempt: number } | { error: string }> {
  const exec = await db.collection('executions').findOne({ id: executionId });
  if (!exec) return { error: `Execution ${executionId} not found` };

  // Agent name resolution. The SIGTERM-before-session case can leave both
  // currentNodes and completedNodes empty, so fall back to the original
  // input or the workflowName slug ('chat:spawn_agent/<name>').
  const wfName = (exec.workflowName as string | undefined) ?? '';
  const agentName =
    (exec.completedNodes as string[] | undefined)?.[0] ??
    (exec.currentNodes as string[] | undefined)?.[0] ??
    ((exec.input as Record<string, unknown> | undefined)?.agent_name as string | undefined) ??
    (wfName.includes(':spawn_agent/') ? wfName.split(':spawn_agent/')[1] : undefined);
  if (!agentName) return { error: 'Cannot resolve agent name for this execution' };

  const role = await db.collection('agents').findOne({ name: agentName });
  if (!role) return { error: `Agent "${agentName}" not found` };

  // ── session-id fallback chain ─────────────────────────────────────────────
  // (1) Primary: sessions map — REQ-001
  const sessionsMap = (exec.sessions as Record<string, string> | undefined) ?? {};
  const fromMap = sessionsMap[agentName];
  let sessionId: string | undefined;
  let resolvedVia: 'sessions_map' | 'trace' | 'input' | 'none' = 'none';

  if (typeof fromMap === 'string' && fromMap.trim()) {
    sessionId = fromMap;
    resolvedVia = 'sessions_map';
  }

  // (2) Trace fallback — REQ-002
  if (!sessionId) {
    const traceForSession = await db.collection('execution_traces').findOne(
      { executionId },
      { sort: { completedAt: -1, createdAt: -1 } },
    );
    const traceOutput = traceForSession?.output;
    if (traceOutput && typeof traceOutput === 'object') {
      const fromTrace = (traceOutput as Record<string, unknown>).session_id;
      if (typeof fromTrace === 'string' && fromTrace.trim()) {
        sessionId = fromTrace;
        resolvedVia = 'trace';
      }
    }
  }

  // (3) Input fallback — REQ-003
  if (!sessionId) {
    const execInput = (exec.input as Record<string, unknown> | undefined) ?? {};
    const fromInput = execInput.session_id;
    if (typeof fromInput === 'string' && fromInput.trim()) {
      sessionId = fromInput;
      resolvedVia = 'input';
    }
  }

  // (4) Backfill — REQ-004 (must complete BEFORE spawn — NFR-002)
  let backfilled = false;
  if (sessionId && (resolvedVia === 'trace' || resolvedVia === 'input')) {
    try {
      await db.collection('executions').updateOne(
        { id: executionId },
        { $set: { [`sessions.${agentName}`]: sessionId } },
      );
      backfilled = true;
    } catch (err) {
      logger.warn('resume.agent.backfill_failed', { executionId, agentName });
      // Continue — backfill is best-effort
    }
  }

  logger.info('resume.agent.session_resolved', { executionId, agentName });

  // Next attempt = max(existing attempts) + 1.
  const lastTrace = await db.collection('execution_traces')
    .find({ executionId })
    .sort({ attempt: -1 })
    .limit(1)
    .toArray();
  const nextAttempt = ((lastTrace[0]?.attempt as number | undefined) ?? 0) + 1;

  const meta = (exec.meta as Record<string, unknown> | undefined) ?? {};
  const repoPath = (meta.cwd as string | undefined)
    ?? ((exec.input as Record<string, unknown> | undefined)?.repo_path as string | undefined);

  // Re-open the execution for a new attempt.
  await db.collection('executions').updateOne(
    { id: executionId },
    {
      $set: {
        status: 'running',
        completedNodes: [],
        currentNodes: [agentName],
        errorMessage: null,
        completedAt: null,
      },
      $unset: { durationMs: '' },
    },
  );

  // Preserve the artifact root across resume so loop-back runs keep filing
  // under the same chat / workflow / agent parent. Pull from exec.meta —
  // chatSessionId is set when the agent was originally spawned from chat.
  const resumeChatSessionId = (meta.chatSessionId as string | undefined) || undefined;
  const resumeRootType = resumeChatSessionId
    ? 'chat'
    : (exec.parentExecutionId ? 'workflow' : 'agent');
  const resumeRootId = resumeChatSessionId
    ?? (exec.rootExecutionId as string | undefined)
    ?? executionId;

  __internalsForTest.runSpawnInBackground(
    db,
    role as Record<string, unknown>,
    agentName,
    prompt,
    executionId,
    sessionId,
    repoPath,
    {
      parentExecutionId: (exec.parentExecutionId as string | undefined) ?? null,
      parentCaller: (exec.parentCaller as string | undefined) ?? null,
      rootExecutionId: (exec.rootExecutionId as string | undefined) ?? executionId,
      spawnDepth: (exec.spawnDepth as number | undefined) ?? 0,
      artifactRootType: resumeRootType,
      artifactRootId: resumeRootId,
      repoKnowledgePacketId: ((meta.repoKnowledgeParent as Record<string, unknown> | undefined)?.packetId as string | undefined) ?? null,
      repoKnowledgeRepoId: ((meta.repoKnowledgeParent as Record<string, unknown> | undefined)?.repoId as string | undefined) ?? null,
      repoKnowledgeIndexId: ((meta.repoKnowledgeParent as Record<string, unknown> | undefined)?.indexId as string | undefined) ?? null,
      repoKnowledgeRepoName: ((meta.repoKnowledgeParent as Record<string, unknown> | undefined)?.repoName as string | undefined) ?? null,
      repoKnowledgeFreshness: ((meta.repoKnowledgeParent as Record<string, unknown> | undefined)?.freshness as string | undefined) ?? null,
    },
    nextAttempt,
  ).catch(() => { /* errors already logged + persisted */ });

  return { execution_id: executionId, attempt: nextAttempt };
}

const getLearnings: ChatTool = {
  name: 'search_learnings',
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
  description: 'Run a read-only query against the Allen MongoDB database. Can query collections: workflows, executions, agents, repos, learnings, chat_sessions, and context-engine collections. Returns up to 20 results.',
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
    const allowedCollections = ['workflows', 'executions', 'agents', 'repos', 'learnings', 'chat_sessions', 'execution_logs', 'node_traces', 'repo_context_curation_profiles', 'repo_context_curation_entries', 'repo_mandatory_context_mappings', 'context_attempts', 'context_refs', 'context_ref_events', 'context_evaluations', 'context_artifacts'];
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
  name: 'search_executions',
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
  name: 'wait_for_execution_logs',
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
  description: 'Get Allen dashboard statistics: total workflows, executions, success rate, cost totals, active agents, registered repos.',
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
  description: 'Submit human input/intervention response to a paused workflow. Call this after wait_for_execution shows status "waiting_for_input" OR get_pending_interventions returns a pending item. Two modes: (1) direct — pass execution_id + node + data (field values). (2) intervention — pass intervention_id + decision (approve|request_changes|reject|answer) + field_values + optional feedback/scope. The intervention mode goes through the same backend path as the Interventions page button, so it triggers retryFromNode for request_changes, etc.',
  inputSchema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'The execution ID that is waiting for input. Required for direct mode.' },
      node: { type: 'string', description: 'The node name that is waiting. Required for direct mode.' },
      data: { type: 'object', description: 'Field values keyed by field name. For direct mode: required. For intervention mode: optional — prefer field_values.', additionalProperties: true },
      intervention_id: { type: 'string', description: 'Use this when responding to an intervention from get_pending_interventions. Takes precedence over execution_id + node.' },
      decision: { type: 'string', enum: ['approve', 'request_changes', 'reject', 'answer'], description: 'Decision for intervention mode. approval/escalation severity uses approve|request_changes|reject; question severity uses answer|reject.' },
      field_values: { type: 'object', description: 'Field values keyed by field name, for intervention mode.', additionalProperties: true },
      feedback: { type: 'string', description: 'Free-form feedback. Required when decision is request_changes — passed verbatim as retry guidance.' },
      scope: { type: 'string', description: 'Scope for plan approval gates (requirements | architecture | technical_design | all). Only used when decision is request_changes on plan_approval_gate stage.' },
    },
  },
  async execute(args, db) {
    const executionService = new ExecutionService(db);
    const interventionService = new InterventionService(db);

    // ── Intervention mode ──
    const interventionId = args.intervention_id as string | undefined;
    if (interventionId) {
      const intervention = await interventionService.get(interventionId);
      if (!intervention) return { error: `Intervention "${interventionId}" not found.` };
      if (intervention.status !== 'pending') {
        return { error: `Intervention is already ${intervention.status}.` };
      }
      const decision = args.decision as 'approve' | 'request_changes' | 'reject' | 'answer' | undefined;
      if (!decision) return { error: 'decision is required in intervention mode (approve | request_changes | reject | answer).' };

      const fieldValues = (args.field_values as Record<string, unknown>) ?? (args.data as Record<string, unknown>) ?? {};
      const feedback = args.feedback as string | undefined;
      const scope = args.scope as string | undefined;

      if (decision === 'request_changes' && !feedback) {
        return { error: 'feedback is required when decision is "request_changes".' };
      }

      // Dispatch by decision — mirrors the POST /api/interventions/:id/respond handler
      if (decision === 'approve' || decision === 'answer') {
        const nodeName = intervention.stage;
        if (Object.keys(fieldValues).length === 0) {
          return { error: 'field_values is required for HITL responses.' };
        }
        const payload = {
          human_input: buildHumanResumeInput(toHumanInterventionPayload(intervention), {
            ...fieldValues,
            __human_meta: { actionId: decision, decision, feedback },
          }),
        };
        try {
          await executionService.submitInput(intervention.workflow_run_id, nodeName, payload);
        } catch (err) {
          return { error: `submitInput failed: ${(err as Error).message}` };
        }
        await db.collection('executions').updateOne(
          { id: intervention.workflow_run_id },
          { $set: { status: 'running' } },
        );
      } else if (decision === 'request_changes') {
        const nodeName = intervention.stage;
        const originalFields = (intervention as unknown as { fields?: Array<{ name: string }> }).fields ?? [];
        if (Object.keys(fieldValues).length === 0) {
          return { error: 'field_values is required for HITL responses.' };
        }
        const values: Record<string, unknown> = { ...fieldValues };
        const isEscalation = intervention.severity === 'escalation'
          || String(intervention.stage ?? '').toLowerCase().includes('escalation');
        const hasDecisionField = originalFields.some(f => f.name === 'approval_decision' || f.name === 'decision' || f.name === 'escalation_decision');
        if (hasDecisionField) {
          if (originalFields.some(f => f.name === 'approval_decision') && values.approval_decision == null) {
            values.approval_decision = 'request_changes';
          }
          if (originalFields.some(f => f.name === 'decision') && values.decision == null) {
            values.decision = isEscalation ? 'retry_with_feedback' : 'request_changes';
          }
          if (originalFields.some(f => f.name === 'escalation_decision') && values.escalation_decision == null) {
            values.escalation_decision = 'retry_with_feedback';
          }
          if (originalFields.some(f => f.name === 'approval_feedback') && values.approval_feedback == null) {
            values.approval_feedback = feedback ?? '';
          }
          if (originalFields.some(f => f.name === 'feedback') && values.feedback == null) {
            values.feedback = feedback ?? '';
          }
          if (originalFields.some(f => f.name === 'escalation_feedback') && values.escalation_feedback == null) {
            values.escalation_feedback = feedback ?? '';
          }
          const humanDecision = String(values.approval_decision ?? values.decision ?? values.escalation_decision ?? decision);
          const payload = {
            human_input: buildHumanResumeInput(toHumanInterventionPayload(intervention), {
              ...values,
              __human_meta: {
                actionId: humanDecision,
                decision: humanDecision,
                feedback: feedback ?? String(values.feedback ?? values.approval_feedback ?? values.escalation_feedback ?? ''),
              },
            }),
          };
          const delivered = await executionService.submitInput(intervention.workflow_run_id, nodeName, payload);
          if (delivered) {
            await db.collection('executions').updateOne(
              { id: intervention.workflow_run_id },
              { $set: { status: 'running' } },
            );
          } else {
            const targetNode = retryTargetForStage(intervention.stage, scope);
            await db.collection('executions').updateOne(
              { id: intervention.workflow_run_id },
              {
	                $set: {
	                  'state.__retry_target': [targetNode],
	                  'state.__retry_source': 'human_feedback',
	                  'state.__retry_attempt': 1,
	                  'state.human_input': buildHumanResumeInput(toHumanInterventionPayload(intervention), {
	                    ...values,
	                    __human_meta: {
                        actionId: humanDecision,
                        decision: humanDecision,
                        feedback: feedback ?? String(values.feedback ?? values.approval_feedback ?? values.escalation_feedback ?? ''),
                      },
	                  }),
	                },
              },
            );
            await executionService.retryFromNode(intervention.workflow_run_id, targetNode);
          }
        } else {
        const targetNode = retryTargetForStage(intervention.stage, scope);
	        await db.collection('executions').updateOne(
	          { id: intervention.workflow_run_id },
	          {
	            $set: {
	              'state.__retry_target': [targetNode],
	              'state.__retry_source': 'human_feedback',
	              'state.__retry_attempt': 1,
	              'state.human_input': buildHumanResumeInput(toHumanInterventionPayload(intervention), {
	                ...values,
	                __human_meta: {
                    actionId: String(values.approval_decision ?? values.decision ?? values.escalation_decision ?? decision),
                    decision: String(values.approval_decision ?? values.decision ?? values.escalation_decision ?? decision),
                    feedback: feedback ?? String(values.feedback ?? values.approval_feedback ?? values.escalation_feedback ?? ''),
                  },
	              }),
	            },
          },
        );
        try {
          await executionService.retryFromNode(intervention.workflow_run_id, targetNode);
        } catch (err) {
          return { error: `retryFromNode failed: ${(err as Error).message}` };
        }
        }
      } else if (decision === 'reject') {
        const nodeName = intervention.stage;
        const originalFields = (intervention as unknown as { fields?: Array<{ name: string }> }).fields ?? [];
        const values: Record<string, unknown> = { ...fieldValues };
        const actionValue = String(values.approval_decision ?? values.decision ?? values.escalation_decision ?? 'reject');
        if (originalFields.some(f => f.name === 'approval_decision') && values.approval_decision == null) {
          values.approval_decision = actionValue;
        }
        if (originalFields.some(f => f.name === 'decision') && values.decision == null) {
          values.decision = actionValue;
        }
        if (originalFields.some(f => f.name === 'escalation_decision') && values.escalation_decision == null) {
          values.escalation_decision = actionValue;
        }
        if (feedback != null) {
          if (originalFields.some(f => f.name === 'approval_feedback') && values.approval_feedback == null) {
            values.approval_feedback = feedback;
          } else if (originalFields.some(f => f.name === 'feedback') && values.feedback == null) {
            values.feedback = feedback;
          } else if (originalFields.some(f => f.name === 'escalation_feedback') && values.escalation_feedback == null) {
            values.escalation_feedback = feedback;
          } else {
            values.feedback = feedback;
          }
        }
        let delivered = false;
        if (originalFields.length > 0) {
          const payload = {
            human_input: buildHumanResumeInput(toHumanInterventionPayload(intervention), {
              ...values,
              __human_meta: { actionId: actionValue, decision: actionValue, feedback },
            }),
          };
          delivered = await executionService.submitInput(intervention.workflow_run_id, nodeName, payload);
        }
        await db.collection('executions').updateOne(
          { id: intervention.workflow_run_id },
          { $set: { status: delivered ? 'running' : 'cancelled' } },
        );
      }

      await interventionService.recordResponse(interventionId, {
        decision,
        feedback,
        scope: scope as 'requirements' | 'architecture' | 'technical_design' | 'all' | undefined,
        answered_by_user_id: 'chat',
      });
      if (isContextEngineEnabled()) {
        new ContextEvaluationService(db).reevaluateExecution(intervention.workflow_run_id).catch((err) => {
          logger.warn('[chat-tools] context evaluation refresh after intervention failed', { executionId: intervention.workflow_run_id, error: (err as Error).message });
        });
      }

      return {
        message: `Intervention ${interventionId} resolved with "${decision}".`,
        intervention_id: interventionId,
        execution_id: intervention.workflow_run_id,
        decision,
      };
    }

    // ── Direct mode ──
    const execId = args.execution_id as string;
    const node = args.node as string;
    const data = (args.data as Record<string, unknown>) ?? (args.field_values as Record<string, unknown>) ?? {};
    if (!execId || !node) {
      return { error: 'execution_id and node are required in direct mode (or use intervention_id).' };
    }

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

/**
 * Mirrors retryTargetForStage in intervention.routes.ts. Kept in sync by
 * hand — a mis-mapped retry target is obvious (wrong node re-runs), so a
 * duplicate is cheaper than the coupling of sharing it across files.
 */
function retryTargetForStage(stage: string, scope?: string): string {
  if (stage === 'plan_approval_gate') {
    switch (scope) {
      case 'requirements':     return 'produce_prd';
      case 'architecture':     return 'produce_hla';
      case 'technical_design': return 'produce_tdd';
      default:                 return 'produce_prd';
    }
  }
  const map: Record<string, string> = {
    clarify_round_1: 'clarify',
    clarify_round_2: 'clarify',
    clarify_round_3: 'clarify',
    audit_prd_escalation: 'produce_prd',
    audit_hla_escalation: 'produce_hla',
    audit_tdd_escalation: 'produce_tdd',
    qa_escalation: 'qa_failure_triage',
    validator_escalation: 'plan_implementation',
    implementation_approval_human: 'investigate',
    feature_escalation: 'investigate',
    repro_question: 'investigate',
  };
  return map[stage] ?? stage;
}

const getPendingInterventions: ChatTool = {
  name: 'get_pending_interventions',
  description: 'List interventions that are waiting for a human response. Returns the question, required fields, reviewable content (PRD/JSON/code), and intervention_id. Call this when the user asks "what is waiting?" or "why is the workflow paused?" Pair with submit_execution_input (intervention mode) to respond.',
  inputSchema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'Filter to a specific execution. Optional — omit to see all pending interventions.' },
      intervention_id: { type: 'string', description: 'Fetch a single intervention by id (returns full detail).' },
      limit: { type: 'number', description: 'Max items (default 20).' },
    },
  },
  async execute(args, db) {
    const service = new InterventionService(db);

    if (args.intervention_id) {
      const doc = await service.get(args.intervention_id as string);
      if (!doc) return { error: 'Intervention not found.' };
      return { intervention: summarizeIntervention(doc as unknown as Record<string, unknown>, { full: true }) };
    }

    const limit = (args.limit as number) ?? 20;
    const docs = args.execution_id
      ? (await service.listForWorkflowRun(args.execution_id as string)).filter(d => d.status === 'pending')
      : await service.list({ status: 'pending', limit });

    return {
      count: docs.length,
      interventions: docs.slice(0, limit).map(d => summarizeIntervention(d as unknown as Record<string, unknown>, { full: false })),
    };
  },
};

function summarizeIntervention(
  doc: Record<string, unknown>,
  opts: { full: boolean },
): Record<string, unknown> {
  const d = doc as Record<string, unknown>;
  const base: Record<string, unknown> = {
    intervention_id: d.intervention_id,
    execution_id: d.workflow_run_id,
    workflow_name: d.workflow_name,
    severity: d.severity,
    stage: d.stage,
    title: d.title,
    question: d.question,
    context_summary: d.context_summary,
    status: d.status,
    created_at: d.created_at,
    round_info: d.round_info,
  };
  if (opts.full) {
    base.fields = d.fields;
    base.review_content = d.review_content;
    base.review_content_type = d.review_content_type ?? 'markdown';
    base.docs = d.docs;
    base.user_request = d.user_request;
    base.options = d.options;
  } else {
    const fields = Array.isArray(d.fields) ? (d.fields as Array<{ name: string; type?: string; label?: string; required?: boolean }>) : [];
    base.field_summary = fields.map(f => ({
      name: f.name,
      type: f.type ?? 'text',
      label: f.label ?? f.name,
      required: f.required !== false,
    }));
    base.has_review_content = !!d.review_content;
  }
  return base;
}

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
  async execute(args, db, context) {
    const content = args.content as string;
    const type = args.type as string;
    const activeCtx = resolveActiveSession(context);
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
  description: `Delegate a task to another team agent. Returns immediately with a conversation_id. Then call wait_for_delegation(conversation_id) which BLOCKS until the agent finishes — no polling loop needed.

WORKFLOW:
1. delegate_to_agent(agent_name="engineer", task="Analyze feasibility") → { conversation_id: "abc" }
2. wait_for_delegation(conversation_id="abc") → WAITS → { status: "completed", response: "..." }
3. Optional follow-up: delegate_to_agent(agent_name="engineer", task="What about CSS?", conversation_id="abc")
4. wait_for_delegation(conversation_id="abc") → WAITS → { status: "completed", response: "..." }

CRITICAL RULES:
- ALWAYS call wait_for_delegation after delegate_to_agent.
- If wait_for_delegation returns status="waiting", call it again immediately. Keep calling until "completed" or "failed".
- NEVER respond to the user before ALL delegations are complete.
- NEVER give up — the agent WILL finish. Just keep calling wait_for_delegation.
- After getting "completed", you MAY send follow-ups via delegate_to_agent(conversation_id=...) then wait_for_delegation again.
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
  async execute(args, db, toolContext) {
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

    const activeCtx = resolveActiveSession(toolContext);
    const chatSessionId = activeCtx?.chatSessionId ?? toolContext?.chatSessionId;
    if (!chatSessionId) {
      return { error: 'Missing chat session context. Delegation must be started from a chat session.' };
    }
    const parentMessageId = activeCtx?.parentMessageId ?? 'unknown';
    const fromAgent = activeCtx?.currentAgent ?? 'assistant';
    const currentDepth = (activeCtx?.delegationDepth ?? 0) + 1;
    const onEvent = activeCtx?.broadcastEvent;

    if (!chatSessionId || !parentMessageId) {
      return {
        error: 'delegate_to_agent requires an active chat context with a parent message id. Refusing to create or reuse an unscoped delegation thread.',
      };
    }

    // Resolve cwd: explicit context > session cwd > workspace linked to
    // session > target agent's sourceRepoPath. See spawn_agent for the full
    // rationale. This fallback makes imported Claude agents "just work"
    // without every caller having to look up their source repo.
    let delegationCwd = context.repo_path as string | undefined;
    if (!delegationCwd) {
      delegationCwd = activeCtx?.resolvedCwd ?? await resolveWorkspacePath(db, chatSessionId) ?? undefined;
    }
    if (!delegationCwd && typeof targetAgent.sourceRepoPath === 'string' && targetAgent.sourceRepoPath) {
      delegationCwd = targetAgent.sourceRepoPath;
      // Mirror into context so the receiving agent's prompt includes the
      // same repo_path it will actually run in.
      if (!context.repo_path) context.repo_path = delegationCwd;
    }

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

      // Flip the conversation back to `active` and anchor it to the current
      // assistant message before kicking off the background run. Without
      // this, wait_for_delegation sees the prior turn's `completed` status
      // and returns the stale response/summary/cost/duration immediately —
      // the caller thinks the continuation finished instantly with the
      // previous turn's output. parentMessageIds also lets the UI render
      // the thread card under every assistant message that touched it.
      await conversationService.markContinuation(existingConvId, parentMessageId);

      await conversationService.addMessage(existingConvId, { agent: fromAgent, type: 'message', content: task, timestamp: new Date() });
      if (onEvent) onEvent('thread_message', { conversationId: existingConvId, agent: fromAgent, type: 'message', content: task.slice(0, 200) });

      // Get the target agent's session for resume
      const targetSessionId = existing.sessions?.[targetName];

      // Run in background — return immediately
      runDelegationInBackground(db, targetAgent, task, existingConvId, targetSessionId, conversationService, onEvent, activeCtx, currentDepth, fromAgent, targetName, delegationCwd, chatSessionId).catch(() => {});

      return { conversation_id: existingConvId, status: 'started', turn: 'continue', message: `Message sent to ${targetName}. Use wait_for_delegation to check the response.` };
    }

    // ── New conversation ──
    if (!conversationService.canDelegate(currentDepth - 1)) {
      return { error: `Delegation depth limit reached (max ${conversationService.maxDepth}). Respond directly.` };
    }

    // Delegation is intentionally unrestricted: any agent can delegate to any
    // other agent regardless of canDelegateTo lists or team boundaries.
    // The team isolation and canDelegateTo checks were removed so that
    // orchestrators are never blocked by allowlist mismatches (ENG-1469).

    const conversation = await conversationService.create({ chatSessionId, parentMessageId, fromAgent, toAgent: targetName, task, context, depth: currentDepth, parentConversationId: activeCtx?.currentConversationId });
    const convId = conversation._id!.toString();

    if (onEvent) onEvent('thread_created', { conversationId: convId, fromAgent, toAgent: targetName, task: task.slice(0, 200), depth: currentDepth, parentConversationId: activeCtx?.currentConversationId });
    await conversationService.addMessage(convId, { agent: fromAgent, type: 'message', content: task, timestamp: new Date() });

    // Auto-inject workspace context
    if (!context.repo_path) {
      const wsPath = await resolveWorkspacePath(db, chatSessionId);
      if (wsPath) {
        context.repo_path = wsPath;
        try {
          const ws = await db.collection('workspaces').findOne({ worktreePath: wsPath, status: { $nin: ['archived', 'failed'] } });
          if (ws?.branch) context.workspace_branch = ws.branch as string;
        } catch {}
      }
    }

    let fullPrompt = task;
    if (Object.keys(context).length > 0) fullPrompt = `CONTEXT:\n${JSON.stringify(context, null, 2)}\n\nTASK:\n${task}`;

    // Run in background — return immediately so MCP doesn't timeout
    runDelegationInBackground(db, targetAgent, fullPrompt, convId, undefined, conversationService, onEvent, activeCtx, currentDepth, fromAgent, targetName, delegationCwd, chatSessionId).catch(() => {});

    return { conversation_id: convId, status: 'started', agent: targetName, depth: currentDepth, message: `Delegation started. Use wait_for_delegation(conversation_id="${convId}") to get the response.` };
  },
};

/** Run delegation in background — decoupled from MCP tool call timeout */
async function runDelegationInBackground(
  db: Db, targetAgent: Record<string, unknown>, prompt: string, convId: string,
  resumeSessionId: string | undefined, conversationService: AgentConversationService,
  onEvent: ((event: string, data: Record<string, unknown>) => void) | undefined,
  activeCtx: ActiveSessionContext | undefined, currentDepth: number,
  fromAgent: string, targetName: string, cwd?: string, chatSessionId?: string,
): Promise<void> {
  if (activeCtx) activeCtx.pendingBackgroundTasks++;
  const startMs = Date.now();
  try {
    const result = await runAgentTurn(db, targetAgent, prompt, convId, resumeSessionId, conversationService, onEvent, activeCtx, currentDepth, cwd, chatSessionId);
    logger.info('[delegation] completed', { convId, targetName, responseLen: result.responseText.length, toolCalls: result.toolCalls.length });
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
    new MonitoringService(db).handleEvent({
      sourceType: 'delegation',
      sourceId: convId,
      title: `Delegation failed: ${fromAgent} -> ${targetName}`,
      error: errorMsg,
      rootCauseArea: 'agent_prompt',
      severity: 'high',
      confidence: 0.80,
      failureMode: 'delegation_failed',
      relatedIds: {
        conversationId: convId,
        chatSessionId,
        fromAgent,
        toAgent: targetName,
      },
    }).catch(() => {});
    if (onEvent) onEvent('thread_completed', { conversationId: convId, fromAgent, toAgent: targetName, summary: `Failed: ${errorMsg}`, costUsd: 0, durationMs, error: true });
  } finally {
    if (activeCtx) activeCtx.pendingBackgroundTasks--;
  }
}

/** Wait for delegation result — handles active, waiting_for_answer, completed, failed */
const getDelegationResult: ChatTool = {
  name: 'wait_for_delegation',
  description: `Wait for a delegation to complete. Blocks up to 90 seconds per call.

Possible return statuses:
- "waiting" → agent still working. Call wait_for_delegation again.
- "question" → agent is asking YOU a question. Read the question, then call answer_delegator(conversation_id, answer).
  After answering, call wait_for_delegation again to wait for the agent to finish.
- "completed" → agent finished. Response is in the result.
- "failed" → agent errored.

RULES:
- If "waiting": call wait_for_delegation again immediately. NEVER give up.
- If "question": answer it via answer_delegator, then call wait_for_delegation again.
- If you can't answer the question yourself, use ask_delegator to escalate to YOUR caller.
- NEVER respond to the user before status is "completed" or "failed".

Also returns recent_activity and activity_summary (human-readable progress lines since the activity_since cursor) so you can describe what the delegated agent is doing rather than polling silently — pass the returned activity_cursor back on the next call to stream forward.`,
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'Conversation ID from delegate_to_agent' },
      activity_since: { type: 'string', description: 'ISO timestamp cursor. Pass activity_cursor from the previous wait_for_delegation response to fetch only newer events.' },
    },
    required: ['conversation_id'],
  },
  async execute(args, db) {
    const convId = args.conversation_id as string;
    const activitySince = typeof args.activity_since === 'string' ? new Date(args.activity_since) : undefined;
    const conversationService = new AgentConversationService(db);
    const { AgentActivityService } = await import('./agent-activity.service.js');
    const activityService = new AgentActivityService(db);
    const readActivity = async () => {
      const rows = await activityService.recent(convId, { since: activitySince, limit: 10 });
      const activitySummary = rows
        .map((row) => formatActivityForCaller(row as unknown as Record<string, unknown>))
        .filter((line): line is string => Boolean(line))
        .slice(-8);
      const activityCursor = rows.length > 0 ? rows[rows.length - 1].at : activitySince?.toISOString();
      return {
        recent_activity: rows,
        activity_summary: activitySummary,
        progress_message: activitySummary.length > 0 ? activitySummary[activitySummary.length - 1] : undefined,
        activity_cursor: activityCursor,
      };
    };

    let waitMs = 5000;
    const maxWaitMs = 30000;
    const maxTotalMs = 90_000; // 90s per call (MCP safe)
    const startMs = Date.now();

    while (Date.now() - startMs < maxTotalMs) {
      const conv = await conversationService.get(convId);
      if (!conv) return { error: `Conversation "${convId}" not found.` };

      // Agent asked a question — return immediately so caller can answer
      if (conv.status === 'waiting_for_answer' && conv.pendingQuestion?.status === 'pending') {
        const qActivity = await readActivity();
        return {
          conversation_id: convId,
          status: 'question',
          question: conv.pendingQuestion.question,
          from_agent: conv.pendingQuestion.fromAgent,
          message: `${conv.toAgent} is asking: "${conv.pendingQuestion.question}". Answer via answer_delegator(conversation_id, answer).`,
          ...qActivity,
        };
      }

      // Completed or failed — return result
      if (conv.status === 'completed' || conv.status === 'failed') {
        const finalActivity = await readActivity();
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
          ...finalActivity,
        };
      }

      // Still active — wait
      await new Promise(r => setTimeout(r, waitMs));
      waitMs = Math.min(waitMs * 1.3, maxWaitMs);
    }

    // Timed out — include activity so the caller can narrate progress
    // rather than silently re-polling.
    const waitingActivity = await readActivity();
    return { conversation_id: convId, status: 'waiting', message: 'Agent is still working. Call wait_for_delegation again.', ...waitingActivity };
  },
};

/** Answer a question from a delegated agent */
const answerQuestion: ChatTool = {
  name: 'answer_delegator',
  description: 'Answer a question from an agent you delegated to. Use when wait_for_delegation returns status="question". After answering, call wait_for_delegation again to wait for the agent to continue.',
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'Conversation ID' },
      answer: { type: 'string', description: 'Your answer to the agent\'s question' },
    },
    required: ['conversation_id', 'answer'],
  },
  async execute(args, db, context) {
    const convId = args.conversation_id as string;
    const answer = args.answer as string;
    const conversationService = new AgentConversationService(db);
    const activeCtx = resolveActiveSession(context);
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
  name: 'ask_delegator',
  description: 'Ask a question to the agent who delegated this task to you. Use when you need clarification, context, or a decision before you can proceed. Your execution pauses until they answer. Do NOT guess — ask.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Your question for the caller' },
    },
    required: ['question'],
  },
  async execute(args, db, context) {
    const question = args.question as string;
    const activeCtx = resolveActiveSession(context);
    const currentAgent = activeCtx?.currentAgent ?? 'unknown';
    // Accept conversation_id from API route (when called via MCP → HTTP) or from active context
    const convId = (args._conversation_id as string) ?? activeCtx?.currentConversationId;

    if (!convId) return { error: 'No active conversation context. ask_delegator can only be used by a delegated agent.' };

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
  async execute(args, db, context) {
    const question = args.question as string;
    const activeCtx = resolveActiveSession(context);
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
  cwd?: string,
  chatSessionId?: string,
): Promise<{ responseText: string; costUsd: number; sessionId?: string; toolCalls: { tool: string; args: Record<string, unknown> }[] }> {
  const targetName = targetAgent.name as string;
  const provider = targetAgent.provider ?? 'claude';
  const model = normalizeModelAlias((targetAgent.model as string | undefined) ?? 'sonnet') ?? 'sonnet';
  // Capture fromAgent BEFORE mutating activeCtx (fixes stale context bug)
  const fromAgent = activeCtx?.currentAgent ?? 'assistant';

  let responseText = '';
  let costUsd = 0;
  let sessionId: string | undefined = resumeSessionId;
  const toolCalls: { tool: string; args: Record<string, unknown>; result?: Record<string, unknown> }[] = [];
  const activeMcpCalls = new Map<string, { tool: string; startMs: number }>();
  const MAX_RETRIES = 3;

  // Persist delegation activity to agent_activity for refresh replay and
  // for the main agent's wait_for_delegation `recent_activity` cursor.
  // Same pattern as runSpawnInBackground's persistSpawnActivity — a
  // fire-and-forget write that cannot stall the thread stream.
  const activityService = new AgentActivityService(db);

  /** Emit a thread event to the UI */
  // Text events in runAgentTurn carry `text.slice(-300)` — the tail of
  // the cumulative response. Consecutive emits often repeat content (the
  // tail window barely moves between stream chunks), so de-dupe here to
  // stop the activity log filling with near-identical rows.
  let lastPersistedText: string | undefined;
  function emit(type: string, data: Record<string, unknown>) {
    if (onEvent) onEvent('thread_message', { conversationId: convId, agent: targetName, ...data, type });
    // runAgentTurn emits these types verbatim — keep this list in sync
    // with the emit() call sites below. Anything else (status, warn,
    // follow_up, response) is UI-only and does not need persisting.
    const allowed: ReadonlyArray<'text' | 'thinking' | 'tool_call' | 'tool_result'> =
      ['text', 'thinking', 'tool_call', 'tool_result'];
    if (!allowed.includes(type as (typeof allowed)[number])) {
      logger.debug('[delegation:emit] skip (not persisted)', { type, conv: convId.slice(0, 8) });
      return;
    }
    const activityType = type as 'text' | 'thinking' | 'tool_call' | 'tool_result';

    const content = typeof data.content === 'string' ? (data.content as string) : undefined;
    if (activityType === 'text') {
      if (!content || content === lastPersistedText) {
        logger.debug('[delegation:emit] skip text (dedupe)', { conv: convId.slice(0, 8) });
        return;
      }
      lastPersistedText = content;
    }

    logger.debug('[delegation:emit] persist', { activityType, tool: data.tool ?? '-', conv: convId.slice(0, 8), contentLen: content?.length ?? 0 });
    void activityService.record({
      scope: 'delegation',
      refId: convId,
      chatSessionId,
      agent: targetName,
      type: activityType,
      tool: typeof data.tool === 'string' ? (data.tool as string) : undefined,
      content,
      toolUseId: typeof data.toolUseId === 'string' ? (data.toolUseId as string) : undefined,
      durationMs: typeof data.durationMs === 'number' ? (data.durationMs as number) : undefined,
    });
  }

  // Save/restore context for nested delegation
  const prevCtx = activeCtx ? { ...activeCtx } : undefined;
  if (activeCtx) { activeCtx.currentAgent = targetName; activeCtx.delegationDepth = currentDepth; activeCtx.currentConversationId = convId; }

  const contextEngineEnabled = isContextEngineEnabled();
  const baseSystemPrompt = buildDelegationPrompt(targetAgent, fromAgent, currentDepth, conversationService.maxDepth, cwd);
  let systemPrompt = resumeSessionId ? undefined : (contextEngineEnabled ? withRepoContextLoadingGuidance(baseSystemPrompt) : baseSystemPrompt);

  // Inject the deep repo context block (skip for the scanner itself).
  // buildDelegationPrompt already appended the WORKSPACE CONSTRAINT section at the
  // tail when cwd is set, so we splice the repo context in right before it to
  // preserve ordering: base → repoContext → workspaceConstraint.
  if (contextEngineEnabled && systemPrompt && cwd && targetName !== 'repo-scanner' && isEphemeralCwd(cwd)) {
    try {
      const repoContextBlock = await buildRepoContextBlock(db, cwd);
      if (repoContextBlock) {
        const wcMarker = '\nWORKSPACE CONSTRAINT:';
        const wcIdx = systemPrompt.indexOf(wcMarker);
        if (wcIdx !== -1) {
          systemPrompt = systemPrompt.slice(0, wcIdx) + repoContextBlock + systemPrompt.slice(wcIdx);
        } else {
          systemPrompt += repoContextBlock;
        }
      }
    } catch (err) {
      logger.error('[delegation] failed to build repo context block', { targetName, convId, error: (err as Error).message });
    }
  }

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
    // Artifacts guidance for the delegated agent — same block spawned agents get.
    systemPrompt += ARTIFACTS_GUIDANCE;
  }

  // Retry loop — if CLI times out, resume the same session and continue
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // This is a retry — resume the session with "continue" prompt.
      logger.info('[delegation] Auto-retry', { targetName, convId, attempt, session: sessionId?.slice(0, 12) });
      emit('text', { content: `Reconnecting to ${targetName} (retry ${attempt}/${MAX_RETRIES})...` });
      prompt = 'Continue from where you left off. Complete your task and provide the final response.';
    }

  try {
    if (provider === 'codex') {
      // ── Codex CLI with MCP ──
      // Note: no per-call syncMcpToCodex — sync runs once on boot to avoid
      // races between parallel agent spawns rewriting Codex's config.
      const { spawn } = await import('node:child_process');

      // Per-call MCP env overrides — codex stores the Allen MCP entry
      // with only registration-time env vars and does NOT forward its
      // own runtime env to MCP children. Without these `-c` overrides
      // the delegated agent's allen_save_artifact would fail with
      // "ALLEN_ARTIFACT_ROOT_TYPE / ROOT_ID env vars not set" — same
      // mechanism as the codex chat provider in chat-providers.ts.
      const mcpEnvOverrides: string[] = [];
      if (chatSessionId) {
        mcpEnvOverrides.push(
          '-c', `mcp_servers.${MCP_SERVER_NAME}.env.ALLEN_ARTIFACT_ROOT_TYPE="chat"`,
          '-c', `mcp_servers.${MCP_SERVER_NAME}.env.ALLEN_ARTIFACT_ROOT_ID="${chatSessionId}"`,
          '-c', `mcp_servers.${MCP_SERVER_NAME}.env.ALLEN_ARTIFACT_AGENT_NAME="${targetName}"`,
          '-c', `mcp_servers.${MCP_SERVER_NAME}.env.ALLEN_ARTIFACT_PARENT_ID="${convId}"`,
          '-c', `mcp_servers.${MCP_SERVER_NAME}.env.ALLEN_CHAT_SESSION_ID="${chatSessionId}"`,
          '-c', `mcp_servers.${MCP_SERVER_NAME}.env.ALLEN_API_URL="${getRuntimeApiBaseUrl()}"`,
          '-c', `mcp_servers.${MCP_SERVER_NAME}.env.JWT_ACCESS_SECRET="${getRuntimeJwtAccessSecret()}"`,
          '-c', `mcp_servers.${MCP_SERVER_NAME}.env.ALLEN_PUBLIC_URL="${getRuntimePublicBaseUrl()}"`,
        );
      }

      const args: string[] = ['exec'];
      if (resumeSessionId) {
        args.push('resume', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
        if (mcpEnvOverrides.length > 0) args.push(...mcpEnvOverrides);
        args.push('--', resumeSessionId, prompt);
      } else {
        args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
        if (model) args.push('-c', `model="${model}"`);
        if (mcpEnvOverrides.length > 0) args.push(...mcpEnvOverrides);
        args.push(`${systemPrompt}\n\n${prompt}`);
      }

      const result = await new Promise<{ text: string; threadId?: string; costUsd: number }>((resolveP, rejectP) => {
        // Artifact-root env for the delegated agent's Allen MCP subprocess.
        // Without these, `allen_save_artifact` inside the delegated agent
        // fails with "ALLEN_ARTIFACT_ROOT_TYPE / ROOT_ID env vars not set".
        // Rooting at the chat session (not the delegation id) makes saved
        // files appear in this chat's Artifacts panel — same behaviour as
        // spawn_agent spawns.
        const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
        delete cleanEnv.PORT; // Don't leak host server port
        if (chatSessionId) {
          cleanEnv.ALLEN_ARTIFACT_ROOT_TYPE = 'chat';
          cleanEnv.ALLEN_ARTIFACT_ROOT_ID = chatSessionId;
          cleanEnv.ALLEN_ARTIFACT_AGENT_NAME = targetName;
          cleanEnv.ALLEN_ARTIFACT_PARENT_ID = convId;
          // Session marker so the delegated agent's MCP subprocess
          // forwards x-allen-chat-session-id on outbound chat-tool
          // calls. Without it, tools called by this delegated agent
          // cannot be attached to a chat session.
          cleanEnv.ALLEN_CHAT_SESSION_ID = chatSessionId;
        }
        const proc = spawn('codex', args, { cwd: resolveAgentCwd(cwd), env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        const spawnStartMs = Date.now();
        let text = '';
        let threadId: string | undefined = resumeSessionId;
        let buf = '';
        let stderrTail = '';
        let settled = false;
        let idleTimer: NodeJS.Timeout | undefined;
        let totalTimer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;

        const clearTimers = () => {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
          if (totalTimer) { clearTimeout(totalTimer); totalTimer = undefined; }
          if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
        };

        // Persist threadId to outer-scope sessionId as soon as it's observed
        // so the retry loop can resume even when this spawn is killed by a
        // watchdog. (See identical pattern in the chat-tools spawn path.)
        const settle = (action: () => void) => {
          if (settled) return;
          settled = true;
          clearTimers();
          if (threadId) sessionId = threadId;
          action();
        };

        const escalateKill = (reason: string) => {
          try { proc.kill('SIGTERM'); } catch {}
          if (killTimer) clearTimeout(killTimer);
          killTimer = setTimeout(() => {
            logger.error('[codex-delegation] sigkill', { convId, targetName, pid: proc.pid ?? '?', reason });
            try { proc.kill('SIGKILL'); } catch {}
          }, CODEX_KILL_GRACE_MS);
        };

        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            logger.error('[codex-delegation] timeout-idle', { convId, targetName, pid: proc.pid ?? '?', idleSec: CODEX_STREAM_IDLE_MS / 1000, thread: threadId?.slice(0, 12) ?? 'none' });
            escalateKill('idle');
            settle(() => rejectP(new Error(`codex stream idle for ${CODEX_STREAM_IDLE_MS / 1000}s (timeout)${stderrTail ? `; stderr tail: ${stderrTail.slice(-512)}` : ''}`)));
          }, CODEX_STREAM_IDLE_MS);
        };

        proc.on('error', (err) => {
          logger.error('[codex-delegation] spawn error', { convId, targetName, pid: proc.pid ?? '?', error: err.message });
          settle(() => rejectP(new Error(`Failed to spawn codex: ${err.message}. Is codex CLI installed?`)));
        });
        proc.stdin.end();
        // Register PID for cancel — use convId as key for delegations
        if (proc.pid) registerExecutionProcess(convId, proc.pid, () => { try { proc.kill('SIGTERM'); } catch {} });
        logger.info('[codex-delegation] start', { convId, targetName, pid: proc.pid ?? '?', resume: resumeSessionId ? resumeSessionId.slice(0, 12) : 'new' });

        totalTimer = setTimeout(() => {
          logger.error('[codex-delegation] timeout-total', { convId, targetName, pid: proc.pid ?? '?', totalSec: CODEX_TOTAL_TIMEOUT_MS / 1000, thread: threadId?.slice(0, 12) ?? 'none' });
          escalateKill('total-timeout');
          settle(() => rejectP(new Error(`codex exceeded ${CODEX_TOTAL_TIMEOUT_MS / 1000}s total timeout${stderrTail ? `; stderr tail: ${stderrTail.slice(-512)}` : ''}`)));
        }, CODEX_TOTAL_TIMEOUT_MS);
        resetIdleTimer();

        // Drain stderr so codex doesn't block on a full pipe buffer (default
        // 64 KiB on Linux); keep a bounded tail for diagnostics on failure.
        proc.stderr.on('data', (chunk: Buffer) => {
          stderrTail += chunk.toString();
          if (stderrTail.length > CODEX_STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-CODEX_STDERR_TAIL_BYTES);
        });

        proc.stdout.on('data', (chunk: Buffer) => {
          resetIdleTimer();
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'thread.started' && evt.thread_id) {
                threadId = evt.thread_id;
                // Persist to outer-scope sessionId so retry-on-timeout can
                // resume even when this spawn is killed by a watchdog.
                sessionId = evt.thread_id;
                logger.info('[codex-delegation] thread.started', { convId, targetName, pid: proc.pid ?? '?', thread: String(evt.thread_id).slice(0, 12) });
              }
              // Text output
              if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
                const t = evt.item.text ?? evt.item.content?.filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('') ?? '';
                if (t) { text = t; emit('text', { content: t.slice(-300) }); }
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
        proc.on('close', (code, signal) => {
          const durationMs = Date.now() - spawnStartMs;
          if (code != null && code !== 0) {
            logger.error('[codex-delegation] non-zero-exit', { convId, targetName, pid: proc.pid ?? '?', code, signal: signal ?? 'null', durationMs, textBytes: text.length });
            settle(() => rejectP(new Error(`codex exited code=${code} signal=${signal ?? 'null'}${stderrTail ? `; stderr tail: ${stderrTail.slice(-512)}` : ''}`)));
            return;
          }
          logger.info('[codex-delegation] close', { convId, targetName, pid: proc.pid ?? '?', code: code ?? 'null', signal: signal ?? 'null', durationMs, textBytes: text.length, thread: threadId?.slice(0, 12) ?? 'none' });
          settle(() => resolveP({ text, threadId, costUsd: 0 }));
        });
      });

      responseText = result.text;
      sessionId = result.threadId;
      costUsd = result.costUsd;

    } else {
      // ── Claude provider with MCP — full streaming ──
      const { query } = await import('@anthropic-ai/claude-code');

      const mcpServers: Record<string, unknown> = {};
      // Allen MCP — delegation-scoped. Same helper as chat-llm.ts so path
      // resolution stays in one place. Previously this branch hardcoded
      // `npx tsx <serverPath.ts>` against a path that only existed in dev
      // checkouts; in production (where the server ships as .js under
      // dist/) the subprocess silently failed to start and the delegated
      // agent saw "No such tool available" for every mcp__allen__* call.
      const allenConfig = getAllenMcpConfig(
        chatSessionId
          ? {
              ALLEN_ARTIFACT_ROOT_TYPE: 'chat',
              ALLEN_ARTIFACT_ROOT_ID: chatSessionId,
              ALLEN_ARTIFACT_AGENT_NAME: targetName,
              ALLEN_ARTIFACT_PARENT_ID: convId,
              // Session marker — see Codex delegation path above.
              ALLEN_CHAT_SESSION_ID: chatSessionId,
            }
          : undefined,
      );
      if (allenConfig) mcpServers[MCP_SERVER_NAME] = allenConfig;
      const { loadExternalMcpServers } = await import('./chat-mcp.js');
      const externalMcpServers = externalMcpServersForAgent(targetAgent as Record<string, unknown>);
      const disabledMcpTools = disabledMcpToolsForAgent(targetAgent as Record<string, unknown>);
      const disallowedMcpToolNames = Object.entries(disabledMcpTools).flatMap(([server, tools]) =>
        tools.map((tool) => tool.startsWith('mcp__') ? tool : `mcp__${server}__${tool}`),
      );
      Object.assign(mcpServers, await loadExternalMcpServers(db, externalMcpServers));

      const abortController = new AbortController();
      const sdkOptions: Record<string, unknown> = {
        model,
        permissionMode: 'bypassPermissions',
        cwd: resolveAgentCwd(cwd),
        mcpServers,
        abortController,
        ...(disallowedMcpToolNames.length > 0 ? { disallowedTools: disallowedMcpToolNames } : {}),
      };
      if (resumeSessionId) sdkOptions.resume = resumeSessionId;
      else if (process.env.ALLEN_SYSTEM_PROMPT_MODE === 'custom') sdkOptions.customSystemPrompt = systemPrompt;
      else sdkOptions.appendSystemPrompt = systemPrompt;
      registerExecutionProcess(convId, process.pid, () => abortController.abort());

      const useCliMode = resolveExecutionMode(sdkOptions.cwd as string | undefined) === 'cli';
      let messageStream: AsyncIterable<any>;
      if (useCliMode) {
        const { queryViaCli } = await import('@allen/engine');
        let discoveredMcpTools: string[] = [];
        try {
          const { loadMcpTools } = await import('./chat-mcp-client.js');
          discoveredMcpTools = (await loadMcpTools(db, { externalServerNames: externalMcpServers })).map(t => t.fullName);
        } catch (err) {
          logger.warn('[delegation] MCP tool discovery failed (allowlist will lack mcp__* entries)', { convId, targetName, error: (err as Error).message });
        }
        messageStream = queryViaCli({
          agent: {
            name: targetName,
            description: targetAgent.description as string | undefined,
            system: systemPrompt ?? String(targetAgent.system ?? ''),
            model,
            tools: Array.isArray(targetAgent.tools) ? targetAgent.tools as string[] : undefined,
            mcpToolNames: discoveredMcpTools,
            disabledMcpTools,
          },
          prompt,
          cwd: sdkOptions.cwd as string | undefined,
          model,
          resume: sdkOptions.resume as string | undefined,
          permissionMode: 'bypassPermissions',
          env: sdkOptions.env as NodeJS.ProcessEnv | undefined,
          mcpServers: sdkOptions.mcpServers as Record<string, unknown> | undefined,
          abortSignal: abortController.signal,
          stderr: (chunk) => emit('tool_call', { tool: 'claude-cli stderr', content: chunk.slice(0, 4000) }),
          onPid: (pid: number) => {
            db.collection('agent_conversations').updateOne(
              { _id: new ObjectId(convId) },
              { $set: { 'meta.pid': pid } },
            ).catch(() => {});
          },
        });
      } else {
        messageStream = query({ prompt, options: sdkOptions as any });
      }

      for await (const message of messageStream) {
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
      logger.info('[delegation] timed out, will retry', { convId, targetName, attempt: attempt + 1, session: sessionId.slice(0, 12) });
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
  cwd?: string,
): string {
  const systemBase = (targetAgent.system as string) ?? '';
  const personality = (targetAgent.personality as string) ?? '';
  const canDelegateTo = (targetAgent.canDelegateTo as string[]) ?? [];
  const canTrigger = (targetAgent.canTrigger as string[]) ?? [];

  const parts = [systemBase];

  if (personality) parts.push(`\nYour personality: ${personality}`);

  parts.push(`\nYou were delegated a task by ${fromAgent}. Respond with a clear, actionable answer.`);

  // ask_delegator — always available to delegated agents
  parts.push(`
ASKING QUESTIONS:
- If you need clarification, context, or a decision from ${fromAgent}, use ask_delegator(question).
- Your execution pauses until ${fromAgent} answers, then you continue with the answer.
- Do NOT guess when you're unsure — ASK.`);

  if (canDelegateTo.length > 0 && depth < maxDepth) {
    parts.push(`\nYou can delegate sub-tasks to: ${canDelegateTo.join(', ')} using delegate_to_agent.
When wait_for_delegation returns "question", answer it via answer_delegator, then call wait_for_delegation again.`);
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
Pick the right agent for each sub-task. Call spawn_agent(agent_name, prompt_with_repo_path), then wait_for_execution to wait.
NEVER fabricate analysis. Every technical claim must come from an agent's actual response.`);
  }

  parts.push(`\nBe concise. You are collaborating with another agent. Use structured output with headers and bullets.`);

  if (cwd && cwd !== '/tmp/allen') {
    parts.push(`
WORKSPACE CONSTRAINT:
Your working directory is: ${cwd}
CRITICAL: ALL file operations (Read, Write, Edit, Grep, Glob, Bash) MUST use paths within this directory.
- Use relative paths (e.g., "src/app.ts") or absolute paths starting with "${cwd}/"
- NEVER read, write, or modify files outside this directory
- If you see paths from search results pointing elsewhere, replace the base path with "${cwd}/"
- Example: if you find "/original/repo/src/file.ts", use "${cwd}/src/file.ts" instead
- When writing tests or making HTTP requests, read the .env file in the workspace to get the correct PORT — do NOT use default ports like 4023 or 5173`);
  }

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
  async execute(args, _db, context) {
    const message = args.message as string;
    const status = (args.status as string) ?? 'in_progress';

    // Read from active session registry
    const activeCtx = resolveActiveSession(context);
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
  async execute(args, db, context) {
    const activeCtx = resolveActiveSession(context);
    const chatSessionId = activeCtx?.chatSessionId ?? context?.chatSessionId;

    // Find workspace linked to this session only
    const ws = chatSessionId
      ? await db.collection('workspaces').findOne({ chatSessionId, status: { $nin: ['archived', 'failed'] } })
      : null;
    if (!ws) return { error: 'No workspace linked to this chat session. Open this chat from a workspace first.' };

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

      // Push (git uses its own credential helper, not gh)
      await exec('git', ['push', '-u', 'origin', ws.branch as string], { cwd: ws.worktreePath as string });

      // Build gh env with token from .env (falls back to local gh auth)
      const { buildGhEnv } = await import('./github-auth.js');
      const ghEnv = await buildGhEnv();

      // Create PR
      await exec('gh', [
        'pr', 'create', '--title', title, '--body', body,
        '--base', ws.baseBranch as string, '--head', ws.branch as string,
      ], { cwd: ws.worktreePath as string, env: ghEnv });

      // Fetch PR details
      const { stdout: viewOut } = await exec('gh', [
        'pr', 'view', ws.branch as string,
        '--json', 'number,url',
      ], { cwd: ws.worktreePath as string, env: ghEnv });
      const result = JSON.parse(viewOut);

      // Save to pull_requests collection
      await db.collection('pull_requests').insertOne({
        repoId: ws.repoId, repoName: ws.repoName, repoPath: ws.repoPath,
        number: result.number, title, description: body,
        branch: ws.branch, baseBranch: ws.baseBranch,
        status: 'open', author: 'allen-agent',
        url: result.url, additions: 0, deletions: 0, changedFiles: 0, labels: [],
        createdByAgent: activeCtx?.currentAgent ?? 'assistant',
        chatSessionId,
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
  getWorkflow,
  runWorkflow,
  getExecution,
  listExecutions,
  cancelExecution,
  resumeExecution,
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
  getPendingInterventions,
  // Learning capture
  saveLearning,
  // Workspace actions
  createPullRequest,
  // Meta team tools (phase 4 — team-builder / agent-builder)
  ...metaChatTools,
  // Self-healing monitoring tools used by Allen's built-in monitoring agents.
  ...monitoringAgentTools,
];

/**
 * Execute a tool by name. Returns the result or an error object.
 */
export async function executeChatTool(
  toolName: string,
  args: Record<string, unknown>,
  db: Db,
  context?: ChatToolContext,
): Promise<Record<string, unknown>> {
  const tool = chatTools.find(t => t.name === toolName);
  if (!tool) return { error: `Unknown tool: ${toolName}` };
  try {
    return await tool.execute(args, db, context);
  } catch (err) {
    return { error: `Tool ${toolName} failed: ${(err as Error).message}` };
  }
}
