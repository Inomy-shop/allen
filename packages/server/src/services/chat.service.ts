/**
 * Chat Service
 * Manages chat sessions with tool-calling via Claude Code SDK (no API key needed).
 * Phase 3-4: Workflow execution + agent spawning
 * Phase 5-6: Database queries, debugging, dashboard stats
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { Response } from 'express';
import { runChatLLM, type ChatLLMMessage, type ChatProvider, PROVIDERS } from './chat-llm.js';
import { AlertService } from './alert.service.js';
import { registerActiveSession, unregisterActiveSession, waitForBackgroundTasks } from './chat-tools.js';
import { searchSimilar, backfillEmbeddings } from './embedding.service.js';
// Note: embedding.service.ts re-exports from @flowforge/engine — single implementation shared by engine + server

// ── Types ──

export interface SlackContext {
  channelId: string;
  threadTs: string;
  teamId: string;
}

export interface ChatSession {
  _id?: ObjectId;
  title: string;
  status: 'active' | 'archived';
  messageCount: number;
  lastMessageAt: Date;
  totalCostUsd: number;
  provider: ChatProvider;
  model?: string;
  llmSessionId?: string;
  source?: 'ui' | 'slack';
  slackContext?: SlackContext;
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
async function getSystemPrompt(provider: ChatProvider, db: Db, userMessage?: string): Promise<string> {
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
    }
  } catch (err) {
    console.error('\x1b[35m[embedding]\x1b[0m Failed to load learnings:', (err as Error).message);
  }

  const base = `You are FlowForge Assistant — the intelligent command center for the FlowForge workflow orchestration platform.
When users mention @workflow-name, @repo-name, or @agent-name, you receive context about those resources. Use this to answer or fill in parameters automatically.
Be concise and technical. Use markdown. Always provide IDs for tracking.

IMPORTANT RULES:
1. Before executing any destructive action (running workflows, cancelling executions, creating/editing/deleting tickets, spawning agents), tell the user what you're about to do and ask for confirmation. Read-only actions execute immediately.
2. When the user corrects you or states a preference ("no, use staging DB", "always run tests first", "I prefer TypeScript"), silently call save_learning to remember it. Write it as a generalized rule. Don't tell the user you're saving — just do it.
3. When the user asks to use a specific @agent — use spawn_agent (not run_workflow). spawn_agent runs a single agent with that agent's system prompt. run_workflow runs a full multi-node workflow.
4. After starting a workflow (run_workflow) or spawning an agent (spawn_agent), monitor it to completion. Keep calling get_execution in a loop (with a few seconds between calls) until status is "completed" or "failed". Then present the final output. Do NOT stop after seeing "running" — wait for it to finish.
5. When the user selects a team agent (PM, Engineer, QA, etc.), that agent can use delegate_to_agent to involve other team members. The delegation creates a visible thread showing agent-to-agent collaboration.
6. Use report_to_user for progress updates during long delegations so the user knows what's happening.
7. Only ask "Which repo?" if the task clearly requires working with code (e.g. review, fix, investigate, build) AND the user hasn't specified one via @repo-name AND no workspace context is provided. For general questions, planning, brainstorming — just answer directly.

═══ TEAM BUILDER ROUTING ═══
FlowForge has a "meta team" of builder agents that can extend the org chart on demand. You SHOULD route the user to them when they ask to grow the system itself:

A. **Building a NEW team** — phrases like:
   • "build me a finance team"
   • "create a marketing team"
   • "set up a data science team"
   • "I want a [domain] team"
   → Call delegate_to_agent("team-builder-agent", "<the user's request verbatim>")
   → Then call get_delegation_result(conversation_id) and keep polling until done.
   → The team-builder-agent will research the domain, design the structure, ASK YOU to confirm, then create it.
   → When team-builder-agent asks a confirmation question (via ask_caller), forward it to the user via ask_user with the EXACT blueprint they sent — don't summarize. The user must approve the actual structure.

B. **Adding an agent to an EXISTING team** — phrases like:
   • "add a tax specialist to the finance team"
   • "I need an SRE in the engineering team"
   • "add a content writer to marketing"
   → Call delegate_to_agent("agent-builder-agent", "<the user's request verbatim>")
   → Same polling + confirmation forwarding rules as above.

C. **Listing the org chart** — phrases like "what teams do we have", "show me the org chart":
   → Call delegate_to_agent("team-builder-agent", "list current teams") OR just call list_teams / list_agents directly. Either is fine.

CRITICAL: For A and B, route to the right builder. Don't try to create teams or agents yourself — you don't have create_team / create_agent tools. The builders do.

DO NOT route to team-builder for unrelated requests (running workflows, querying executions, debugging code, etc.) — only when the user explicitly wants to extend the team/agent structure.${learningsBlock}`;

  // Inject available repos
  let reposBlock = '';
  try {
    const repos = await db.collection('repos').find({ status: 'active' }).toArray();
    if (repos.length > 0) {
      reposBlock = `\n\nAvailable repos: ${repos.map((r: any) => `${r.name} (${r.path})`).join(', ')}. User references with @repo-name.`;
    }
  } catch {}

  if (provider === 'codex') {
    return `${base}

You have MCP tools available. Use them to get data — don't describe what you would do, actually call the tool.

Key MCP tools:
- flowforge: list_workflows, list_executions, get_execution, list_agents, list_repos, get_dashboard_stats, run_workflow, get_node_trace, get_execution_logs, submit_execution_input
- Other MCP servers (Linear, GitHub, etc.) are also available if configured

Examples:
- "What workflows do I have?" → call flowforge list_workflows
- "Show me linear tickets" → call linear linear_search_issues
- "Check execution abc123" → call flowforge get_execution with execution_id=abc123
- "List my agents" → call flowforge list_agents

For code tasks (review, investigate, plan): use flowforge spawn_agent or run_workflow with the correct repo_path from @mentions.${reposBlock}`;
  }

  // For claude-cli: tool instructions are appended by buildToolInstructions() in chat-llm.ts
  return `${base}

You have tools to interact with the system. When a user asks to run a workflow, check status, query data, or debug — use the appropriate tool. Don't describe what you would do; actually do it.

Examples:
- "What workflows do I have?" → use list_workflows
- "Check execution abc123" → use get_execution
- "What happened in my last run?" → use list_executions
- "Show me dashboard stats" → use get_dashboard_stats
- "Find failed executions today" → use search_executions_advanced
- "Review code in @my-repo" → use list_agents to find an agent, then spawn_agent with repo_path
- If an execution is waiting for input → present the fields, then use submit_execution_input

For code tasks (review, investigate, plan): delegate to an agent via spawn_agent with the correct repo_path from @mentions.${reposBlock}`;
}

// ── Active Query Tracking ──

interface ActiveQuery {
  sessionId: string;
  messageId: string;
  currentText: string;
  toolCalls: ToolCallRecord[];
  listeners: Set<Response>;
  aborted: boolean;
}

const activeQueries = new Map<string, ActiveQuery>();

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

  getProviders() { return PROVIDERS; }

  async createSession(
    provider: ChatProvider = 'codex',
    model?: string,
    source: 'ui' | 'slack' = 'ui',
    slackContext?: SlackContext,
  ): Promise<ChatSession> {
    const now = new Date();
    const doc: ChatSession = {
      title: 'New Conversation', status: 'active', messageCount: 0,
      lastMessageAt: now, totalCostUsd: 0, provider, model,
      source,
      ...(slackContext ? { slackContext } : {}),
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

  async sendMessage(sessionId: string, content: string, res: Response, agent?: string): Promise<void> {
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

    const entry: ActiveQuery = { sessionId, messageId: assistantMsgId, currentText: '', toolCalls: [], listeners: new Set([res]), aborted: false };
    activeQueries.set(sessionId, entry);
    res.on('close', () => { entry.listeners.delete(res); });

    this.runLLM(sessionId, assistantMsgId, content, entry, agent).catch(() => {});
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
      listeners: new Set(), aborted: false,
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
   * Run LLM via Anthropic Messages API with native tool calling.
   */
  private async runLLM(sessionId: string, assistantMsgId: string, content: string, entry: ActiveQuery, agent?: string, retryCount = 0): Promise<void> {
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
    const provider = (session?.provider as ChatProvider) ?? 'codex';
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

      // If no workspace linked, use @repo mention path as cwd
      if (!resolvedCwd && mentionRepoPath) {
        resolvedCwd = mentionRepoPath;
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
        systemPrompt = await this.buildAgentSystemPrompt(effectiveAgent, provider, content);
      } else {
        systemPrompt = await getSystemPrompt(provider, this.db, content);
      }

      // Inject workspace path constraint into system prompt
      if (resolvedCwd && resolvedCwd !== '/tmp/flowforge') {
        systemPrompt += `\n\nWORKSPACE CONSTRAINT:\nYour working directory is: ${resolvedCwd}\nCRITICAL: ALL file operations (Read, Write, Edit, Grep, Glob, Bash) MUST use paths within this directory.\n- Use relative paths or paths starting with "${resolvedCwd}/"\n- NEVER read, write, or modify files outside this directory\n- If search results show paths outside this directory, replace the base with "${resolvedCwd}/"`;
      }

      // Use already-resolved cwd (workspace path or @repo path)
      const workspaceCwd = resolvedCwd;

      const result = await runChatLLM(this.db, {
        provider,
        model,
        systemPrompt,
        messages: llmMessages,
        resumeSessionId: hasSessionResume ? resumeSessionId : undefined,
        cwd: workspaceCwd,
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

      // Auto-title on first response — extract from content, no LLM call
      const currentSession = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
      if (currentSession && (currentSession.title as string) === 'New Conversation') {
        try {
          // Generate title from user message + response without spawning another LLM
          let title = content.slice(0, 50).trim();
          // Clean up: capitalize first letter, remove trailing punctuation
          title = title.charAt(0).toUpperCase() + title.slice(1);
          title = title.replace(/[?.!,;:]+$/, '').trim();
          // If too short, append from response
          if (title.length < 10 && result.text) {
            const firstLine = result.text.split('\n').find(l => l.trim().length > 5)?.trim() ?? '';
            if (firstLine) title = firstLine.slice(0, 40).replace(/[#*_`]+/g, '').trim();
          }
          if (title.length > 50) title = title.slice(0, 47) + '...';

          if (title && title.length > 0) {
            await this.sessions.updateOne(
              { _id: new ObjectId(sessionId) },
              { $set: { title, updatedAt: new Date() } },
            );
            broadcastToListeners(entry, 'session_update', { title });
          }
        } catch (err) {
          console.error('Title generation failed:', err instanceof Error ? err.message : err);
        }
      }
    } catch (error) {
      clearInterval(saveInterval);
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMsg.toLowerCase().includes('timed out') || errorMsg.toLowerCase().includes('timeout');
      console.error('Chat LLM error:', errorMsg);

      // Auto-retry on timeout: resume the session with "continue" prompt
      // This handles Codex/Claude CLI process timeouts during long delegations
      const savedSessionId = (await this.sessions.findOne({ _id: new ObjectId(sessionId) }))?.llmSessionId as string | undefined;
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
              ? await this.buildAgentSystemPrompt(effectiveAgent, provider, 'continue')
              : await getSystemPrompt(provider, this.db, 'continue'),
            messages: [{ role: 'user', content: 'Continue from where you left off. Complete the delegation and provide the final response.' }],
            resumeSessionId: savedSessionId,
            onText: (fullText) => { entry.currentText = fullText; broadcastToListeners(entry, 'message_delta', { text: fullText, messageId: assistantMsgId }); },
            onThinking: (thinking) => { broadcastToListeners(entry, 'thinking', { text: thinking, messageId: assistantMsgId }); },
            onToolStart: (tool, args, toolUseId) => { broadcastToListeners(entry, 'tool_start', { tool, args, tool_use_id: toolUseId }); },
            onToolResult: (tool, resultData, toolUseId, durationMs) => {
              entry.toolCalls.push({ tool, args: {}, result: resultData, durationMs, timestamp: new Date() });
              broadcastToListeners(entry, 'tool_result', { tool, result: resultData, tool_use_id: toolUseId, durationMs });
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
  private async buildAgentSystemPrompt(agentName: string, provider: string, userMessage: string): Promise<string> {
    const agentDoc = await this.db.collection('agents').findOne({ name: agentName });
    if (!agentDoc) {
      // Fallback to default if agent not found
      return getSystemPrompt(provider as any, this.db, userMessage);
    }

    const system = (agentDoc.system as string) ?? '';
    const personality = (agentDoc.personality as string) ?? '';
    const displayName = (agentDoc.displayName as string) ?? agentName;
    const canDelegateTo = (agentDoc.canDelegateTo as string[]) ?? [];
    const canTrigger = (agentDoc.canTrigger as string[]) ?? [];

    const parts = [
      `You are ${displayName} — a team agent in FlowForge.`,
      system,
    ];

    if (personality) parts.push(`\nPersonality: ${personality}`);

    if (canDelegateTo.length > 0) {
      parts.push(`\nYou can delegate tasks to: ${canDelegateTo.join(', ')} using delegate_to_agent.`);
    }

    if (canTrigger.length > 0) {
      parts.push(`You can trigger workflows: ${canTrigger.join(', ')} using run_workflow.`);
    }

    parts.push(`
DELEGATION FLOW:
1. delegate_to_agent(agent_name, task) → returns { conversation_id }
2. get_delegation_result(conversation_id) → blocks up to 90s
   - "waiting": call get_delegation_result again
   - "question": agent is asking YOU something → answer_question(conversation_id, answer) → get_delegation_result again
   - "completed": done, read response
3. To follow up: delegate_to_agent(agent_name, follow_up) → reuses same conversation

ASKING THE USER:
- If you need info from the user, call ask_user(question). Blocks until user answers.
- Only use ask_user when NO agent can answer.

RULES:
1. Before destructive actions, confirm with the user.
2. When the user corrects you, silently call save_learning.
3. Delegate to agents — don't do everything yourself.
4. When get_delegation_result returns "question", ANSWER IT via answer_question. Don't ignore your team's questions.
5. If you don't know the answer to an agent's question, call ask_user to ask the user.
6. NEVER respond to the user before ALL delegations are complete.
7. Use report_to_user for progress updates.
8. Be concise. Respond in markdown.
9. Only ask "Which repo?" if the task clearly requires working with code AND the user hasn't specified one via @repo-name AND no workspace context is provided. For general questions, planning, brainstorming — just answer directly.`);

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
    } catch {}

    return parts.join('\n');
  }

  async updateSession(id: string, update: { title?: string; status?: 'active' | 'archived' }): Promise<ChatSession | null> {
    await this.sessions.updateOne({ _id: new ObjectId(id) }, { $set: { ...update, updatedAt: new Date() } });
    return this.sessions.findOne({ _id: new ObjectId(id) }) as Promise<ChatSession | null>;
  }

  async deleteSession(id: string): Promise<void> {
    await this.messages.deleteMany({ sessionId: id });
    await this.sessions.deleteOne({ _id: new ObjectId(id) });
  }
}
