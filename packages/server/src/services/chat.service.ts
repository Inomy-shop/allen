/**
 * Chat Service
 * Manages chat sessions with tool-calling via Claude Code SDK (no API key needed).
 * Phase 3-4: Workflow execution + agent spawning
 * Phase 5-6: Database queries, debugging, dashboard stats
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { Response } from 'express';
import { runChatLLM, type ChatLLMMessage, type ChatProvider } from './chat-llm.js';
import { getDefaultChatProvider, getProvidersInDefaultOrder } from './chat-providers.js';
import { resolveAgentSettings, type AgentLike, type AgentOverrides, type ResolvedSettings } from './agent-settings.js';
import { AlertService } from './alert.service.js';
import { registerActiveSession, unregisterActiveSession, waitForBackgroundTasks } from './chat-tools.js';
import { searchSimilar, backfillEmbeddings } from './embedding.service.js';
import { buildOrgContextBlock } from './org-context.js';
import { MonitoringService } from './self-healing-monitor.service.js';
import { ExecutionService } from './execution.service.js';
import { LinearService } from './linear.service.js';
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
  source?: 'ui' | 'slack';
  slackContext?: SlackContext;
  repoId?: string;     // ObjectId string referencing repos collection
  repoPath?: string;   // Snapshot of repo.path at session creation time
  repoName?: string;   // Snapshot of repo.name for UI display
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
  createdAt: Date;
  completedAt?: Date;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  durationMs: number;
  timestamp: Date;
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
      const results = await searchSimilar(db, userMessage, { limit: 10, threshold: 0.25 });
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
Be concise and technical. Use markdown. Always provide IDs for tracking.

═══ RESOURCE LINKS — HARD RULE ═══
Every time you reference an external resource in your response, render it as a clickable markdown link. NEVER just quote an ID or name — always make it clickable. This applies to:

- **Pull requests / MRs** → \`[#123 — Fix login race](https://github.com/org/repo/pull/123)\`. Use the \`html_url\` field from the GitHub MCP / \`gh\` response; never invent a URL.
- **GitHub / Linear / Jira issues and tickets** → \`[LIN-456 — Add billing guardrails](https://linear.app/workspace/issue/LIN-456)\`. Pull the exact URL from the tool response; don't reconstruct it by hand.
- **Uploaded files** (anything you created via \`upload_file\`) → \`[deployment-plan.md](<publicUrl>)\`. The \`upload_file\` tool returns a \`publicUrl\` that is viewable without login — use that URL verbatim. Never paste the raw file contents when a link will do.
- **Artifacts** (anything you created via \`allen_save_artifact\`) → \`[plan.md](<publicUrl>)\`. PREFER \`allen_save_artifact\` over \`upload_file\` when the file belongs to this conversation — plans, designs, query result CSVs, config JSON, investigation notes. Artifacts appear in the chat's Artifacts panel, are filed under this session, auto-render in the UI (markdown / JSON / CSV / text), and can be listed later with \`allen_list_artifacts\`. Use \`upload_file\` only for one-off shares destined for Slack / email / outside the chat. When spawning sub-agents via \`spawn_agent\`, remind them to save their own work the same way — their artifacts inherit this chat as the root.
- **Workflow runs, executions, agents, chat threads** → link to the Allen UI route for that resource when you know it.
- **Slack messages, commits, CI runs, deploy URLs, dashboards** → always link, never just name.

If a tool call returned an object but no URL is visible to you, ASK the tool result for one (\`html_url\`, \`permalink\`, \`url\`, \`publicUrl\`) before giving up. Only as a last resort fall back to the bare ID — and say why the link is missing.

Listing multiple resources? Render as a bulleted list of links, one per line, so the user can scan and click directly. Never hide a link behind prose like "I've opened a PR for this" with no link attached.

IMPORTANT RULES:
1. You are the routing brain. Decide from the user's intent whether to answer directly, inspect data with tools, run a workflow, spawn a single specialist, or involve a lead/team agent. Do not rely on a backend heuristic router.
2. When the user corrects you or states a preference ("no, use staging DB", "always run tests first", "I prefer TypeScript"), silently call save_learning to remember it. Write it as a generalized rule. Don't tell the user you're saving — just do it.
3. Normal conversation stays normal. If the user says "hi", asks a general question, brainstorms, or asks for an explanation, answer directly unless live Allen data is needed.
4. When the user asks to assign, run, work on, fix, implement, review, investigate, create, update, revamp, redesign, or otherwise execute a task, route it yourself:
   - First use list_workflows/list_agents/list_teams/list_repos as needed to understand available capabilities.
   - Route by task size and shape:
     • Tiny/single-file/single-specialty code fix → create/reuse a workspace, then spawn the best specialist directly.
     • Narrow bug investigation/fix with a clear failing behavior → prefer bug-investigate-and-fix if available; otherwise spawn bug-investigator or the relevant specialist.
     • Large feature, cross-cutting change, uncertain design, multiple specialists, or work that needs PRD/HLA/TDD/QA/review/PR creation → use feature-plan-and-implement if available.
     • Pure read-only investigation/explanation → answer directly or spawn a read-only specialist; do not run an implementation workflow.
   - Prefer the most specific specialized agent/workflow that can do the job. Do not use the largest workflow just because it exists.
   - WORKFLOW INPUT CONTRACT: before every run_workflow call, inspect the exact workflow input schema with get_workflow (or query_database on workflows.parsed.input if get_workflow is unavailable). Build the input using ONLY that workflow schema's field names. Do not invent aliases or nested shapes. If required fields are missing, ask the user or derive them from listed repo/ticket context before running.
   - If an available workflow clearly matches the request AND you can satisfy its required input schema exactly, use run_workflow.
   - If no workflow clearly fits and the work needs coordination across specialties, spawn the relevant team lead.
   - If the task is narrow and one specialist is clearly best, spawn that specialist directly.
   - When the user asks for a specific @agent, use spawn_agent for that agent, not run_workflow.
5. Workspace-first rule for code work: if the task may change code, create or reuse an Allen workspace before run_workflow/spawn_agent. Use create_workspace with the selected repo, then pass the returned worktree_path/repo_path into the workflow input or spawn_agent. If there is no repo/workspace context, ask which repo to use before starting execution.
6. After starting a workflow (run_workflow) or spawning an agent (spawn_agent), monitor it to completion or until it is clearly still running. Keep calling wait_for_execution while useful. Present progress, human-input pauses, workspace links, PR links, artifacts, and final output with clickable links.
7. When the user selects a team agent (PM, Engineer, QA, etc.), that agent can use delegate_to_agent to involve other team members. The delegation creates a visible thread showing agent-to-agent collaboration.
8. Use report_to_user for progress updates during long-running work so the user knows what is happening. When wait_for_execution or wait_for_delegation returns status="waiting" with progress_message or activity_summary, call report_to_user with a short human-readable update before waiting again. Pass activity_cursor back as activity_since on the next wait call so updates move forward instead of repeating old activity.
9. Ask confirmation only when the user's intent to perform a destructive action is ambiguous. If the user explicitly says to assign/run/work on/fix/implement/review a task, treat that as permission to start the appropriate workflow/agent after satisfying workspace-first requirements.
10. Interrupted reruns: if this chat has interrupted/cancelled tasks and the user asks to rerun, retry, continue, or restart that work, do NOT automatically start work. Ask whether they want a fresh start or to resume the cancelled execution. If they choose resume, use resume_execution. If they choose fresh start, run_workflow/spawn_agent again with the current request.
11. Always surface resource links per the "Resource Links" rule above — this is non-negotiable for PRs, tickets, uploads, and deployments.

═══ TEAM BUILDER ROUTING ═══
Allen has a "meta team" of builder agents that can extend the org chart on demand. You SHOULD route the user to them when they ask to grow the system itself:

A. **Building a NEW team** — phrases like:
   • "build me a finance team"
   • "create a marketing team"
   • "set up a data science team"
   • "I want a [domain] team"
   → Call delegate_to_agent("team-builder-agent", "<the user's request verbatim>")
   → Then call wait_for_delegation(conversation_id) and keep polling until done.
   → The team-builder-agent will research the domain, design the structure, ASK YOU to confirm, then create it.
   → When team-builder-agent asks a confirmation question (via ask_delegator), forward it to the user via ask_user with the EXACT blueprint they sent — don't summarize. The user must approve the actual structure.

B. **Adding an agent to an EXISTING team** — phrases like:
   • "add a tax specialist to the finance team"
   • "I need an SRE in the engineering team"
   • "add a content writer to marketing"
   → Call delegate_to_agent("agent-builder-agent", "<the user's request verbatim>")
   → Same polling + confirmation forwarding rules as above.

C. **Listing the org chart** — phrases like "what teams do we have", "show me the org chart":
   → Call delegate_to_agent("team-builder-agent", "list current teams") OR just call list_teams / list_agents directly. Either is fine.

NOTE: For A and B, routing to the builder agents provides a richer experience (research, blueprinting, user confirmation). If you have the meta tools (create_team, create_agent, etc.) available directly, you may also call them yourself — the tools no longer require routing through a builder agent.

DO NOT route to team-builder for unrelated requests (running workflows, querying executions, debugging code, etc.) — only when the user explicitly wants to extend the team/agent structure.${learningsBlock}`;

  // Inject the live org chart so the assistant knows who to spawn/delegate to.
  let orgBlock = '';
  try {
    const chart = await buildOrgContextBlock(db, { includeFullChart: true, includeMeta: true });
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
- list_workflows, get_workflow, list_executions, wait_for_execution
- list_agents, get_agent, list_repos
- get_dashboard_stats, search_executions, get_node_trace, get_execution_logs
- run_workflow, spawn_agent, delegate_to_agent, wait_for_delegation
- allen_save_artifact, allen_list_artifacts, allen_get_artifact, upload_file
- submit_execution_input, ask_user, ask_delegator, answer_delegator

Other MCP servers (Linear, GitHub, etc.) are also available when configured.

Examples:
- "What workflows do I have?" → list_workflows
- "Show me linear tickets" → linear_search_issues
- "Check execution abc123" → wait_for_execution(execution_id="abc123")
- "List my agents" → list_agents
- "What happened in my last run?" → list_executions then get_execution_logs / get_node_trace
- "Show me dashboard stats" → get_dashboard_stats
- "Find failed executions today" → search_executions
- "Hi" → answer directly; do not run a workflow or spawn an agent
- "Review code in @my-repo" → create_workspace for @my-repo, then spawn_agent with the returned worktree_path
- "Work on LIN-123" → inspect the ticket via Linear if available, decide workflow vs lead vs specialist by task size/specialty, inspect the chosen workflow schema with get_workflow before run_workflow, then start execution with exact input keys
- If an execution is waiting for input → present the fields, then submit_execution_input

For code tasks: create or reuse an Allen workspace before any code-changing workflow/agent. For read-only planning or explanation, answer directly or use read-only tools. Remind any sub-agent you spawn to save its deliverables via allen_save_artifact so they appear in this chat's Artifacts panel.${orgBlock}${reposBlock}`;
}

// ── Active Query Tracking ──

interface ActiveQuery {
  sessionId: string;
  messageId: string;
  currentText: string;
  toolCalls: ToolCallRecord[];
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

function titleLooksLikeAssistantReply(title: string): boolean {
  return /^(i\s+(need|don'?t|cannot|can'?t|understand|appreciate|see|can|am)|based on|could you|please clarify|here'?s|the concise title|generate a concise title)\b/i.test(title)
    || /\b(clarify|need more context|don't have access|i can help|i notice|you(?:'re| are) asking me)\b/i.test(title);
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
    .replace(/https?:\/\/\S+/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\b(can you|could you|please|do one thing|i want to|we need to)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitizeChatTitle(cleaned) ?? 'New conversation';
}

export function normalizeGeneratedChatTitle(candidate: unknown, userMessage: string): string {
  const title = sanitizeChatTitle(candidate);
  if (title && !titleLooksLikeAssistantReply(title)) return title;
  return fallbackTitleFromUserMessage(userMessage);
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
  for (const listener of entry.listeners) {
    try { listener.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { entry.listeners.delete(listener); }
  }
  for (const handler of entry.eventHandlers ?? []) {
    try { handler(event, data); } catch { entry.eventHandlers?.delete(handler); }
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
      createdAt: now, updatedAt: now,
    };
    const result = await this.sessions.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async listSessions(): Promise<ChatSession[]> {
    return this.sessions.find({}).sort({ lastMessageAt: -1 }).limit(100).toArray() as Promise<ChatSession[]>;
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

    const entry: ActiveQuery = { sessionId, messageId: assistantMsgId, currentText: '', toolCalls: [], listeners: new Set([res]), aborted: false, abortController: new AbortController() };
    activeQueries.set(sessionId, entry);
    res.on('close', () => { entry.listeners.delete(res); });

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
      sessionId, messageId: assistantMsgId, currentText: '', toolCalls: [],
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
      if (entry.currentText) sendSSE(res, 'message_delta', { text: entry.currentText, messageId: entry.messageId });
      entry.listeners.add(res);
      res.on('close', () => { entry.listeners.delete(res); });
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
   * Generate (or regenerate) a title for an existing session by fetching
   * its first user + assistant messages and running them through the LLM
   * title generator. Used by the manual backfill endpoint so operators can
   * fix sessions that were created before auto-title was implemented.
   *
   * Returns the generated title string, or null if the session doesn't have
   * both a user message and an assistant message yet.
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
   * Generate a concise, meaningful title for a conversation using the LLM.
   * Uses claude-haiku with no tools (fast, cheap). Falls back to string truncation.
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
- Return ONLY the title — no quotes, no trailing punctuation, no explanation

Good examples:
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
- Return ONLY the title — no quotes, no trailing punctuation, no explanation

Good examples:
- Fix visual search failure in image embeddings
- Review Allen chat productivity gaps
- Find extraction and transformation prompts
- Add authentication to the dashboard API
- Debug slow query in product search

User: ${userMessage.slice(0, 500)}`;

    try {
      const result = await runChatLLM(this.db, {
        provider: 'claude-cli',
        model: 'haiku',
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        skipTools: true,
        onText: () => {},
        onToolStart: () => {},
        onToolResult: () => {},
      });
      const raw = result.text.trim();
      if (raw.length > 0) {
        return normalizeGeneratedChatTitle(raw, userMessage);
      }
    } catch (err) {
      console.error('LLM title generation failed:', err instanceof Error ? err.message : err);
    }

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
          { $set: { content: entry.currentText, toolCalls: entry.toolCalls } },
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

      const result = await runChatLLM(this.db, {
        provider: (resolvedSettings?.provider as ChatProvider) ?? provider,
        model: resolvedSettings?.model || model,
        resolvedSettings,
        systemPrompt,
        messages: llmMessages,
        resumeSessionId: hasSessionResume ? resumeSessionId : undefined,
        cwd: workspaceCwd,
        // Forwarded down to the Allen MCP subprocess as
        // ALLEN_ARTIFACT_ROOT_TYPE=chat / ALLEN_ARTIFACT_ROOT_ID=<sessionId>
        // so allen_save_artifact files under this chat session.
        chatSessionId: sessionId,
        signal: entry.abortController.signal,
        onText: (fullText) => {
          entry.currentText = fullText;
          broadcastToListeners(entry, 'message_delta', { text: fullText, messageId: assistantMsgId });
        },
        onThinking: (thinking) => {
          broadcastToListeners(entry, 'thinking', { text: thinking, messageId: assistantMsgId });
        },
        onToolStart: (tool, args, toolUseId) => {
          broadcastToListeners(entry, 'tool_start', { tool, args, tool_use_id: toolUseId });
        },
        onToolResult: (tool, resultData, toolUseId, durationMs) => {
          const record: ToolCallRecord = { tool, args: {}, result: resultData, durationMs, timestamp: new Date() };
          entry.toolCalls.push(record);
          broadcastToListeners(entry, 'tool_result', { tool, result: resultData, tool_use_id: toolUseId, durationMs });
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
        onSessionId: (sid) => {
          // Save session ID to DB immediately so auto-retry can resume even if the process times out
          this.sessions.updateOne(
            { _id: new ObjectId(sessionId) },
            { $set: { llmSessionId: sid } },
          ).catch(() => {});
        },
      });

      clearInterval(saveInterval);
      const durationMs = Date.now() - startMs;
      const costUsd = result.costUsd;

      await this.messages.updateOne(
        { _id: new ObjectId(assistantMsgId) },
        { $set: { content: result.text, status: 'completed', costUsd, durationMs, toolCalls: entry.toolCalls, completedAt: new Date() } },
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
        messageId: assistantMsgId, text: result.text, costUsd, durationMs, toolCalls: entry.toolCalls,
      });

      // Auto-generate title for the session after first response (or when aborted)
      // Guard: only retitle when source is 'default' or 'auto', and within the first 2 turns.
      // Do NOT retitle after the user has explicitly set a title ('user' source).
      const shouldAutoTitle =
        (session?.titleSource === 'default' || session?.titleSource === 'auto' || !session?.titleSource) &&
        ((session?.messageCount as number) ?? 0) <= 4;

      if (shouldAutoTitle) {
        // assistantContent may be empty if the user aborted — that's fine, we pass undefined
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
        // Auto-title even on abort — use whatever partial text exists (or just the user message).
        const shouldAutoTitleOnAbort =
          (session?.titleSource === 'default' || session?.titleSource === 'auto' || !session?.titleSource) &&
          ((session?.messageCount as number) ?? 0) <= 4;
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
            onThinking: (thinking) => { broadcastToListeners(entry, 'thinking', { text: thinking, messageId: assistantMsgId }); },
            onToolStart: (tool, args, toolUseId) => { broadcastToListeners(entry, 'tool_start', { tool, args, tool_use_id: toolUseId }); },
            onToolResult: (tool, resultData, toolUseId, durationMs) => {
              entry.toolCalls.push({ tool, args: {}, result: resultData, durationMs, timestamp: new Date() });
              broadcastToListeners(entry, 'tool_result', { tool, result: resultData, tool_use_id: toolUseId, durationMs });
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
            { $set: { content: retryResult.text, status: 'completed', costUsd: retryResult.costUsd, durationMs, toolCalls: entry.toolCalls, completedAt: new Date() } },
          );
          if (retryResult.sessionId) {
            await this.sessions.updateOne({ _id: new ObjectId(sessionId) }, { $set: { llmSessionId: retryResult.sessionId } });
          }
          broadcastToListeners(entry, 'message_complete', { messageId: assistantMsgId, text: retryResult.text, costUsd: retryResult.costUsd, durationMs, toolCalls: entry.toolCalls });
          return; // success — skip error handling below
        } catch (retryErr) {
          console.error('Auto-retry also failed:', retryErr instanceof Error ? retryErr.message : retryErr);
          // Fall through to normal error handling
        }
      }

      await this.messages.updateOne(
        { _id: new ObjectId(assistantMsgId) },
        { $set: { content: entry.currentText || '', status: 'failed', error: errorMsg, toolCalls: entry.toolCalls, completedAt: new Date() } },
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
      for (const listener of entry.listeners) { try { listener.end(); } catch {} }
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
1. You are an LLM routing agent. Decide from the user's intent whether to answer directly, delegate, spawn a specialist, or run an allowed workflow. Do not rely on a backend heuristic router.
2. When the user corrects you, silently call save_learning.
3. Delegate to agents — don't do everything yourself.
4. When wait_for_delegation returns "question", ANSWER IT via answer_delegator. Don't ignore your team's questions.
5. If you don't know the answer to an agent's question, call ask_user to ask the user.
6. NEVER respond to the user before ALL delegations are complete.
7. Use report_to_user for progress updates. When wait_for_execution or wait_for_delegation returns status="waiting" with progress_message or activity_summary, call report_to_user with a short human-readable update before waiting again. Pass activity_cursor back as activity_since on the next wait call so updates move forward instead of repeating old activity.
8. Be concise. Respond in markdown.
9. Normal conversation stays normal. If the user greets you, asks an explanation, brainstorms, or asks a read-only question, answer directly unless live Allen data is needed.
10. For code-changing tasks, create or reuse an Allen workspace before delegating, spawning, or running a workflow. Use create_workspace with the selected repo and pass the returned worktree_path/repo_path to downstream agents/workflows. Ask "Which repo?" only when code work is required and no repo/workspace context is available.
11. Ask confirmation only when the user's intent to perform a destructive action is ambiguous. If the user explicitly asks to assign/run/work on/fix/implement/review a task, treat that as permission after workspace-first requirements are satisfied.
12. RESOURCE LINKS — every PR, ticket, issue, commit, uploaded file, workflow run, or deploy you mention MUST be rendered as a clickable markdown link. Use html_url / permalink / publicUrl from the tool response verbatim. Never just name a resource without linking it. For lists, one link per bullet so the user can scan and click directly. If a link is genuinely unavailable, say so rather than pasting a raw ID silently.
13. INTERRUPTED RERUNS — if this chat has interrupted/cancelled tasks and the user asks to rerun, retry, continue, or restart that work, ask whether to start fresh or resume the cancelled execution. Use resume_execution only after the user chooses resume.
14. ARTIFACTS — when you or a spawned agent produces a standalone document (plan, design, investigation notes, CSV results, JSON config, scratch output), save it via allen_save_artifact. Files are filed under this chat session and appear in the Artifacts panel. Prefer allen_save_artifact over upload_file for in-conversation deliverables — it renders inline (markdown/JSON/CSV) and is scoped to the chat. When spawning sub-agents, tell them to save their own work the same way.`);

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
