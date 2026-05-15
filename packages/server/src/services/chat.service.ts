/**
 * Chat Service
 * Manages chat sessions with tool-calling via Claude Code SDK (no API key needed).
 * Phase 3-4: Workflow execution + agent spawning
 * Phase 5-6: Database queries, debugging, dashboard stats
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { Response } from 'express';
import { PROVIDERS, runChatLLM, type ChatLLMMessage, type ChatProvider } from './chat-llm.js';
import { getDefaultChatProvider, getProvidersInDefaultOrder } from './chat-providers.js';
import { resolveAgentSettings, type AgentLike, type AgentOverrides, type ResolvedSettings } from './agent-settings.js';
import { AlertService } from './alert.service.js';
import { registerActiveSession, unregisterActiveSession, waitForBackgroundTasks } from './chat-tools.js';
import { searchSimilar, backfillEmbeddings } from './embedding.service.js';
import { buildOrgContextBlock } from './org-context.js';
import { MonitoringService } from './self-healing-monitor.service.js';
import { ExecutionService } from './execution.service.js';
import { LinearService } from './linear.service.js';
import { runPersistentCodexSlashCommand } from './chat-runtime-manager.js';
import { listSlashCommands, type SlashCommandInfo } from './slash-commands.js';
import type { RuntimeSlashCommand } from './chat-runtime-types.js';
// Note: embedding.service.ts re-exports from @allen/engine — single implementation shared by engine + server

// ── Types ──

export interface SlackContext {
  channelId: string;
  threadTs: string;
  teamId: string;
}

export interface ChatSession {
  _id?: ObjectId;
  title: string;
  titleSource?: 'default' | 'auto' | 'user';
  status: 'active' | 'archived';
  messageCount: number;
  lastMessageAt: Date;
  totalCostUsd: number;
  provider: ChatProvider;
  model?: string;
  llmSessionId?: string;
  source?: 'ui' | 'slack' | 'automation';
  automationKey?: string;
  slackContext?: SlackContext;
  repoId?: string;     // ObjectId string referencing repos collection
  repoPath?: string;   // Snapshot of repo.path at session creation time
  repoName?: string;   // Snapshot of repo.name for UI display
  ownerUserId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  _id?: ObjectId;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'streaming' | 'failed' | 'interrupted';
  senderUserId?: string;
  senderName?: string;
  senderEmail?: string;
  senderSource?: 'ui' | 'slack' | 'system';
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  error?: string;
  toolCalls?: ToolCallRecord[];
  thinkingText?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  durationMs: number;
  timestamp: Date;
  toolUseId?: string;
}

export interface ChatMessageSender {
  userId?: string;
  name?: string;
  email?: string;
  source?: 'ui' | 'slack' | 'system';
}

function senderFields(sender?: ChatMessageSender): Pick<ChatMessage, 'senderUserId' | 'senderName' | 'senderEmail' | 'senderSource'> {
  if (!sender) return {};
  return {
    ...(sender.userId ? { senderUserId: sender.userId } : {}),
    ...(sender.name ? { senderName: sender.name } : {}),
    ...(sender.email ? { senderEmail: sender.email } : {}),
    ...(sender.source ? { senderSource: sender.source } : {}),
  };
}

function parseSlashCommandText(content: string): { name: string; args: string; raw: string } | null {
  const trimmed = content.trim();
  const match = trimmed.match(/^(\/[^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], args: match[2] ?? '', raw: trimmed };
}

function resolveSlashCommand(content: string, commands: SlashCommandInfo[]): RuntimeSlashCommand | null {
  const parsed = parseSlashCommandText(content);
  if (!parsed) return null;
  const command = commands.find(item => item.name === parsed.name);
  if (!command || !command.dispatchable) return null;
  return {
    name: command.name,
    raw: parsed.raw,
    args: parsed.args,
    kind: command.kind,
    path: command.path,
  };
}

// ── SSE Helper ──

function sendSSE(res: Response, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* client disconnected */ }
}

// ── Mention Resolution ──

export async function resolveMentions(content: string, db: Db): Promise<{ context: string; repoPath?: string }> {
  const mentionRegex = /@([\w-]+)/g;
  const matches = [...content.matchAll(mentionRegex)];
  if (matches.length === 0) return { context: '' };

  // ── Linear ticket resolution (checked FIRST, before workflow/repo/agent) ──
  let linearContext = '';
  {
    const identifierPattern = /^[A-Z]+-\d+$/;
    // Preserve match order, deduplicate, cap at 3
    const identifiers = new Set<string>();
    for (const m of matches) {
      if (identifierPattern.test(m[1])) {
        identifiers.add(m[1]);
        if (identifiers.size >= 3) break;
      }
    }
    let resolvedCount = 0;
    let skippedCount = 0;
    if (identifiers.size > 0) {
      const linearSvc = new LinearService(db);
      // Sequential — not parallel — to stay within Linear API rate limits (NFR-007).
      for (const identifier of identifiers) {
        try {
          const detail = await linearSvc.getIssue(identifier);
          if (!detail) {
            skippedCount++;
            continue;
          }
          const description = (detail.fullDescription ?? detail.description ?? '').slice(0, 800);
          linearContext += `\n[LINEAR TICKET: ${detail.identifier}] Title: ${detail.title}\nURL: ${detail.url}\nDescription: ${description}\n`;
          resolvedCount++;
        } catch {
          skippedCount++;
        }
      }
    }
    console.log(`[linear:resolveMentions] tokens=${identifiers.size} resolved=${resolvedCount} skipped=${skippedCount} cap=3`);
  }

  const names = [...new Set(matches.map(m => m[1]))];
  let context = linearContext;
  let repoPath: string | undefined;

  const _identifierPattern = /^[A-Z]+-\d+$/;
  for (const name of names) {
    // Skip Linear ticket identifiers — already resolved in the Linear branch above.
    // This prevents unnecessary workflow/repo/agent DB lookups for ticket IDs (EC-009).
    if (_identifierPattern.test(name)) continue;
    const wf = await db.collection('workflows').findOne({ name, archived: { $ne: true } });
    if (wf) {
      const nodeNames = wf.parsed?.nodes ? Object.keys(wf.parsed.nodes).join(', ') : 'none';
      const inputDef = wf.parsed?.input;
      const inputs = inputDef
        ? Object.entries(inputDef).map(([k, v]: [string, any]) => `${k}(${v.type}${v.required ? ', required' : ''})`).join(', ')
        : 'none';
      context += `\n[WORKFLOW: ${name}] ${wf.description ?? ''}\nID: ${(wf._id as ObjectId).toString()}\nNodes: ${nodeNames}\nInputs: ${inputs}\n`;
      continue;
    }
    const repo = await db.collection('repos').findOne({ name });
    if (repo) {
      context += `\n[REPO: ${name}] Path: ${repo.path}\nLanguage: ${(repo.detected?.language ?? []).join(', ')}\nFramework: ${(repo.detected?.framework ?? []).join(', ')}\nBranch: ${repo.detected?.defaultBranch ?? 'unknown'}\n`;
      if (!repoPath) repoPath = repo.path as string; // Use first mentioned repo as cwd
      continue;
    }
    const agent = await db.collection('agents').findOne({ name });
    if (agent) {
      context += `\n[AGENT: ${name}] Provider: ${agent.provider ?? 'claude'}\nModel: ${agent.model ?? 'default'}\nTools: ${(agent.tools ?? []).join(', ')}\nSystem: ${(agent.system ?? '').slice(0, 200)}\n`;
    }
  }
  return { context, repoPath };
}

// ── System Prompt ──

const API_PORT = process.env.PORT ?? '4023';

/**
 * System prompt varies by provider:
 * - claude-cli: uses <tool_call> protocol (appended by chat-llm.ts)
 * - codex: uses bash + curl against local API
 */
async function writeMemoryAudit(db: Db, input: {
  rootType: 'chat' | 'workflow_execution' | 'agent_execution';
  rootId: string;
  agentName?: string;
  query?: string;
  retrievedLearningIds?: string[];
  retrievalScores?: number[];
  injectedLearningIds?: string[];
  injectedTokenCount?: number;
  promptContextHash?: string;
  error?: string;
}): Promise<void> {
  try {
    await db.collection('memory_injection_audits').insertOne({
      ...input,
      retrievedLearningIds: input.retrievedLearningIds ?? [],
      retrievalScores: input.retrievalScores ?? [],
      injectedLearningIds: input.injectedLearningIds ?? [],
      injectedTokenCount: input.injectedTokenCount ?? 0,
      createdAt: new Date(),
    });
  } catch {
    // Monitoring data must never block prompt construction.
  }
}

function learningId(value: unknown): string | null {
  const id = (value as { _id?: unknown; id?: unknown })?._id ?? (value as { id?: unknown })?.id;
  return id ? String(id) : null;
}

function hasToolError(resultData: unknown): boolean {
  const text = typeof resultData === 'string' ? resultData : JSON.stringify(resultData ?? {});
  return /\b(error|failed|exception|timeout|timed out|invalid|missing|denied|not found)\b/i.test(text);
}

function isReportToUserTool(tool: string): boolean {
  return tool === 'report_to_user' || tool.endsWith('__report_to_user');
}

function reportToUserPayload(resultData: unknown): { message: string; status: string } | null {
  if (!resultData || typeof resultData !== 'object') return null;
  const result = resultData as Record<string, unknown>;
  const message = typeof result.message === 'string' ? result.message.trim() : '';
  if (!message) return null;
  const status = typeof result.status === 'string' ? result.status : 'in_progress';
  return { message, status };
}

async function getSystemPrompt(
  provider: ChatProvider,
  db: Db,
  userMessage?: string,
  auditContext?: { rootType: 'chat'; rootId: string; agentName?: string },
): Promise<string> {
  // Load relevant learnings using embedding similarity search
  let learningsBlock = '';
  try {
    // Backfill embeddings for any learnings that don't have them
    await backfillEmbeddings(db);

    if (userMessage) {
      // Semantic search — find learnings most relevant to the user's message
      const results = (await searchSimilar(db, userMessage, { limit: 10, threshold: 0.35 })).slice(0, 5);
      if (results.length > 0) {
        const items = results.map(l => `- [${l.type}] (relevance: ${(l.score * 100).toFixed(0)}%) ${l.content}`).join('\n');
        learningsBlock = `\n\n## Memory from previous conversations\nApply these learned preferences and facts:\n${items}`;
      }
      if (auditContext?.rootId) {
        await writeMemoryAudit(db, {
          rootType: auditContext.rootType,
          rootId: auditContext.rootId,
          agentName: auditContext.agentName ?? 'assistant',
          query: userMessage,
          retrievedLearningIds: results.map(learningId).filter((id): id is string => Boolean(id)),
          retrievalScores: results.map((l) => l.score),
          injectedLearningIds: results.map(learningId).filter((id): id is string => Boolean(id)),
          injectedTokenCount: Math.ceil(results.map((l) => l.content).join(' ').split(/\s+/).length * 1.3),
          promptContextHash: Buffer.from(userMessage).toString('base64').slice(0, 64),
        });
      }
    } else {
      // No message context — load top preferences
      const prefs = await db.collection('learnings')
        .find({ status: 'active', tags: 'chat', type: 'preference' })
        .sort({ confidence: -1 })
        .limit(5)
        .toArray();
      if (prefs.length > 0) {
        const items = prefs.map(l => `- [${l.type}] ${l.content}`).join('\n');
        learningsBlock = `\n\n## Memory from previous conversations\nApply these learned preferences and facts:\n${items}`;
      }
      if (auditContext?.rootId) {
        await writeMemoryAudit(db, {
          rootType: auditContext.rootType,
          rootId: auditContext.rootId,
          agentName: auditContext.agentName ?? 'assistant',
          retrievedLearningIds: prefs.map(learningId).filter((id): id is string => Boolean(id)),
          injectedLearningIds: prefs.map(learningId).filter((id): id is string => Boolean(id)),
          injectedTokenCount: Math.ceil(prefs.map((l) => String(l.content ?? '')).join(' ').split(/\s+/).length * 1.3),
        });
      }
    }
  } catch (err) {
    console.error('\x1b[35m[embedding]\x1b[0m Failed to load learnings:', (err as Error).message);
    if (auditContext?.rootId) {
      await writeMemoryAudit(db, {
        rootType: auditContext.rootType,
        rootId: auditContext.rootId,
        agentName: auditContext.agentName ?? 'assistant',
        query: userMessage,
        error: (err as Error).message,
      });
    }
  }

  const base = `You are Allen Assistant — the intelligent command center for the Allen workflow orchestration platform.
When users mention @workflow-name, @repo-name, or @agent-name, you receive context about those resources. Use this to answer or fill in parameters automatically.
Be concise, natural, and technical. Use markdown when it improves readability.
Include real resource IDs only when they help the user take action, disambiguate a resource, or continue a workflow. Do not create artificial tracking IDs, issue IDs, labels, or codes in normal chat responses.

═══ RESOURCE LINKS — HARD RULE ═══
Every time you reference an external resource in your response, render it as a clickable markdown link. NEVER just quote an ID or name — always make it clickable. This applies to:

- **Pull requests / MRs** → \`[#123 — Fix login race](https://github.com/org/repo/pull/123)\`. Use the \`html_url\` field from the GitHub MCP / \`gh\` response; never invent a URL.
- **GitHub / Linear / Jira issues and tickets** → \`[LIN-456 — Add billing guardrails](https://linear.app/workspace/issue/LIN-456)\`. Pull the exact URL from the tool response; don't reconstruct it by hand.
- **Uploaded files** (anything you created via \`upload_file\`) → \`[deployment-plan.md](<publicUrl>)\`. The \`upload_file\` tool returns a \`publicUrl\` that is viewable without login — use that URL verbatim. Never paste the raw file contents when a link will do.
- **Artifacts** (anything you created via \`allen_save_artifact\`) → \`[plan.md](<publicUrl>)\`. PREFER \`allen_save_artifact\` over \`upload_file\` when the file belongs to this conversation — plans, designs, query result CSVs, config JSON, investigation notes. Artifacts appear in the chat's Artifacts panel, are filed under this session, auto-render in the UI (markdown / JSON / CSV / text), and can be listed later with \`allen_list_artifacts\`. Use \`upload_file\` only for one-off shares destined for Slack / email / outside the chat. When spawning sub-agents via \`spawn_agent\`, remind them to save their own work the same way — their artifacts inherit this chat as the root.
- **Workflow runs, executions, agents, chat threads** → link to the Allen UI route for that resource when you know it.
- **Slack messages, commits, CI runs, deploy URLs, dashboards** → always link, never just name.

If a tool call returned an external resource but no URL is visible to you, ASK the tool result for one (\`html_url\`, \`permalink\`, \`url\`, \`publicUrl\`) before giving up. For Allen internal resources, prefer a clickable UI link when the tool provides one or when the route is known with confidence. If no UI URL is available, present the resource by clear human-readable name/status/type and include the raw ID only when it is needed for follow-up, debugging, or disambiguation. Do not tell the user that a tool did not return a URL, and do not expose internal tool limitations, field names, or fallback reasoning.

Listing multiple resources? Render as a bulleted list of links, one per line, so the user can scan and click directly. Never hide a link behind prose like "I've opened a PR for this" with no link attached.

IMPORTANT RULES:
1. You are the routing brain. Decide from the user's intent whether to answer directly, inspect data with tools, run a workflow, spawn a single specialist execution, or involve a lead/team agent through delegation. Do not rely on a backend heuristic router.
2. When the user corrects you or states a preference ("no, use staging DB", "always run tests first", "I prefer TypeScript"), silently call save_learning to remember it. Write it as a generalized rule. Don't tell the user you're saving — just do it.
3. Evidence-first rule: do not make claims about a repository's existing implementation, supported behavior, available feature, bug cause, architecture, files, dependencies, tests, or prior execution unless you have clear evidence from code/docs/tool results/traces. Read or inspect the relevant source first, or spawn/delegate an agent that does. In your answer, briefly mention what evidence you checked. If you cannot verify it, say what is unknown and ask for permission/context rather than guessing.
4. Never change repository code directly from the top-level assistant. You may inspect files, docs, logs, and tool results for evidence, but implementation must go through run_workflow, delegate_to_agent to a relevant lead/team agent, or spawn_agent for a specialist working in an isolated Allen workspace. Do not edit files, commit, push, or open PRs yourself from the assistant response loop unless the user explicitly asks for a local-only emergency patch and accepts bypassing the normal workflow.
5. Normal conversation stays normal. If the user says "hi", asks a general question, brainstorms, asks for an explanation, or asks why you behaved a certain way, answer directly unless live Allen data is needed. For behavior questions, give the direct reason first; do not start with apology templates, synthetic issue labels, routing summaries, or workflow-style sections.
6. Allen Library skills are internal routing playbooks, distinct from Codex/Claude native runtime skills. In Allen chat, unqualified "skills" means Allen Library skills. For every non-trivial Allen-supported request, silently call list_skills first and use the full enabled skill metadata list (name, description, category, triggers, excludes, allowedRoutes, related workflows/agents, priority) to choose the right skill by user intent. Do not pick a skill only because search_skills ranked it highest; search_skills is only an optional hint after metadata review. After selecting the best skill from metadata, call get_skill for that skill before routing or answering. Do not load every skill body up front. Do not mention the selected skill name, skill id, or skill tool calls in user-facing responses unless the user explicitly asks. Only discuss Codex/Claude/plugin/runtime skills when the user explicitly asks for those.
7. Capability discovery before route selection: before proposing an execution route, inspect the available Allen workflows, specialized team leads/agents, and relevant external MCP tools that could do the job. Use list_workflows/get_workflow, list_teams/list_agents/get_team/get_agent, and any relevant external MCP discovery/list tools when available. Prefer the most specific workflow or specialized lead/agent that owns the end-to-end task; use raw external MCP tools directly only for simple tool-native queries/actions or as evidence for the selected route.
8. Intent clarity and confirmation: if the user intent, target repo/resource, scope, desired outcome, or best route is unclear, ask a concise clarifying question instead of guessing. Before starting execution that changes state or consumes a specialist/workflow run, present the selected route, short plan, required inputs, expected outputs, and risks/unknowns, then ask the user to confirm. Read-only answers and read-only data queries may proceed without confirmation after evidence is checked.
9. Tool contract: before run_workflow, inspect get_workflow and use exact parsed.input field names. After run_workflow, spawn_agent, or delegate_to_agent, wait/monitor until complete, blocked, or clearly still running. Surface progress, human-input pauses, workspace links, PR links, artifacts, and final output with clickable links.
10. Interrupted reruns: if this chat has interrupted/cancelled tasks and the user asks to rerun, retry, continue, or restart that work, ask whether they want a fresh start or to resume the cancelled execution. If they choose resume, use resume_execution. If they choose fresh start, route again from the user's current intent.
11. For product brainstorming or improvement requests about a known repo/system, first decide whether the answer depends on the existing implementation. If it does, inspect the repo first unless the user explicitly asks for product-level brainstorming only. If the user asks specifically about improving an existing product area, prefer a short repo-grounded inspection before recommendations.
12. Keep routing details, skill choice, workflow names, and confirmation plans out of normal answers unless the user asks how work will be routed or you are proposing execution.
13. Always surface resource links per the "Resource Links" rule above for PRs, tickets, uploads, artifacts, and deployments when available. For Allen internal resources, prefer links when available; otherwise present readable names/statuses and only include IDs when useful.${learningsBlock}`;

  // Inject the live org chart so the assistant knows who to spawn/delegate to.
  let orgBlock = '';
  try {
    const chart = await buildOrgContextBlock(db, { includeFullChart: true, includeMeta: true, chartMode: 'summary' });
    if (chart) orgBlock = `\n\n${chart}`;
  } catch {}

  // Inject available repos
  let reposBlock = '';
  try {
    const repos = await db.collection('repos').find({ status: 'active' }).toArray();
    if (repos.length > 0) {
      reposBlock = `\n\nAvailable repos: ${repos.map((r: any) => `${r.name} (${r.path})`).join(', ')}. User references with @repo-name.`;
    }
  } catch {}

  // Single unified tail for both providers — keeps tool guidance,
  // examples, and artifact handling identical across codex and
  // claude-cli so the assistant behaves the same regardless of which
  // CLI is running. Tool name aliases (with / without `allen` prefix)
  // are listed so the model picks them up correctly under either MCP
  // surface (codex namespaces tools with the server prefix; claude-cli
  // surfaces them by bare name via buildToolInstructions()).
  return `${base}

You have MCP tools available. Use them to get data — don't describe what you would do, actually call the tool.

Key Allen tools (under the \`allen\` MCP server — codex shows them as \`allen.<name>\`, claude-cli as bare \`<name>\`):
- list_skills, search_skills, get_skill
- list_workflows, get_workflow, list_executions, wait_for_execution
- list_agents, get_agent, list_teams, get_team, list_team_members, list_repos
- get_dashboard_stats, search_executions, get_node_trace, get_execution_logs
- run_workflow, spawn_agent, delegate_to_agent, wait_for_delegation
- create_workspace, get_workspace, create_workspace_for_pr
- allen_save_artifact, allen_list_artifacts, allen_get_artifact, upload_file
- submit_execution_input, ask_user, ask_delegator, answer_delegator

Other MCP servers (Linear, GitHub, etc.) are also available when configured.
Before choosing a route for execution work, compare matching workflows, specialized leads/agents, and external MCP tools. Do not jump straight to a raw MCP tool if a specialist agent or lead owns the end-to-end task.

Examples:
- "What workflows do I have?" → list_workflows
- "Show me linear tickets" → linear_search_issues
- "Check execution abc123" → wait_for_execution(execution_id="abc123")
- "List my agents" → list_agents
- "What skills do we have?" → list_skills
- "What happened in my last run?" → list_executions then get_execution_logs / get_node_trace
- "Show me dashboard stats" → get_dashboard_stats
- "Find failed executions today" → search_executions
- "Hi" → answer directly; do not run a workflow or spawn an agent
- "Review code in @my-repo" → load the matching routing playbook silently, compare workflows/agents/MCP tools, gather repo context, present review route/plan, ask confirmation, then create_workspace and spawn_agent if confirmed
- "Implement a feature in @my-repo" → load the matching routing playbook silently, compare workflows/agents/MCP tools, inspect get_workflow(feature-plan-and-implement) if it fits, present plan and exact inputs, ask confirmation, then run_workflow if confirmed
- "Fix this bug in @my-repo" → load the matching routing playbook silently, compare workflows/agents/MCP tools, inspect get_workflow(bug-investigate-and-fix) if it fits, present plan and exact inputs, ask confirmation, then run_workflow if confirmed
- "Assign this to engineering lead" → load the matching routing playbook silently, verify the lead/agent target, present delegation target and task, ask confirmation, then delegate_to_agent if confirmed
- "Run coding-reviewer on @my-repo" → load the matching routing playbook silently, verify the specialist target, present workspace/reviewer plan, ask confirmation, then create_workspace and spawn_agent if confirmed
- "Work on LIN-123" → load the matching routing playbook silently, inspect the ticket via Linear if available, compare workflows/agents/MCP tools, present plan and exact workflow/agent inputs, ask confirmation, then execute if confirmed
- If an execution is waiting for input → present the fields, then submit_execution_input

For code tasks: direct specialist spawns need an Allen workspace first; workflows with their own create_workspace node should receive the registered repo_path and create the worktree themselves. For read-only planning or explanation, answer directly or use read-only tools. Remind any sub-agent you spawn to save its deliverables via allen_save_artifact so they appear in this chat's Artifacts panel.${orgBlock}${reposBlock}`;
}

// ── Active Query Tracking ──

interface ActiveQuery {
  sessionId: string;
  messageId: string;
  currentText: string;
  currentThinking: string;
  toolCalls: ToolCallRecord[];
  pendingToolCalls: Map<string, { tool: string; args: Record<string, unknown>; startMs: number }>;
  listeners: Set<Response>;
  eventHandlers?: Set<ChatEventHandler>;
  aborted: boolean;
  /** Abort controller for the underlying LLM subprocess. Calling .abort()
   *  kills the claude-cli process (SIGTERM) and stops token generation.
   *  Without this, clicking "Stop" in the UI only closes the SSE connection
   *  but the agent keeps running in the background burning tokens. */
  abortController: AbortController;
}

const activeQueries = new Map<string, ActiveQuery>();
const ACTIVE_EXECUTION_STATUSES = ['running', 'queued', 'waiting_for_input'];

// ── SSE Heartbeat ──
// Emits `: keepalive\n\n` every 15 s to every active SSE listener.
// This is a SSE comment line (starts with `:`) — the spec ignores it as
// event data but it resets the browser/proxy idle-timeout timer, preventing
// the "Error: network error" drop that occurs during long tool-execution
// quiet periods (ENG-1581).
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
// WeakMap so entries are GC-d automatically once a Response is released.
const listenerHeartbeats = new WeakMap<Response, ReturnType<typeof setInterval>>();

function attachHeartbeat(res: Response): void {
  const handle = setInterval(() => {
    try { res.write(': keepalive\n\n'); }
    catch {
      clearInterval(handle);
      listenerHeartbeats.delete(res);
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);
  listenerHeartbeats.set(res, handle);
}

function detachHeartbeat(res: Response): void {
  const handle = listenerHeartbeats.get(res);
  if (handle !== undefined) {
    clearInterval(handle);
    listenerHeartbeats.delete(res);
  }
}

interface CancelledExecutionInfo {
  id: string;
  workflowName?: string;
  status?: string;
}

export interface ChatCancelResult {
  cancelled: boolean;
  sessionId: string;
  cancelledExecutions: CancelledExecutionInfo[];
}

export type ChatEventHandler = (event: string, data: unknown) => void;

const CHAT_TITLE_MAX_CHARS = 70;
const CHAT_TITLE_MAX_WORDS = 10;

function executionRequestTitle(exec: Record<string, unknown>): string {
  const meta = ((exec.meta ?? {}) as Record<string, unknown>) ?? {};
  const input = ((exec.input ?? {}) as Record<string, unknown>) ?? {};
  return String(
    meta.requestText
      ?? meta.linearTitle
      ?? input.task
      ?? input.prompt
      ?? input.request
      ?? exec.workflowName
      ?? exec.id
      ?? 'task',
  );
}

function compactChatTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = sanitizeChatTitle(value);
  if (!trimmed) return null;
  return trimmed;
}

function deterministicSessionTaskTitle(userMessage: string): string | null {
  const linearTitleMatch = userMessage.match(/Linear title:\s*([^\n]+)/i)
    ?? userMessage.match(/Ticket title:\s*([^\n]+)/i)
    ?? userMessage.match(/Issue title:\s*([^\n]+)/i);
  const linearTitle = compactChatTitle(linearTitleMatch?.[1]);
  if (linearTitle) return linearTitle;

  const dispatchMatch = userMessage.match(/Dispatch Linear ticket\s+([A-Z][A-Z0-9]+-\d+)\s*(?:[:\-–—]\s*|\s+through\s+Allen\b\s*)?([^\n]*)/i);
  const dispatchTitle = compactChatTitle(dispatchMatch?.[2]);
  if (dispatchTitle && !/^through allen$/i.test(dispatchTitle)) return dispatchTitle;

  const assignMatch = userMessage.match(/\b(?:assign|work on|fix|implement|review|debug|investigate)\b(?:\s+this)?(?:\s+task|\s+ticket|\s+issue)?[:\-–—]?\s+([^\n]+)/i);
  return compactChatTitle(assignMatch?.[1]) ?? null;
}

export function sanitizeChatTitle(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  let title = candidate
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';

  title = title
    .replace(/^[-*#>\s]+/, '')
    .replace(/^title\s*:\s*/i, '')
    .replace(/^["'`]+|["'`.]+$/g, '')
    .replace(/^\*\*(.+)\*\*$/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title) return null;

  const words = title.split(/\s+/);
  if (words.length > CHAT_TITLE_MAX_WORDS) {
    title = words.slice(0, CHAT_TITLE_MAX_WORDS).join(' ');
  }
  if (title.length > CHAT_TITLE_MAX_CHARS) {
    const truncated = title.slice(0, CHAT_TITLE_MAX_CHARS).replace(/\s+\S*$/, '').trim();
    title = truncated || title.slice(0, CHAT_TITLE_MAX_CHARS).trim();
  }

  title = title.replace(/[.,;:!?-]+$/g, '').trim();
  return title || null;
}

function fallbackTitleFromUserMessage(userMessage: string): string {
  const cleaned = userMessage
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b(can you|could you|please|do one thing|i want to|we need to)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitizeChatTitle(cleaned) ?? 'New conversation';
}

export function normalizeGeneratedChatTitle(candidate: unknown, userMessage: string): string {
  return sanitizeChatTitle(candidate) ?? fallbackTitleFromUserMessage(userMessage);
}

interface VerifiedTitle {
  title: string;
  isValid: boolean;
  reason?: string;
}

/**
 * Parse the LLM's structured self-verification response. Tolerates code-fence
 * wrappers, leading prose, and trailing prose by extracting the first JSON
 * object that looks right.
 */
function parseTitleVerification(raw: string): VerifiedTitle | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1]);
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch?.[0]) candidates.push(objMatch[0]);
  candidates.push(raw);

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === 'object' && typeof parsed.final_title === 'string') {
        return {
          title: parsed.final_title,
          isValid: parsed.is_valid !== false,
          reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
        };
      }
    } catch {}
  }
  return null;
}

async function cancelLinkedChatExecutions(sessionId: string, db: Db): Promise<CancelledExecutionInfo[]> {
  const linkedRows = await db.collection('executions')
    .find(
      { 'meta.chatSessionId': sessionId },
      { projection: { id: 1, workflowName: 1 } },
    )
    .toArray();
  const linkedIds = linkedRows.map((row) => row.id as string).filter(Boolean);

  const activeRows = await db.collection('executions')
    .find(
      {
        status: { $in: ACTIVE_EXECUTION_STATUSES },
        $or: [
          { 'meta.chatSessionId': sessionId },
          ...(linkedIds.length > 0 ? [
            { rootExecutionId: { $in: linkedIds } },
            { parentExecutionId: { $in: linkedIds } },
          ] : []),
        ],
      },
      { projection: { id: 1, workflowName: 1, status: 1 } },
    )
    .toArray();

  const service = new ExecutionService(db);
  const seen = new Set<string>();
  const cancelled: CancelledExecutionInfo[] = [];

  for (const row of activeRows) {
    const id = row.id as string | undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      await service.cancel(id);
      await db.collection('execution_logs').insertOne({
        executionId: id,
        level: 'warn',
        category: 'system',
        message: 'Cancelled because the owning chat thread was interrupted.',
        timestamp: new Date(),
      }).catch(() => {});
      cancelled.push({
        id,
        workflowName: row.workflowName as string | undefined,
        status: 'cancelled',
      });
    } catch {
      // Best-effort: do not block chat interrupt cleanup.
    }
  }

  return cancelled;
}

async function interruptedTaskContext(db: Db, sessionId: string): Promise<string> {
  const rows = await db.collection('executions')
    .find(
      { 'meta.chatSessionId': sessionId, status: 'cancelled' },
      {
        projection: { id: 1, workflowName: 1, status: 1, input: 1, meta: 1, completedAt: 1, sessions: 1 },
        sort: { completedAt: -1, startedAt: -1 },
        limit: 5,
      },
    )
    .toArray()
    .catch(() => []);
  if (rows.length === 0) return '';
  const lines = rows.map((row) => {
    const id = row.id as string;
    const kind = String(row.workflowName ?? '').includes(':spawn_agent/') ? 'agent/lead' : 'workflow';
    const hasSession = row.sessions && Object.keys(row.sessions as Record<string, unknown>).length > 0;
    return `- ${id} (${kind}): ${executionRequestTitle(row)}${hasSession ? ' — resumable agent session available' : ''}`;
  });
  return `\n[INTERRUPTED TASKS IN THIS THREAD]\n${lines.join('\n')}\nIf the user asks to rerun/continue/retry one of these, ask whether they want a fresh start or resume. Use resume_execution only after they choose resume.`;
}

/**
 * Cancel a running chat session's LLM subprocess. Called from the
 * POST /api/chat/sessions/:id/cancel route.
 *
 * This is an INTERRUPT, not just a stop:
 *   1. Kills the claude-cli / codex subprocess (SIGTERM via AbortController)
 *   2. Clears the stale llmSessionId so the next message starts a fresh
 *      thread instead of trying to resume the dead one (which fails with
 *      "no rollout found" on Codex)
 *   3. Marks the in-flight assistant message as cancelled
 *   4. Removes the session from activeQueries so it's not "busy"
 *   5. Broadcasts a cancel event to any SSE listeners
 *
 * After cancel, the user can immediately send a new message.
 */
export async function cancelChatSession(sessionId: string, db?: Db): Promise<ChatCancelResult> {
  const entry = activeQueries.get(sessionId);
  let cancelledExecutions: CancelledExecutionInfo[] = [];

  // 1. Kill the subprocess for THIS turn only
  if (entry) {
    entry.aborted = true;
    entry.abortController.abort();
  }

  // 2. Cancel linked workflow/agent executions spawned from this chat.
  if (db) {
    cancelledExecutions = await cancelLinkedChatExecutions(sessionId, db);
  }

  // 3. DO NOT touch llmSessionId — the thread still exists on the
  //    provider's side. We just killed our local subprocess. The next
  //    message resumes the same thread with full prior context.

  // 4. Mark the in-flight assistant message as cancelled
  if (entry && db) {
    const { ObjectId } = await import('mongodb');
    if (entry.messageId) {
      const executionNote = cancelledExecutions.length > 0
        ? `Interrupted by user. Cancelled linked tasks: ${cancelledExecutions.map((exec) => exec.id).join(', ')}. If you want to rerun, choose fresh start or resume.`
        : 'Interrupted by user.';
      await db.collection('chat_messages').updateOne(
        { _id: new ObjectId(entry.messageId) },
        { $set: {
          status: 'cancelled',
          content: entry.currentText ? `${entry.currentText}\n\n${executionNote}` : executionNote,
          completedAt: new Date(),
        } },
      ).catch(() => {});
    }
  }

  // 5. Broadcast cancel event so UI updates immediately
  if (entry) {
    broadcastToListeners(entry, 'cancelled', { messageId: entry.messageId, cancelledExecutions });
  }

  // 6. Remove from active queries so the user can send the next message
  if (entry) activeQueries.delete(sessionId);

  return { cancelled: Boolean(entry), sessionId, cancelledExecutions };
}

function broadcastToListeners(entry: ActiveQuery, event: string, data: unknown): void {
  const payload = data && typeof data === 'object' && !Array.isArray(data) && !('messageId' in data)
    ? { ...(data as Record<string, unknown>), messageId: entry.messageId }
    : data;
  for (const listener of entry.listeners) {
    try { listener.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
    catch { entry.listeners.delete(listener); }
  }
  for (const handler of entry.eventHandlers ?? []) {
    try { handler(event, payload); } catch { entry.eventHandlers?.delete(handler); }
  }
}

// ── Service ──

export class ChatService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private get sessions() { return this.db.collection('chat_sessions'); }
  private get messages() { return this.db.collection('chat_messages'); }

  getProviders() { return getProvidersInDefaultOrder(); }

  async createSession(
    provider: ChatProvider = getDefaultChatProvider(),
    model?: string,
    source: 'ui' | 'slack' = 'ui',
    slackContext?: SlackContext,
    agentOverrides?: Record<string, unknown>,
    repoId?: string,
    owner?: { userId?: string; name?: string; email?: string },
  ): Promise<ChatSession> {
    const now = new Date();
    let repoPath: string | undefined;
    let repoName: string | undefined;
    if (repoId) {
      try {
        const repo = await this.db.collection('repos').findOne({ _id: new ObjectId(repoId) });
        if (repo) {
          repoPath = repo.path as string;
          repoName = repo.name as string;
        }
      } catch (e) {
        // invalid ObjectId or missing repo — proceed without repo binding
      }
    }
    const doc: ChatSession = {
      title: 'New Conversation', titleSource: 'default', status: 'active', messageCount: 0,
      lastMessageAt: now, totalCostUsd: 0, provider, model,
      source,
      ...(slackContext ? { slackContext } : {}),
      ...(repoId && repoPath ? { repoId, repoPath, repoName } : {}),
      ...(agentOverrides ? { agentOverrides } : {}),
      ...(owner?.userId ? { ownerUserId: owner.userId } : {}),
      ...(owner?.name ? { ownerName: owner.name } : {}),
      ...(owner?.email ? { ownerEmail: owner.email } : {}),
      createdAt: now, updatedAt: now,
    };
    const result = await this.sessions.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async listSessions(filter?: { ownerUserId?: string | null }): Promise<ChatSession[]> {
    // Owner info is denormalized onto the session at creation time (and
    // backfilled at startup for legacy sessions), so this is a plain find().
    // Pass ownerUserId=null to filter for unowned sessions (automation / legacy
    // rows that the backfill couldn't resolve).
    const query: Record<string, unknown> = {};
    if (filter && 'ownerUserId' in filter) {
      // MongoDB: { field: null } matches both null and missing values.
      query.ownerUserId = filter.ownerUserId;
    }
    const sessions = await this.sessions
      .find(query)
      .sort({ lastMessageAt: -1 })
      .limit(100)
      .toArray() as unknown as ChatSession[];
    return sessions;
  }

  async getSession(id: string): Promise<(ChatSession & { messages: ChatMessage[] }) | null> {
    const session = await this.sessions.findOne({ _id: new ObjectId(id) });
    if (!session) return null;
    const msgs = await this.messages.find({ sessionId: id }).sort({ createdAt: -1 }).limit(50).toArray() as ChatMessage[];
    msgs.reverse();
    return { ...(session as unknown as ChatSession), messages: msgs };
  }

  async getMessages(sessionId: string, before?: string, limit = 50): Promise<{ data: ChatMessage[]; hasMore: boolean }> {
    const query: Record<string, unknown> = { sessionId };
    if (before) {
      const beforeDoc = await this.messages.findOne({ _id: new ObjectId(before) });
      if (beforeDoc) query.createdAt = { $lt: beforeDoc.createdAt };
    }
    const data = (await this.messages.find(query).sort({ createdAt: -1 }).limit(limit + 1).toArray()) as ChatMessage[];
    const hasMore = data.length > limit;
    if (hasMore) data.pop();
    data.reverse();
    return { data, hasMore };
  }

  async sendMessage(sessionId: string, content: string, res: Response, agent?: string, cwd?: string, sender?: ChatMessageSender): Promise<void> {
    const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

    if (activeQueries.has(sessionId)) {
      res.status(409).json({ error: 'Session already has an active response' }); return;
    }

    const now = new Date();
    await this.messages.insertOne({
      sessionId, role: 'user', content, status: 'completed',
      ...senderFields(sender),
      createdAt: now, completedAt: now,
    });
    const assistantResult = await this.messages.insertOne({ sessionId, role: 'assistant', content: '', status: 'streaming', createdAt: new Date() });
    const assistantMsgId = assistantResult.insertedId.toString();

    await this.sessions.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { lastMessageAt: new Date(), updatedAt: new Date() }, $inc: { messageCount: 2 } },
    );

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });

    const entry: ActiveQuery = {
      sessionId, messageId: assistantMsgId, currentText: '', currentThinking: '', toolCalls: [],
      pendingToolCalls: new Map(), listeners: new Set([res]), aborted: false, abortController: new AbortController(),
    };
    activeQueries.set(sessionId, entry);
    attachHeartbeat(res);
    res.on('close', () => { detachHeartbeat(res); entry.listeners.delete(res); });

    this.runLLM(sessionId, assistantMsgId, content, entry, agent, 0, cwd).catch(() => {});
  }

  /**
   * Send a message and await the final result without an HTTP Response.
   * Used by the Slack integration: agent runs the same pipeline as sendMessage(),
   * but instead of streaming SSE the caller gets a Promise with the final text.
   * UI users can still watch progress by subscribing to /sessions/:id/stream.
   */
  async sendMessageForSlack(
    sessionId: string,
    content: string,
    agent?: string,
    sender?: ChatMessageSender,
    onEvent?: ChatEventHandler,
  ): Promise<{ text: string; costUsd: number; durationMs: number }> {
    const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
    if (!session) throw new Error('Session not found');
    if (activeQueries.has(sessionId)) throw new Error('Session busy');

    const now = new Date();
    await this.messages.insertOne({
      sessionId, role: 'user', content, status: 'completed',
      ...senderFields(sender),
      createdAt: now, completedAt: now,
    });
    const assistantResult = await this.messages.insertOne({
      sessionId, role: 'assistant', content: '', status: 'streaming', createdAt: new Date(),
    });
    const assistantMsgId = assistantResult.insertedId.toString();

    await this.sessions.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { lastMessageAt: new Date(), updatedAt: new Date() }, $inc: { messageCount: 2 } },
    );

    // ActiveQuery with no SSE listeners — UI can still subscribe via GET /stream
    const entry: ActiveQuery = {
      sessionId, messageId: assistantMsgId, currentText: '', currentThinking: '', toolCalls: [],
      pendingToolCalls: new Map(),
      listeners: new Set(), aborted: false, abortController: new AbortController(),
      ...(onEvent ? { eventHandlers: new Set([onEvent]) } : {}),
    };
    activeQueries.set(sessionId, entry);

    // runLLM handles all DB updates, error logging, and active session cleanup
    await this.runLLM(sessionId, assistantMsgId, content, entry, agent);

    // Read the final result from DB (runLLM has already saved it)
    const msg = await this.messages.findOne({ _id: new ObjectId(assistantMsgId) });
    if (!msg) throw new Error('Assistant message not found after runLLM');
    if (msg.status === 'failed') {
      throw new Error((msg.error as string) || 'Agent failed to respond');
    }
    return {
      text: (msg.content as string) ?? '',
      costUsd: (msg.costUsd as number) ?? 0,
      durationMs: (msg.durationMs as number) ?? 0,
    };
  }

  subscribeToStream(sessionId: string, res: Response): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const entry = activeQueries.get(sessionId);
    if (entry) {
      if (entry.currentThinking) sendSSE(res, 'thinking', { text: entry.currentThinking, messageId: entry.messageId });
      if (entry.currentText) sendSSE(res, 'message_delta', { text: entry.currentText, messageId: entry.messageId });
      for (const [toolUseId, pending] of entry.pendingToolCalls) {
        sendSSE(res, 'tool_start', { tool: pending.tool, args: pending.args, toolUseId, tool_use_id: toolUseId, messageId: entry.messageId });
      }
      entry.listeners.add(res);
      attachHeartbeat(res);
      res.on('close', () => { detachHeartbeat(res); entry.listeners.delete(res); });
    } else {
      sendSSE(res, 'stream_inactive', { sessionId });
      res.end();
    }
  }

  isStreaming(sessionId: string): boolean { return activeQueries.has(sessionId); }

  /**
   * Broadcast an SSE event to every tab currently subscribed to this
   * session's stream. Used by the /agent-answer endpoint so a user who
   * answers an ask_user question in one tab instantly clears the popup
   * in their other tabs — without this, the ask_user tool's poll loop
   * is the only thing that fires `user_answer`, and its interval can
   * grow to 30s between checks, leaving sibling tabs stuck on the
   * question for that long.
   *
   * Returns the number of listeners the event was delivered to. 0 means
   * the session has no active query (nothing to broadcast to); the caller
   * can still rely on the DB write being visible via the poll loop.
   */
  broadcastToSession(sessionId: string, event: string, data: unknown): number {
    const entry = activeQueries.get(sessionId);
    if (!entry) return 0;
    broadcastToListeners(entry, event, data);
    return entry.listeners.size;
  }

  /**
   * Generate (or regenerate) a title for an existing session by fetching the
   * first user + first assistant message and running them through the LLM
   * title generator. Used by the manual backfill endpoint so operators can
   * fix sessions that were poorly titled.
   *
   * Returns the generated title string, or null if the session has no user
   * messages yet.
   */
  async generateTitleForSession(sessionId: string): Promise<string | null> {
    const [userMsg, assistantMsg] = await Promise.all([
      this.messages.findOne(
        { sessionId, role: 'user' },
        { sort: { createdAt: 1 } },
      ),
      this.messages.findOne(
        { sessionId, role: 'assistant' },
        { sort: { createdAt: 1 } },
      ),
    ]);

    if (!userMsg) return null;

    const title = await this.generateTitleWithLLM(
      userMsg.content as string,
      assistantMsg?.content as string | undefined,
    );

    await this.sessions.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { title, titleSource: 'auto', updatedAt: new Date() } },
    );

    this.broadcastToSession(sessionId, 'session_update', { title });

    return title;
  }

  /**
   * Run a title-generating prompt against codex gpt-5.5, expecting structured
   * JSON with the model's own self-verification verdict. If the model marks
   * its draft invalid, retry once with the model's stated reason as feedback.
   * Returns the sanitized final title, or null if both attempts failed.
   */
  private async runVerifiedTitleLLM(prompt: string, userMessage: string): Promise<string | null> {
    const callOnce = async (p: string): Promise<VerifiedTitle | null> => {
      try {
        const result = await runChatLLM(this.db, {
          provider: 'codex',
          model: 'gpt-5.5',
          systemPrompt: '',
          messages: [{ role: 'user', content: p }],
          skipTools: true,
          onText: () => {},
          onToolStart: () => {},
          onToolResult: () => {},
        });
        return parseTitleVerification(result.text.trim());
      } catch (err) {
        console.error('LLM title generation failed:', err instanceof Error ? err.message : err);
        return null;
      }
    };

    const first = await callOnce(prompt);
    if (first?.isValid && first.title) {
      return normalizeGeneratedChatTitle(first.title, userMessage);
    }

    const feedback = first?.reason || 'The previous draft did not meet the rules. Produce a corrected title.';
    const retryPrompt = `${prompt}\n\nYour previous attempt failed self-verification with reason: ${feedback}\nProduce a fully verified title that passes every rule.`;
    const second = await callOnce(retryPrompt);
    if (second?.isValid && second.title) {
      return normalizeGeneratedChatTitle(second.title, userMessage);
    }

    return null;
  }

  /**
   * Generate a concise, meaningful title for a conversation using the LLM.
   * Uses codex gpt-5.5 with no tools. Falls back to string truncation.
   * assistantResponse is optional — omit it when titling from a user message only
   * (e.g. the first turn was aborted before the LLM responded).
   */
  private async generateTitleWithLLM(userMessage: string, assistantResponse?: string): Promise<string> {
    const prompt = assistantResponse
      ? `Generate a concise, descriptive title for this conversation.

Rules:
- Maximum 10 words
- Start with an action verb when possible (Fix, Build, Debug, Review, Find, Add, Improve, Analyse, etc.)
- Name the specific resource, feature, or system involved (repo name, component, API, etc.)
- Be concrete — avoid generic labels like "Chat about X" or "Help with Y"

Self-verification (the model MUST do this internally before answering):
- Read the user message (and assistant response if present).
- Draft a candidate title obeying every rule above.
- Check the candidate: is it a sentence fragment, an assistant-style reply, a single-word command (approve/yes/ok), a bare ID/URL/email, or a copy-pasted metadata line? If yes, reject and redraft.
- Confirm the final title actually summarises what the user is trying to accomplish.

Output format — RETURN ONLY this JSON object on a single line, nothing else:
{"final_title":"<the verified title>","is_valid":true,"reason":""}

If you cannot produce a title that passes every check, return:
{"final_title":"","is_valid":false,"reason":"<short explanation>"}

Good examples (the title field):
- Fix visual search failure in image embeddings
- Review Allen chat productivity gaps
- Find extraction and transformation prompts
- Add authentication to the dashboard API
- Debug slow query in product search

User: ${userMessage.slice(0, 500)}

Assistant: ${assistantResponse.slice(0, 500)}`
      : `Generate a concise, descriptive title for a conversation that starts with the following message.

Rules:
- Maximum 10 words
- Start with an action verb when possible (Fix, Build, Debug, Review, Find, Add, Improve, Analyse, etc.)
- Name the specific resource, feature, or system involved (repo name, component, API, etc.)
- Be concrete — avoid generic labels like "Chat about X" or "Help with Y"

Self-verification (the model MUST do this internally before answering):
- Read the user message (and assistant response if present).
- Draft a candidate title obeying every rule above.
- Check the candidate: is it a sentence fragment, an assistant-style reply, a single-word command (approve/yes/ok), a bare ID/URL/email, or a copy-pasted metadata line? If yes, reject and redraft.
- Confirm the final title actually summarises what the user is trying to accomplish.

Output format — RETURN ONLY this JSON object on a single line, nothing else:
{"final_title":"<the verified title>","is_valid":true,"reason":""}

If you cannot produce a title that passes every check, return:
{"final_title":"","is_valid":false,"reason":"<short explanation>"}

Good examples (the title field):
- Fix visual search failure in image embeddings
- Review Allen chat productivity gaps
- Find extraction and transformation prompts
- Add authentication to the dashboard API
- Debug slow query in product search

User: ${userMessage.slice(0, 500)}`;

    const verified = await this.runVerifiedTitleLLM(prompt, userMessage);
    if (verified) return verified;
    return deterministicSessionTaskTitle(userMessage) ?? fallbackTitleFromUserMessage(userMessage);
  }

  /**
   * Run LLM via Anthropic Messages API with native tool calling.
   */
  private async runLLM(sessionId: string, assistantMsgId: string, content: string, entry: ActiveQuery, agent?: string, retryCount = 0, cwd?: string): Promise<void> {
    const saveInterval = setInterval(() => {
      if (entry.currentText) {
        this.messages.updateOne(
          { _id: new ObjectId(assistantMsgId) },
          { $set: { content: entry.currentText, thinkingText: entry.currentThinking, toolCalls: entry.toolCalls } },
        ).catch(() => {});
      }
    }, 5000);

    const startMs = Date.now();

    // Load session state BEFORE try block so catch can access these
    const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
    const provider = (session?.provider as ChatProvider) ?? getDefaultChatProvider();
    const model = session?.model as string | undefined;
    const previousAgent = (session?.activeAgent as string | undefined) ?? undefined;
    // Agent is LOCKED to the session after first message — ignore agent param on subsequent messages
    const effectiveAgent = previousAgent ?? agent ?? undefined;
    const resumeSessionId = (session?.llmSessionId as string | undefined);

    try {

      // Set agent on first message only
      if (!previousAgent && effectiveAgent) {
        await this.sessions.updateOne(
          { _id: new ObjectId(sessionId) },
          { $set: { activeAgent: effectiveAgent } },
        );
      }

      // Resolve @mentions (returns context text + repo path if @repo was mentioned)
      const { context: mentionContext, repoPath: mentionRepoPath } = await resolveMentions(content, this.db);

      // Resolve workspace context — ONLY if this session is explicitly linked to a workspace
      let workspaceContext = '';
      let resolvedCwd: string | undefined;
      try {
        const linkedWs = await this.db.collection('workspaces').findOne({ chatSessionId: sessionId, status: { $nin: ['archived', 'failed'] } });
        if (linkedWs) {
          workspaceContext = `\n[WORKSPACE: ${linkedWs.name}] Path: ${linkedWs.worktreePath}\nBranch: ${linkedWs.branch} → ${linkedWs.baseBranch}\nRepo: ${linkedWs.repoName}\nYou are working inside this workspace. All file paths are relative to: ${linkedWs.worktreePath}\n`;
          resolvedCwd = linkedWs.worktreePath as string;
        }
      } catch {}

      // Step 2 — session-level repo (only when no linked workspace)
      if (!resolvedCwd && session?.repoPath) {
        resolvedCwd = session.repoPath as string;
      }

      // If no workspace linked, use @repo mention path as cwd
      if (!resolvedCwd && mentionRepoPath) {
        resolvedCwd = mentionRepoPath;
      }

      // Final fallback: use agent-provided cwd (for non-builtin agents with sourceRepoPath)
      if (!resolvedCwd && cwd) {
        resolvedCwd = cwd;
      }

      // Register active session with resolved cwd — ALL tools in the chain read this
      registerActiveSession({
        chatSessionId: sessionId,
        parentMessageId: assistantMsgId,
        currentAgent: effectiveAgent,
        delegationDepth: 0,
        broadcastEvent: (event, data) => broadcastToListeners(entry, event, data),
        pendingBackgroundTasks: 0,
        resolvedCwd,
      });

      const interruptedContext = await interruptedTaskContext(this.db, sessionId);
      const allContext = [mentionContext, workspaceContext, interruptedContext].filter(Boolean).join('\n');
      const enrichedContent = allContext
        ? `CONTEXT:\n${allContext}\n\nUSER MESSAGE:\n${content}`
        : content;

      // Build message history
      let llmMessages: ChatLLMMessage[];
      const hasSessionResume = (provider === 'claude-cli' || provider === 'codex') && resumeSessionId;
      if (hasSessionResume) {
        // CLI providers use session resume — only send new message
        llmMessages = [{ role: 'user', content: enrichedContent }];
      } else {
        // API providers need full conversation history
        const history = await this.messages
          .find({ sessionId, status: 'completed' })
          .sort({ createdAt: -1 })
          .limit(30)
          .toArray();
        history.reverse();
        llmMessages = history.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content as string,
        }));
        // Replace last user message with enriched version
        if (llmMessages.length > 0 && llmMessages[llmMessages.length - 1].role === 'user') {
          llmMessages[llmMessages.length - 1].content = enrichedContent;
        }
      }

      // Build system prompt: team agent prompt if selected, else default assistant
      let systemPrompt: string;
      if (effectiveAgent) {
        systemPrompt = await this.buildAgentSystemPrompt(effectiveAgent, provider, content, sessionId);
      } else {
        systemPrompt = await getSystemPrompt(provider, this.db, content, { rootType: 'chat', rootId: sessionId, agentName: 'assistant' });
      }

      // Inject workspace path constraint into system prompt
      if (resolvedCwd && resolvedCwd !== '/tmp/allen') {
        systemPrompt += `\n\nWORKSPACE CONSTRAINT:\nYour working directory is: ${resolvedCwd}\nCRITICAL: ALL file operations (Read, Write, Edit, Grep, Glob, Bash) MUST use paths within this directory.\n- Use relative paths or paths starting with "${resolvedCwd}/"\n- NEVER read, write, or modify files outside this directory\n- If search results show paths outside this directory, replace the base with "${resolvedCwd}/"`;
      }

      // Use already-resolved cwd (workspace path or @repo path)
      const workspaceCwd = resolvedCwd;

      // Resolve agent settings (reasoning effort, plan mode) using:
      //   session.agentOverrides  >  agent defaults  >  assistant default
      // Mutations never propagate back to the agent document — overrides are
      // ephemeral per-session state.
      //
      // When no team agent is selected, the chat talks to the raw assistant;
      // that pseudo-agent defaults to reasoningEffort='high' on codex (which
      // has its own reasoning budget) and 'medium' elsewhere, matching the UI
      // label shown in the ChatInput effort picker.
      let resolvedSettings: ResolvedSettings | undefined;
      try {
        const agentDoc = effectiveAgent
          ? (await this.db.collection('agents').findOne({ name: effectiveAgent }))
          : null;
        const assistantDefaultEffort = provider === 'codex' ? 'high' : 'medium';
        const agentLike: AgentLike = {
          name: effectiveAgent ?? 'default',
          provider,
          model,
          reasoningEffort: agentDoc?.reasoningEffort ?? (effectiveAgent ? undefined : assistantDefaultEffort),
          planMode: agentDoc?.planMode,
        };
        const sessionOverrides = (session?.agentOverrides as AgentOverrides | undefined) ?? undefined;
        resolvedSettings = resolveAgentSettings(agentLike, [sessionOverrides]);
      } catch (err) {
        // If validation fails we keep going without the override — the log
        // makes it visible so the user can fix it in the UI.
        console.warn(`[chat] resolveAgentSettings failed: ${(err as Error).message}`);
      }

      const callbacks = {
        signal: entry.abortController.signal,
        onText: (fullText: string) => {
          entry.currentText = fullText;
          broadcastToListeners(entry, 'message_delta', { text: fullText, messageId: assistantMsgId });
        },
        onThinking: (thinking: string) => {
          entry.currentThinking = thinking;
          broadcastToListeners(entry, 'thinking', { text: thinking, messageId: assistantMsgId });
        },
        onToolStart: (tool: string, args: Record<string, unknown>, toolUseId: string) => {
          entry.pendingToolCalls.set(toolUseId, { tool, args, startMs: Date.now() });
          broadcastToListeners(entry, 'tool_start', { tool, args, toolUseId, tool_use_id: toolUseId });
        },
        onToolResult: (tool: string, resultData: Record<string, unknown>, toolUseId: string, durationMs: number) => {
          const pending = entry.pendingToolCalls.get(toolUseId);
          const record: ToolCallRecord = {
            tool,
            args: pending?.args ?? {},
            result: resultData,
            durationMs,
            timestamp: new Date(),
            toolUseId,
          };
          entry.toolCalls.push(record);
          entry.pendingToolCalls.delete(toolUseId);
          broadcastToListeners(entry, 'tool_result', { tool, args: record.args, result: resultData, toolUseId, tool_use_id: toolUseId, durationMs });
          const userReport = isReportToUserTool(tool) ? reportToUserPayload(resultData) : null;
          if (userReport) {
            broadcastToListeners(entry, 'agent_report', {
              agent: effectiveAgent ?? 'assistant',
              message: userReport.message,
              status: userReport.status,
              timestamp: new Date().toISOString(),
            });
          }
          if (hasToolError(resultData)) {
            new MonitoringService(this.db).handleEvent({
              sourceType: 'tool_call',
              sourceId: toolUseId ?? `${sessionId}:${tool}`,
              title: `Chat tool call issue: ${tool}`,
              error: typeof resultData === 'string' ? resultData : JSON.stringify(resultData).slice(0, 1000),
              rootCauseArea: 'tool_integration',
              severity: 'medium',
              confidence: 0.72,
              failureMode: 'chat_tool_result_error',
              relatedIds: { chatSessionId: sessionId, chatMessageId: assistantMsgId, tool },
            }).catch(() => {});
          }
        },
        onSessionId: (sid: string) => {
          // Save session ID to DB immediately so auto-retry can resume even if the process times out
          this.sessions.updateOne(
            { _id: new ObjectId(sessionId) },
            { $set: { llmSessionId: sid } },
          ).catch(() => {});
        },
      };

      const effectiveProvider = (resolvedSettings?.provider as ChatProvider) ?? provider;
      const effectiveModel = resolvedSettings?.model || model || PROVIDERS.find(p => p.provider === effectiveProvider)?.defaultModel || 'gpt-5.5';
      const codexSlashCommand = effectiveProvider === 'codex'
        ? resolveSlashCommand(content, listSlashCommands('codex', workspaceCwd))
        : null;

      const result = codexSlashCommand
        ? {
            ...(await runPersistentCodexSlashCommand({
              db: this.db,
              chatSessionId: sessionId,
              provider: 'codex',
              model: effectiveModel,
              resolvedSettings,
              systemPrompt,
              messages: llmMessages,
              resumeSessionId: hasSessionResume ? resumeSessionId : undefined,
              skipTools: undefined,
              cwd: workspaceCwd,
              callbacks,
            }, codexSlashCommand)),
            durationMs: Date.now() - startMs,
            model: effectiveModel,
            provider: effectiveProvider,
          }
        : await runChatLLM(this.db, {
            provider: effectiveProvider,
            model: effectiveModel,
            resolvedSettings,
            systemPrompt,
            messages: llmMessages,
            resumeSessionId: hasSessionResume ? resumeSessionId : undefined,
            cwd: workspaceCwd,
            // Forwarded down to the Allen MCP subprocess as
            // ALLEN_ARTIFACT_ROOT_TYPE=chat / ALLEN_ARTIFACT_ROOT_ID=<sessionId>
            // so allen_save_artifact files under this chat session.
            chatSessionId: sessionId,
            ...callbacks,
          });

      clearInterval(saveInterval);
      const durationMs = Date.now() - startMs;
      const costUsd = result.costUsd;

      await this.messages.updateOne(
        { _id: new ObjectId(assistantMsgId) },
        { $set: { content: result.text, status: 'completed', costUsd, durationMs, toolCalls: entry.toolCalls, thinkingText: entry.currentThinking, completedAt: new Date() } },
      );

      // Save execution trace to chat_logs (fire-and-forget)
      this.db.collection('chat_logs').insertOne({
        sessionId,
        messageId: assistantMsgId,
        llmSessionId: result.sessionId,
        userMessage: content,
        assistantResponse: result.text.slice(0, 2000),
        model: result.model,
        costUsd,
        durationMs,
        toolCalls: entry.toolCalls,
        trace: result.trace,
        status: 'completed',
        timestamp: new Date(),
      }).catch(() => {});

      // Save llmSessionId for session resume on next message
      const sessionUpdate: Record<string, unknown> = { updatedAt: new Date() };
      if (result.sessionId) sessionUpdate.llmSessionId = result.sessionId;

      await this.sessions.updateOne(
        { _id: new ObjectId(sessionId) },
        { $set: sessionUpdate, $inc: { totalCostUsd: costUsd } },
      );

      broadcastToListeners(entry, 'message_complete', {
        messageId: assistantMsgId, text: result.text, costUsd, durationMs, toolCalls: entry.toolCalls, thinkingText: entry.currentThinking,
      });

      // Auto-title strategy: fire exactly once on turn 1, using only the
      // first turn's user message + assistant response. Skip if the user
      // manually set a title or if a title was already generated.
      // Note: sendMessage() inserts both messages and increments messageCount
      // by 2 BEFORE calling runLLM, then runLLM reloads the session. So at
      // this point a "first turn" session has messageCount === 2, not 0.
      const priorCount = (session?.messageCount as number) ?? 0;
      const prevSource = session?.titleSource;
      const shouldAutoTitle = priorCount <= 2 && prevSource !== 'user' && prevSource !== 'auto';

      if (shouldAutoTitle) {
        const responseText = result.text.trim() || undefined;
        const deterministicTitle = deterministicSessionTaskTitle(content);
        Promise.resolve(deterministicTitle ?? this.generateTitleWithLLM(content, responseText))
          .then(async (generatedTitle) => {
            if (generatedTitle) {
              await this.updateSessionTitle(sessionId, generatedTitle, 'auto');
              broadcastToListeners(entry, 'session_update', { title: generatedTitle });
            }
          })
          .catch((err) => console.error('Failed to generate session title', err.message));
      }
    } catch (error) {
      clearInterval(saveInterval);
      const errorMsg = error instanceof Error ? error.message : String(error);

      // If the user cancelled this turn (clicked Stop), the subprocess was
      // killed and we get an abort error. cancelChatSession already marked
      // the message as 'cancelled' and cleaned up — just return silently.
      // Do NOT overwrite the status to 'failed' or log it as an error.
      if (entry.aborted) {
        console.log(`[chat] Turn cancelled by user — skipping error handler`);
        // Auto-title even on abort — same turn-1-only rule as the success path.
        // priorCount counts post-bump (sendMessage already inserted both messages
        // and incremented before runLLM was invoked), so turn 1 reads as 2.
        const priorCount = (session?.messageCount as number) ?? 0;
        const prevSource = session?.titleSource;
        const shouldAutoTitleOnAbort = priorCount <= 2 && prevSource !== 'user' && prevSource !== 'auto';

        if (shouldAutoTitleOnAbort) {
          const deterministicTitle = deterministicSessionTaskTitle(content);
          Promise.resolve(deterministicTitle ?? this.generateTitleWithLLM(content, entry.currentText.trim() || undefined))
            .then(async (generatedTitle) => {
              if (generatedTitle) {
                await this.updateSessionTitle(sessionId, generatedTitle, 'auto');
                broadcastToListeners(entry, 'session_update', { title: generatedTitle });
              }
            })
            .catch(() => {});
        }
        return;
      }

      const isTimeout = errorMsg.toLowerCase().includes('timed out') || errorMsg.toLowerCase().includes('timeout');
      console.error('Chat LLM error:', errorMsg);

      // ── Fallback: resume failed after an interrupted turn ──
      // Codex returns "no rollout found" when the previous turn was killed
      // mid-execution. Claude CLI may return similar session-corruption
      // errors. In this case, clear the stale session ID and retry the
      // SAME message without resume — the agent starts a fresh thread but
      // the chat message history (stored in Mongo) is still intact for
      // the system prompt to reference.
      const isResumeFailed = /no rollout found|session.*not found|session.*expired|session.*invalid/i.test(errorMsg);
      const savedSessionId = (await this.sessions.findOne({ _id: new ObjectId(sessionId) }))?.llmSessionId as string | undefined;
      if (isResumeFailed && savedSessionId && retryCount < 1) {
        console.log(`[chat] Resume failed ("${errorMsg.slice(0, 60)}") — clearing stale session and retrying as fresh thread`);
        await this.sessions.updateOne(
          { _id: new ObjectId(sessionId) },
          { $unset: { llmSessionId: '' } },
        ).catch(() => {});
        // Retry the same message — runLLM will see no resumeSessionId and start fresh
        return this.runLLM(sessionId, assistantMsgId, content, entry, agent, retryCount + 1, cwd);
      }

      // Auto-retry on timeout: resume the session with "continue" prompt
      // This handles Codex/Claude CLI process timeouts during long delegations
      if (isTimeout && savedSessionId && retryCount < 3) {
        console.log(`[chat] Auto-retrying after timeout (attempt ${retryCount + 1}/3), resuming session ${savedSessionId.slice(0, 12)}...`);
        broadcastToListeners(entry, 'agent_report', {
          agent: effectiveAgent ?? 'assistant',
          message: 'Connection timed out — automatically reconnecting and continuing...',
          status: 'in_progress',
          timestamp: new Date().toISOString(),
        });

        // Re-run with "continue from where you left off" as the prompt
        try {
          const retryResult = await runChatLLM(this.db, {
            provider,
            model,
            systemPrompt: effectiveAgent
              ? await this.buildAgentSystemPrompt(effectiveAgent, provider, 'continue', sessionId)
              : await getSystemPrompt(provider, this.db, 'continue', { rootType: 'chat', rootId: sessionId, agentName: 'assistant' }),
            messages: [{ role: 'user', content: 'Continue from where you left off. Complete the delegation and provide the final response.' }],
            resumeSessionId: savedSessionId,
            // Same artifact-root context as the primary call above so a
            // mid-retry allen_save_artifact still files under this chat.
            chatSessionId: sessionId,
            onText: (fullText) => { entry.currentText = fullText; broadcastToListeners(entry, 'message_delta', { text: fullText, messageId: assistantMsgId }); },
            onThinking: (thinking) => {
              entry.currentThinking = thinking;
              broadcastToListeners(entry, 'thinking', { text: thinking, messageId: assistantMsgId });
            },
            onToolStart: (tool, args, toolUseId) => {
              entry.pendingToolCalls.set(toolUseId, { tool, args, startMs: Date.now() });
              broadcastToListeners(entry, 'tool_start', { tool, args, toolUseId, tool_use_id: toolUseId });
            },
            onToolResult: (tool, resultData, toolUseId, durationMs) => {
              const pending = entry.pendingToolCalls.get(toolUseId);
              const record = { tool, args: pending?.args ?? {}, result: resultData, durationMs, timestamp: new Date(), toolUseId };
              entry.toolCalls.push(record);
              entry.pendingToolCalls.delete(toolUseId);
              broadcastToListeners(entry, 'tool_result', { tool, args: record.args, result: resultData, toolUseId, tool_use_id: toolUseId, durationMs });
              const userReport = isReportToUserTool(tool) ? reportToUserPayload(resultData) : null;
              if (userReport) {
                broadcastToListeners(entry, 'agent_report', {
                  agent: effectiveAgent ?? 'assistant',
                  message: userReport.message,
                  status: userReport.status,
                  timestamp: new Date().toISOString(),
                });
              }
              if (hasToolError(resultData)) {
                new MonitoringService(this.db).handleEvent({
                  sourceType: 'tool_call',
                  sourceId: toolUseId ?? `${sessionId}:${tool}:retry`,
                  title: `Chat retry tool call issue: ${tool}`,
                  error: typeof resultData === 'string' ? resultData : JSON.stringify(resultData).slice(0, 1000),
                  rootCauseArea: 'tool_integration',
                  severity: 'medium',
                  confidence: 0.72,
                  failureMode: 'chat_retry_tool_result_error',
                  relatedIds: { chatSessionId: sessionId, chatMessageId: assistantMsgId, tool },
                }).catch(() => {});
              }
            },
            onSessionId: (sid) => {
              this.sessions.updateOne({ _id: new ObjectId(sessionId) }, { $set: { llmSessionId: sid } }).catch(() => {});
            },
          });

          // Save successful retry result
          const durationMs = Date.now() - startMs;
          await this.messages.updateOne(
            { _id: new ObjectId(assistantMsgId) },
            { $set: { content: retryResult.text, status: 'completed', costUsd: retryResult.costUsd, durationMs, toolCalls: entry.toolCalls, thinkingText: entry.currentThinking, completedAt: new Date() } },
          );
          if (retryResult.sessionId) {
            await this.sessions.updateOne({ _id: new ObjectId(sessionId) }, { $set: { llmSessionId: retryResult.sessionId } });
          }
          broadcastToListeners(entry, 'message_complete', { messageId: assistantMsgId, text: retryResult.text, costUsd: retryResult.costUsd, durationMs, toolCalls: entry.toolCalls, thinkingText: entry.currentThinking });
          return; // success — skip error handling below
        } catch (retryErr) {
          console.error('Auto-retry also failed:', retryErr instanceof Error ? retryErr.message : retryErr);
          // Fall through to normal error handling
        }
      }

      await this.messages.updateOne(
        { _id: new ObjectId(assistantMsgId) },
        { $set: { content: entry.currentText || '', status: 'failed', error: errorMsg, toolCalls: entry.toolCalls, thinkingText: entry.currentThinking, completedAt: new Date() } },
      );

      this.db.collection('chat_logs').insertOne({
        sessionId, messageId: assistantMsgId, userMessage: content,
        error: errorMsg, toolCalls: entry.toolCalls, status: 'failed',
        durationMs: Date.now() - startMs, timestamp: new Date(),
      }).catch(() => {});
      new MonitoringService(this.db).handleEvent({
        sourceType: 'chat',
        sourceId: assistantMsgId,
        title: 'Chat LLM error',
        error: errorMsg,
        rootCauseArea: isResumeFailed ? 'allen_repo' : 'unknown',
        severity: isTimeout ? 'medium' : 'high',
        confidence: isResumeFailed || isTimeout ? 0.78 : 0.68,
        failureMode: isTimeout ? 'chat_timeout' : 'chat_llm_error',
        relatedIds: { chatSessionId: sessionId, chatMessageId: assistantMsgId, agent: effectiveAgent },
      }).catch(() => {});

      broadcastToListeners(entry, 'error', { error: errorMsg, messageId: assistantMsgId });
      new AlertService(this.db).onChatError(sessionId, errorMsg).catch(() => {});
    } finally {
      // Wait for background delegations/spawns to finish before closing SSE stream
      // Cap at 30s for cleanup — if background tasks are still running after that,
      // they'll complete on their own but the SSE stream closes so UI isn't stuck
      await waitForBackgroundTasks(sessionId, 30_000);
      unregisterActiveSession(sessionId);
      for (const listener of entry.listeners) { try { detachHeartbeat(listener); listener.end(); } catch {} }
      activeQueries.delete(sessionId);
    }
  }

  /**
   * Build a system prompt for a team agent (PM, Engineer, QA, etc.).
   * Uses the agent's own system prompt + delegation capabilities.
   */
  private async buildAgentSystemPrompt(agentName: string, provider: string, userMessage: string, sessionId?: string): Promise<string> {
    const agentDoc = await this.db.collection('agents').findOne({ name: agentName });
    if (!agentDoc) {
      // Fallback to default if agent not found
      return getSystemPrompt(provider as any, this.db, userMessage);
    }

    const system = (agentDoc.system as string) ?? '';
    const personality = (agentDoc.personality as string) ?? '';
    const displayName = (agentDoc.displayName as string) ?? agentName;
    const canTrigger = (agentDoc.canTrigger as string[]) ?? [];

    const parts = [
      `You are ${displayName} — a team agent in Allen.`,
      system,
    ];

    if (personality) parts.push(`\nPersonality: ${personality}`);

    // Inject the live org chart + description-rich delegation targets.
    // This replaces hand-written delegation lists in the agent's system prompt
    // so adding/renaming an agent only requires editing canDelegateTo.
    try {
      const orgBlock = await buildOrgContextBlock(this.db, {
        forAgent: agentName,
        includeFullChart: true,
        includeMeta: true,
        chartMode: 'summary',
      });
      if (orgBlock) parts.push(`\n${orgBlock}`);
    } catch {}

    if (canTrigger.length > 0) {
      parts.push(`You can trigger workflows: ${canTrigger.join(', ')} using run_workflow.`);
    }

    parts.push(`
DELEGATION FLOW:
1. delegate_to_agent(agent_name, task) → returns { conversation_id }
2. wait_for_delegation(conversation_id) → blocks up to 90s
   - "waiting": call wait_for_delegation again
   - "question": agent is asking YOU something → answer_delegator(conversation_id, answer) → wait_for_delegation again
   - "completed": done, read response
3. To follow up: delegate_to_agent(agent_name, follow_up) → reuses same conversation

ASKING THE USER:
- If you need info from the user, call ask_user(question). Blocks until user answers.
- Only use ask_user when NO agent can answer.

RULES:
1. You are an LLM routing agent. Decide from the user's intent whether to answer directly, inspect data with tools, delegate to a team/lead, spawn a specialist execution, or run an allowed workflow. Do not rely on a backend heuristic router.
2. When the user corrects you, silently call save_learning.
3. Allen Library skills are internal routing playbooks, distinct from Codex/Claude native runtime skills. In Allen chat, unqualified "skills" means Allen Library skills. For every non-trivial Allen-supported request, silently call list_skills first and use the full enabled skill metadata list (name, description, category, triggers, excludes, allowedRoutes, related workflows/agents, priority) to choose the right skill by user intent. Do not pick a skill only because search_skills ranked it highest; search_skills is only an optional hint after metadata review. After selecting the best skill from metadata, call get_skill for that skill before routing or answering. Do not load every skill body up front. Do not mention the selected skill name, skill id, or skill tool calls in user-facing responses unless the user explicitly asks.
4. Capability discovery before route selection: before proposing an execution route, inspect the available Allen workflows, specialized team leads/agents, and relevant external MCP tools that could do the job. Use list_workflows/get_workflow, list_teams/list_agents/get_team/get_agent, and any relevant external MCP discovery/list tools when available. Prefer the most specific workflow or specialized lead/agent that owns the end-to-end task; use raw external MCP tools directly only for simple tool-native queries/actions or as evidence for the selected route.
5. Intent clarity and confirmation: if the user intent, target repo/resource, scope, desired outcome, or best route is unclear, ask a concise clarifying question instead of guessing. Before starting execution that changes state or consumes a specialist/workflow run, present the selected route, short plan, required inputs, expected outputs, and risks/unknowns, then ask the user to confirm. Read-only answers and read-only data queries may proceed without confirmation after evidence is checked.
6. Route by intent:
   - Explicit user target wins when valid. If the user names a workflow, inspect it with get_workflow and run it with exact schema inputs. If the user names an agent/lead, use that agent unless the request is impossible for them.
   - Use delegate_to_agent for team leads, cross-team coordination, or when the user says assign/route/delegate/hand off.
   - Use spawn_agent for one-shot specialist execution, especially code inspection, implementation, review, testing, docs, or git operations.
   - Use run_workflow only for allowed repeatable multi-step processes that match the task and whose required input schema you can satisfy exactly.
   - Answer directly for normal conversation, explanations, behavior questions, brainstorming, and simple read-only questions unless live Allen data or repo inspection is needed. Give the direct answer first; do not use apology templates, synthetic issue labels, routing summaries, or workflow-style sections for normal answers.
7. For workflows: before every run_workflow call, inspect get_workflow and build input using only the exact parsed.input field names. Do not invent aliases or nested objects.
8. Workspace handling:
   - Direct specialist spawns for implementation/review/testing/docs/git need create_workspace first; pass the returned worktree_path as repo_path.
   - Workflows that already contain a create_workspace node should receive the registered repo_path and create their own isolated worktree.
   - Ask "Which repo?" only when code work is required and no repo/workspace context is available.
9. When wait_for_delegation returns "question", ANSWER IT via answer_delegator. Don't ignore your team's questions.
10. If you don't know the answer to an agent's question, call ask_user to ask the user.
11. NEVER respond to the user before ALL delegations are complete.
12. Use report_to_user for progress updates. When wait_for_execution or wait_for_delegation returns status="waiting" with progress_message or activity_summary, call report_to_user with a short human-readable update before waiting again. Pass activity_cursor back as activity_since on the next wait call so updates move forward instead of repeating old activity.
13. RESOURCE LINKS — every PR, ticket, issue, commit, uploaded file, artifact, or deploy you mention MUST be rendered as a clickable markdown link when a URL is available. Use html_url / permalink / publicUrl from the tool response verbatim for external resources; never invent external URLs. For Allen internal resources such as workflow runs, executions, agents, and chat threads, prefer a UI link when one is provided or the route is known with confidence; otherwise present readable names/statuses and include raw IDs only when useful. Do not expose URL/tool fallback reasoning to the user.
14. INTERRUPTED RERUNS — if this chat has interrupted/cancelled tasks and the user asks to rerun, retry, continue, or restart that work, ask whether to start fresh or resume the cancelled execution. Use resume_execution only after the user chooses resume.
15. ARTIFACTS — when you or a spawned agent produces a standalone document (plan, design, investigation notes, CSV results, JSON config, scratch output), save it via allen_save_artifact. Files are filed under this chat session and appear in the Artifacts panel. Prefer allen_save_artifact over upload_file for in-conversation deliverables — it renders inline (markdown/JSON/CSV) and is scoped to the chat. When spawning sub-agents, tell them to save their own work the same way.
16. Be concise and natural. Respond in markdown when it improves readability. Do not create artificial tracking IDs, issue IDs, labels, or codes unless the user asks for a tracked plan or the ID came from a real tool/resource.`);

    // Inject available repos so agent knows what exists
    try {
      const repos = await this.db.collection('repos').find({ status: 'active' }).toArray();
      if (repos.length > 0) {
        const repoList = repos.map((r: any) => `- ${r.name}: ${r.path} (${(r.detected?.language ?? []).join(', ')})`).join('\n');
        parts.push(`\n## Available Repositories\n${repoList}\nUser references repos with @repo-name. Only ask which repo if the task requires code changes and it's ambiguous.`);
      }
    } catch {}

    // Load learnings — agent-scoped + global
    try {
      // 1. Agent-specific learnings
      const agentLearnings = await this.db.collection('learnings')
        .find({ 'scope.level': 'agent', 'scope.agentName': agentName, status: 'active' })
        .sort({ confidence: -1, updatedAt: -1 })
        .limit(5)
        .toArray();

      // 2. Global learnings via embedding similarity
      const { searchSimilar } = await import('./embedding.service.js');
      const globalLearnings = await searchSimilar(this.db, userMessage, { limit: 5, threshold: 0.25 });

      const allLearnings = [
        ...agentLearnings.map(l => `- [${l.type}, ${displayName}] ${l.content}`),
        ...globalLearnings.map(l => `- [${l.type}, global] ${l.content}`),
      ];

      if (allLearnings.length > 0) {
        parts.push(`\n## Memory from past conversations\n${allLearnings.join('\n')}`);
      }
      if (sessionId) {
        await writeMemoryAudit(this.db, {
          rootType: 'chat',
          rootId: sessionId,
          agentName,
          query: userMessage,
          retrievedLearningIds: [
            ...agentLearnings.map(learningId).filter((id): id is string => Boolean(id)),
            ...globalLearnings.map(learningId).filter((id): id is string => Boolean(id)),
          ],
          retrievalScores: globalLearnings.map((l) => l.score),
          injectedLearningIds: [
            ...agentLearnings.map(learningId).filter((id): id is string => Boolean(id)),
            ...globalLearnings.map(learningId).filter((id): id is string => Boolean(id)),
          ],
          injectedTokenCount: Math.ceil(allLearnings.join(' ').split(/\s+/).length * 1.3),
          promptContextHash: Buffer.from(`${agentName}:${userMessage}`).toString('base64').slice(0, 64),
        });
      }
    } catch {}

    return parts.join('\n');
  }

  /**
   * Append a message authored by the automation system to an existing chat session.
   * Used by the daily-status-prep (and future automation) agents to post their
   * generated content into a persistent linked chat thread.
   *
   * Called from POST /api/chat/sessions/:id/automation-message (internal endpoint,
   * token minted by buildInternalApiHeaders in cron.service.ts).
   */
  async appendAutomationMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<{ messageId: string }> {
    // Validate role
    if (!role || !['user', 'assistant'].includes(role)) {
      throw new Error('role must be one of: user, assistant');
    }
    // Validate content
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('content is required');
    }
    if (content.length > 1_000_000) {
      throw new Error('content exceeds maximum length');
    }

    let objectId: ObjectId;
    try {
      objectId = new ObjectId(sessionId);
    } catch {
      throw new Error('Session not found');
    }

    const session = await this.sessions.findOne({ _id: objectId });
    if (!session) {
      throw new Error('Session not found');
    }
    if ((session as Record<string, unknown>).source !== 'automation') {
      throw new Error('Not an automation session');
    }

    const now = new Date();
    const result = await this.messages.insertOne({
      sessionId,
      role,
      content,
      status: 'completed',
      senderSource: 'system',
      createdAt: now,
      completedAt: now,
    });

    await this.sessions.updateOne(
      { _id: objectId },
      {
        $inc: { messageCount: 1 },
        $set: { lastMessageAt: now, updatedAt: now },
      },
    );

    return { messageId: result.insertedId.toHexString() };
  }

  async updateSessionTitle(sessionId: string, title: string, titleSource: 'default' | 'auto' | 'user' = 'user'): Promise<void> {
    const safeTitle = titleSource === 'user'
      ? (sanitizeChatTitle(title) ?? 'New Conversation')
      : (sanitizeChatTitle(title) ?? fallbackTitleFromUserMessage(title));
    await this.sessions.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { title: safeTitle, titleSource, updatedAt: new Date() } }
    );
  }

  async updateSession(
    id: string,
    update: {
      title?: string;
      status?: 'active' | 'archived';
      provider?: string;
      model?: string;
      agentOverrides?: Record<string, unknown> | null;
    },
  ): Promise<ChatSession | null> {
    // Only whitelist known fields so clients can't smuggle arbitrary keys in.
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (update.title !== undefined) {
      set.title = sanitizeChatTitle(update.title) ?? 'New Conversation';
      set.titleSource = 'user';
    }
    if (update.status !== undefined) set.status = update.status;
    if (update.provider !== undefined) set.provider = update.provider;
    if (update.model !== undefined) set.model = update.model;
    if (update.agentOverrides !== undefined) set.agentOverrides = update.agentOverrides;
    await this.sessions.updateOne({ _id: new ObjectId(id) }, { $set: set });
    return this.sessions.findOne({ _id: new ObjectId(id) }) as Promise<ChatSession | null>;
  }

  async deleteSession(id: string): Promise<void> {
    await this.messages.deleteMany({ sessionId: id });
    await this.sessions.deleteOne({ _id: new ObjectId(id) });
  }
}

/**
 * Idempotent startup migration. For sessions missing ownerUserId, derive the
 * owner from the session's earliest user message (the same heuristic the old
 * read-side $lookup used). Run once at boot — sessions created after this
 * change get ownerUserId set inline in createSession().
 *
 * Uses only plain find/update calls so it works on Amazon DocumentDB, which
 * doesn't support $lookup with let+pipeline combining $expr and a field match.
 */
export async function backfillSessionOwners(db: Db): Promise<{ scanned: number; updated: number }> {
  const sessions = db.collection('chat_sessions');
  const messages = db.collection('chat_messages');
  const cursor = sessions.find(
    { ownerUserId: { $exists: false } },
    { projection: { _id: 1 } },
  );
  let scanned = 0;
  let updated = 0;
  for await (const s of cursor) {
    scanned++;
    const sid = String(s._id);
    const firstUserMsg = await messages.findOne(
      { sessionId: sid, role: 'user' },
      { sort: { createdAt: 1 }, projection: { senderUserId: 1, senderName: 1, senderEmail: 1 } },
    );
    const set: Record<string, unknown> = {
      ownerUserId: firstUserMsg?.senderUserId ?? null,
      ownerName: firstUserMsg?.senderName ?? null,
      ownerEmail: firstUserMsg?.senderEmail ?? null,
    };
    await sessions.updateOne({ _id: s._id }, { $set: set });
    updated++;
  }
  return { scanned, updated };
}
