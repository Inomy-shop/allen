/**
 * Chat Service
 * Manages chat sessions with tool-calling via Claude Code SDK (no API key needed).
 * Phase 3-4: Workflow execution + role spawning
 * Phase 5-6: Database queries, debugging, dashboard stats
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { Response } from 'express';
import { runChatLLM, type ChatLLMMessage, type ChatProvider, PROVIDERS } from './chat-llm.js';
import { AlertService } from './alert.service.js';
import { registerActiveSession, unregisterActiveSession } from './chat-tools.js';
import { searchSimilar, backfillEmbeddings } from './embedding.service.js';
// Note: embedding.service.ts re-exports from @flowforge/engine — single implementation shared by engine + server

// ── Types ──

export interface ChatSession {
  _id?: ObjectId;
  title: string;
  status: 'active' | 'archived';
  messageCount: number;
  lastMessageAt: Date;
  totalCostUsd: number;
  provider: ChatProvider;
  model?: string;
  claudeSessionId?: string;
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

async function resolveMentions(content: string, db: Db): Promise<string> {
  const mentionRegex = /@([\w-]+)/g;
  const matches = [...content.matchAll(mentionRegex)];
  if (matches.length === 0) return '';

  const names = [...new Set(matches.map(m => m[1]))];
  let context = '';

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
      continue;
    }
    const agent = await db.collection('agents').findOne({ name });
    if (agent) {
      context += `\n[AGENT: ${name}] Provider: ${agent.provider ?? 'claude'}\nModel: ${agent.model ?? 'default'}\nTools: ${(agent.tools ?? []).join(', ')}\nSystem: ${(agent.system ?? '').slice(0, 200)}\n`;
    }
  }
  return context;
}

// ── System Prompt ──

const API_PORT = process.env.PORT ?? '4023';

/**
 * System prompt varies by provider:
 * - claude-cli: uses <tool_call> protocol (appended by chat-llm.ts)
 * - codex: uses bash + curl against local API
 * - gemini/anthropic-api: uses native function calling (tools registered at API level)
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
6. Use report_to_user for progress updates during long delegations so the user knows what's happening.${learningsBlock}`;

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

For code tasks (review, investigate, plan): use flowforge spawn_agent or run_workflow with the correct repo_path from @mentions.`;
  }

  // For claude-cli: tool instructions are appended by buildToolInstructions() in chat-llm.ts
  // For gemini/anthropic-api: tools are registered natively, just need guidance
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

For code tasks (review, investigate, plan): delegate to an agent via spawn_agent with the correct repo_path from @mentions.`;
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

  async createSession(provider: ChatProvider = 'codex', model?: string): Promise<ChatSession> {
    const now = new Date();
    const doc: ChatSession = {
      title: 'New Conversation', status: 'active', messageCount: 0,
      lastMessageAt: now, totalCostUsd: 0, provider, model,
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
  private async runLLM(sessionId: string, assistantMsgId: string, content: string, entry: ActiveQuery, agent?: string): Promise<void> {
    const saveInterval = setInterval(() => {
      if (entry.currentText) {
        this.messages.updateOne(
          { _id: new ObjectId(assistantMsgId) },
          { $set: { content: entry.currentText, toolCalls: entry.toolCalls } },
        ).catch(() => {});
      }
    }, 5000);

    const startMs = Date.now();

    // Register active session so delegation tools can find the session context
    registerActiveSession({
      chatSessionId: sessionId,
      parentMessageId: assistantMsgId,
      currentAgent: agent, // Team agent name or undefined for FlowForge Assistant
      delegationDepth: 0,
      broadcastEvent: (event, data) => broadcastToListeners(entry, event, data),
    });

    try {
      // Load session for provider config and resume
      const session = await this.sessions.findOne({ _id: new ObjectId(sessionId) });
      const provider = (session?.provider as ChatProvider) ?? 'codex';
      const model = session?.model as string | undefined;
      const previousAgent = (session?.activeAgent as string | undefined) ?? undefined;
      const agentChanged = (agent ?? undefined) !== previousAgent;
      // If agent changed, don't resume the CLI session — start fresh with new system prompt
      const resumeSessionId = agentChanged ? undefined : (session?.claudeSessionId as string | undefined);

      // Persist the active agent on the session so we can detect changes next message
      if (agentChanged) {
        await this.sessions.updateOne(
          { _id: new ObjectId(sessionId) },
          { $set: { activeAgent: agent ?? null, claudeSessionId: null } },
        );
      }

      // Resolve @mentions
      const mentionContext = await resolveMentions(content, this.db);
      const enrichedContent = mentionContext
        ? `CONTEXT FROM @MENTIONS:\n${mentionContext}\n\nUSER MESSAGE:\n${content}`
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
      if (agent) {
        systemPrompt = await this.buildAgentSystemPrompt(agent, provider, content);
      } else {
        systemPrompt = await getSystemPrompt(provider, this.db, content);
      }

      const result = await runChatLLM(this.db, {
        provider,
        model,
        systemPrompt,
        messages: llmMessages,
        resumeSessionId: hasSessionResume ? resumeSessionId : undefined,
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
        claudeSessionId: result.sessionId,
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

      // Save claudeSessionId for session resume on next message
      const sessionUpdate: Record<string, unknown> = { updatedAt: new Date() };
      if (result.sessionId) sessionUpdate.claudeSessionId = result.sessionId;

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
      console.error('Chat LLM error:', errorMsg);

      await this.messages.updateOne(
        { _id: new ObjectId(assistantMsgId) },
        { $set: { content: entry.currentText || '', status: 'failed', error: errorMsg, toolCalls: entry.toolCalls, completedAt: new Date() } },
      );

      // Save failed trace
      this.db.collection('chat_logs').insertOne({
        sessionId,
        messageId: assistantMsgId,
        userMessage: content,
        error: errorMsg,
        toolCalls: entry.toolCalls,
        status: 'failed',
        durationMs: Date.now() - startMs,
        timestamp: new Date(),
      }).catch(() => {});

      broadcastToListeners(entry, 'error', { error: errorMsg, messageId: assistantMsgId });

      // Fire alert
      new AlertService(this.db).onChatError(sessionId, errorMsg).catch(() => {});
    } finally {
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
      parts.push(`\nYou can delegate tasks to other agents: ${canDelegateTo.join(', ')}. Use the delegate_to_agent tool to involve them.`);
      parts.push(`MULTI-TURN DELEGATION: When you delegate, you get back a conversation_id. Use it to have follow-up conversations with the same agent — ask clarifying questions, request more detail, give feedback. Have a real back-and-forth conversation before synthesizing your response.`);
    }

    if (canTrigger.length > 0) {
      parts.push(`You can trigger these workflows: ${canTrigger.join(', ')} using the run_workflow tool.`);
    }

    parts.push(`
RULES:
1. Before destructive actions, confirm with the user.
2. When the user corrects you, silently call save_learning.
3. Use delegate_to_agent to involve other agents — don't try to do everything yourself.
4. Have MULTI-TURN conversations with agents you delegate to. Ask follow-ups, request detail, discuss approaches — just like you would with a real team member. Use the conversation_id to continue the thread.
5. Use report_to_user for progress updates during long operations.
6. Only respond to the user AFTER you've completed all agent conversations. The user should see the full thread, then your synthesis.
7. Be concise. Respond in markdown.`);

    // Load learnings
    try {
      const { searchSimilar } = await import('./embedding.service.js');
      const relevant = await searchSimilar(this.db, userMessage, { limit: 5, threshold: 0.25 });
      if (relevant.length > 0) {
        const items = relevant.map(l => `- [${l.type}] ${l.content}`).join('\n');
        parts.push(`\n## Memory\n${items}`);
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
