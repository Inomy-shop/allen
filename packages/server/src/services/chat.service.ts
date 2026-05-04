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

// ── SSE Helper ──

function sendSSE(res: Response, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* client disconnected */ }
}

// ── Mention Resolution ──

async function resolveMentions(content: string, db: Db): Promise<{ context: string; repoPath?: string }> {
  const mentionRegex = /@([\w-]+)/g;
  const matches = [...content.matchAll(mentionRegex)];
  if (matches.length === 0) return { context: '' };

  const names = [...new Set(matches.map(m => m[1]))];
  let context = '';
  let repoPath: string | undefined;

  for (const name of names) {
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
1. Before executing any destructive action (running workflows, cancelling executions, creating/editing/deleting tickets, spawning agents), tell the user what you're about to do and ask for confirmation. Read-only actions execute immediately.
2. When the user corrects you or states a preference ("no, use staging DB", "always run tests first", "I prefer TypeScript"), silently call save_learning to remember it. Write it as a generalized rule. Don't tell the user you're saving — just do it.
3. When the user asks to use a specific @agent — use spawn_agent (not run_workflow). spawn_agent runs a single agent with that agent's system prompt. run_workflow runs a full multi-node workflow.
4. After starting a workflow (run_workflow) or spawning an agent (spawn_agent), monitor it to completion. Keep calling wait_for_execution in a loop (with a few seconds between calls) until status is "completed" or "failed". Then present the final output. Do NOT stop after seeing "running" — wait for it to finish.
5. When the user selects a team agent (PM, Engineer, QA, etc.), that agent can use delegate_to_agent to involve other team members. The delegation creates a visible thread showing agent-to-agent collaboration.
6. Use report_to_user for progress updates during long delegations so the user knows what's happening.
7. Only ask "Which repo?" if the task clearly requires working with code (e.g. review, fix, investigate, build) AND the user hasn't specified one via @repo-name AND no workspace context is provided. For general questions, planning, brainstorming — just answer directly.
8. Always surface resource links per the "Resource Links" rule above — this is non-negotiable for PRs, tickets, uploads, and deployments.

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
- list_workflows, list_executions, wait_for_execution
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
- "Review code in @my-repo" → spawn_agent with the correct repo_path from the @mention
- If an execution is waiting for input → present the fields, then submit_execution_input

For code tasks (review, investigate, plan): use spawn_agent or run_workflow with the correct repo_path from @mentions. Remind any sub-agent you spawn to save its deliverables via allen_save_artifact so they appear in this chat's Artifacts panel.${orgBlock}${reposBlock}`;
}

// ── Active Query Tracking ──

interface ActiveQuery {
  sessionId: string;
  messageId: string;
  currentText: string;
  toolCalls: ToolCallRecord[];
  listeners: Set<Response>;
  aborted: boolean;
  /** Abort controller for the underlying LLM subprocess. Calling .abort()
   *  kills the claude-cli process (SIGTERM) and stops token generation.
   *  Without this, clicking "Stop" in the UI only closes the SSE connection
   *  but the agent keeps running in the background burning tokens. */
  abortController: AbortController;
}

const activeQueries = new Map<string, ActiveQuery>();

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
export async function cancelChatSession(sessionId: string, db?: Db): Promise<boolean> {
  const entry = activeQueries.get(sessionId);
  if (!entry) return false;

  // 1. Kill the subprocess for THIS turn only
  entry.aborted = true;
  entry.abortController.abort();

  // 2. DO NOT touch llmSessionId — the thread still exists on the
  //    provider's side. We just killed our local subprocess. The next
  //    message resumes the same thread with full prior context.

  // 3. Mark the in-flight assistant message as cancelled
  if (db) {
    const { ObjectId } = await import('mongodb');
    if (entry.messageId) {
      await db.collection('chat_messages').updateOne(
        { _id: new ObjectId(entry.messageId) },
        { $set: {
          status: 'cancelled',
          content: entry.currentText || '(cancelled by user)',
          completedAt: new Date(),
        } },
      ).catch(() => {});
    }
  }

  // 4. Broadcast cancel event so UI updates immediately
  broadcastToListeners(entry, 'cancelled', { messageId: entry.messageId });

  // 5. Remove from active queries so the user can send the next message
  activeQueries.delete(sessionId);

  return true;
}

function broadcastToListeners(entry: ActiveQuery, event: string, data: unknown): void {
  for (const listener of entry.listeners) {
    try { listener.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { entry.listeners.delete(listener); }
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

  async sendMessage(sessionId: string, content: string, res: Response, agent?: string, cwd?: string): Promise<void> {
    const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

    if (activeQueries.has(sessionId)) {
      res.status(409).json({ error: 'Session already has an active response' }); return;
    }

    const now = new Date();
    await this.messages.insertOne({ sessionId, role: 'user', content, status: 'completed', createdAt: now, completedAt: now });
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
  ): Promise<{ text: string; costUsd: number; durationMs: number }> {
    const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
    if (!session) throw new Error('Session not found');
    if (activeQueries.has(sessionId)) throw new Error('Session busy');

    const now = new Date();
    await this.messages.insertOne({
      sessionId, role: 'user', content, status: 'completed', createdAt: now, completedAt: now,
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
      ? `Generate a concise, descriptive title (4–8 words) for this conversation.

Rules:
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
      : `Generate a concise, descriptive title (4–8 words) for a conversation that starts with the following message.

Rules:
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
        const title = raw.replace(/^["']|["']$/g, '');
        return title.length > 0 ? title : userMessage.slice(0, 60);
      }
    } catch (err) {
      console.error('LLM title generation failed:', err instanceof Error ? err.message : err);
    }

    return userMessage.slice(0, 60);
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

      const allContext = [mentionContext, workspaceContext].filter(Boolean).join('\n');
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
        this.generateTitleWithLLM(content, responseText)
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
          this.generateTitleWithLLM(content, entry.currentText.trim() || undefined)
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
1. Before destructive actions, confirm with the user.
2. When the user corrects you, silently call save_learning.
3. Delegate to agents — don't do everything yourself.
4. When wait_for_delegation returns "question", ANSWER IT via answer_delegator. Don't ignore your team's questions.
5. If you don't know the answer to an agent's question, call ask_user to ask the user.
6. NEVER respond to the user before ALL delegations are complete.
7. Use report_to_user for progress updates.
8. Be concise. Respond in markdown.
9. Only ask "Which repo?" if the task clearly requires working with code AND the user hasn't specified one via @repo-name AND no workspace context is provided. For general questions, planning, brainstorming — just answer directly.
10. RESOURCE LINKS — every PR, ticket, issue, commit, uploaded file, workflow run, or deploy you mention MUST be rendered as a clickable markdown link. Use html_url / permalink / publicUrl from the tool response verbatim. Never just name a resource without linking it. For lists, one link per bullet so the user can scan and click directly. If a link is genuinely unavailable, say so rather than pasting a raw ID silently.
11. ARTIFACTS — when you or a spawned agent produces a standalone document (plan, design, investigation notes, CSV results, JSON config, scratch output), save it via allen_save_artifact. Files are filed under this chat session and appear in the Artifacts panel. Prefer allen_save_artifact over upload_file for in-conversation deliverables — it renders inline (markdown/JSON/CSV) and is scoped to the chat. When spawning sub-agents, tell them to save their own work the same way.`);

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
    await this.sessions.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { title, titleSource, updatedAt: new Date() } }
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
    if (update.title !== undefined) { set.title = update.title; set.titleSource = 'user'; }
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
