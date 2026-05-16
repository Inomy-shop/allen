import { Router, type Request, type Response } from 'express';
import { param } from '../types.js';
import { logger } from '../logger.js';
import { ChatService, cancelChatSession, type ChatMessageSender } from '../services/chat.service.js';
import { executeChatTool } from '../services/chat-tools.js';
import { ExecutionService } from '../services/execution.service.js';
import { InterventionService } from '../services/intervention.service.js';
import { PullRequestService } from '../services/pull-request.service.js';
import { WorkspaceManager, type WorkspaceDiffMode } from '../services/workspace.service.js';
import { ObjectId, type Db } from 'mongodb';
import { UserService } from '../services/user.service.js';
import type { AuthedRequest } from '../middleware/requireAuth.js';
import { listSlashCommands, type SlashCommandProvider } from '../services/slash-commands.js';

// Simple in-memory rate limiter for the automation-message endpoint.
// Limits each authenticated caller (by sub) to 60 requests per minute.
const _automationMsgRateLimit = new Map<string, { count: number; windowStart: number }>();
const AUTOMATION_MSG_RATE_LIMIT = 60;
const AUTOMATION_MSG_RATE_WINDOW_MS = 60_000;

function checkAutomationMsgRateLimit(userId: string): boolean {
  const now = Date.now();
  // Evict stale entries (older than 2× the window) to prevent unbounded growth
  for (const [key, val] of _automationMsgRateLimit) {
    if (now - val.windowStart > 2 * AUTOMATION_MSG_RATE_WINDOW_MS) {
      _automationMsgRateLimit.delete(key);
    }
  }
  const entry = _automationMsgRateLimit.get(userId);
  if (!entry || now - entry.windowStart > AUTOMATION_MSG_RATE_WINDOW_MS) {
    _automationMsgRateLimit.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= AUTOMATION_MSG_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

export function chatRoutes(db: Db): Router {
  const router = Router();
  const chatService = new ChatService(db);
  const users = new UserService(db);
  const executionService = new ExecutionService(db);
  const interventionService = new InterventionService(db);
  const workspaceManager = new WorkspaceManager(db);

  const readSender = async (req: AuthedRequest): Promise<ChatMessageSender | undefined> => {
    const authUser = req.user;
    if (!authUser) return undefined;
    const user = await users.findById(authUser.sub);
    const email = user?.email ?? authUser.email;
    return {
      userId: authUser.sub,
      name: user?.name ?? email?.split('@')[0] ?? authUser.sub,
      email,
      source: 'ui',
    };
  };

  const submitChatAnswerToPendingWorkflow = async (
    sessionId: string,
    answer: string,
    answeredBy: string,
  ): Promise<Record<string, unknown> | null> => {
    const waitingExecutions = await db.collection('executions')
      .find({
        'meta.chatSessionId': sessionId,
        status: 'waiting_for_input',
      })
      .sort({ startedAt: -1 })
      .limit(5)
      .toArray();

    for (const exec of waitingExecutions) {
      const executionId = String(exec.id ?? '');
      if (!executionId) continue;
      const currentNodes = new Set(((exec.currentNodes as unknown[]) ?? []).filter(Boolean).map(String));
      const pending = (await interventionService.listForWorkflowRun(executionId))
        .filter((item) => item.status === 'pending')
        .filter((item) => currentNodes.size === 0 || currentNodes.has(item.stage))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const intervention = pending[0];
      if (!intervention) continue;

      // The chat answer box is free-form. Auto-submit only question-style
      // pauses; approval/escalation nodes need their structured buttons.
      if (intervention.severity !== 'question') {
        return {
          forwarded: false,
          reason: 'pending_intervention_requires_structured_decision',
          execution_id: executionId,
          intervention_id: intervention.intervention_id,
          severity: intervention.severity,
        };
      }

      const fields = ((intervention as unknown as { fields?: Array<{ name?: string }> }).fields ?? [])
        .filter((field): field is { name: string } => typeof field.name === 'string' && field.name.length > 0);
      const fieldName = fields[0]?.name ?? 'answer';
      const payload = { [fieldName]: answer };
      const delivered = await executionService.submitInput(executionId, intervention.stage, payload);
      if (!delivered) {
        return {
          forwarded: false,
          reason: 'workflow_engine_not_waiting_for_input',
          execution_id: executionId,
          intervention_id: intervention.intervention_id,
          node: intervention.stage,
        };
      }

      await interventionService.recordResponse(intervention.intervention_id, {
        decision: 'answer',
        answer: JSON.stringify(payload),
        answered_by_user_id: answeredBy,
      });
      await db.collection('executions').updateOne(
        { id: executionId },
        { $set: { status: 'running' } },
      );

      return {
        forwarded: true,
        execution_id: executionId,
        intervention_id: intervention.intervention_id,
        node: intervention.stage,
        field: fieldName,
      };
    }

    return null;
  };

  // POST /api/chat/sessions/:id/cancel — kill the running LLM subprocess
  // AND clear the stale session so the next message starts fresh. Acts as
  // an interrupt: after this call, the user can immediately send a new
  // message without hitting "session busy" or "no rollout found" errors.
  router.post('/sessions/:id/cancel', async (req: Request, res: Response) => {
    const sessionId = param(req, 'id');
    const result = await cancelChatSession(sessionId, db);
    res.json(result);
  });

  // Helper — pull the Allen MCP's x-allen-* context headers off an
  // incoming tool-dispatch request. The MCP subprocess sets these from
  // its own env (ALLEN_CHAT_SESSION_ID, etc.) so the server can route
  // tool calls to the exact chat / spawn context that spawned this MCP.
  // Missing headers are left unbound; chat-scoped tools must not borrow
  // another active chat's context.
  const readToolContext = (req: Request) => {
    const hdr = (name: string) => {
      const v = req.header(name);
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    };
    return {
      chatSessionId: hdr('x-allen-chat-session-id'),
      parentExecutionId: hdr('x-allen-parent-execution-id'),
      rootExecutionId: hdr('x-allen-root-execution-id'),
    };
  };

  // POST /api/chat/spawn-agent — Execute spawn_agent tool via API (used by Allen MCP server)
  router.post('/spawn-agent', async (req: Request, res: Response) => {
    try {
      const {
        agent_name, prompt, repo_path, session_id,
        // Spawn-tree linkage forwarded from the Allen MCP server's env.
        // The MCP server reads ALLEN_PARENT_EXECUTION_ID / _CALLER /
        // _ROOT_EXECUTION_ID from its subprocess env and puts them here so
        // chat-tools can build the caller-qualified workflowName and set
        // parentExecutionId / rootExecutionId on the spawned row.
        parent_execution_id, parent_caller, root_execution_id,
      } = req.body;
      if (!agent_name || !prompt) return res.status(400).json({ error: 'agent_name and prompt are required' });
      const result = await executeChatTool('spawn_agent', {
        agent_name, prompt, repo_path, session_id,
        parent_execution_id, parent_caller, root_execution_id,
      }, db, readToolContext(req));
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/tools/:toolName — Generic chat-tool dispatcher.
  // The Allen MCP server forwards unknown tool calls here, so any tool
  // registered in chatTools[] (including the phase-4 meta tools like
  // create_team, create_agent, etc.) is auto-callable from spawned agents
  // without needing a hardcoded case in allen-mcp-server.ts.
  // Permission gating happens INSIDE each tool's execute() function — meta
  // tools check the active session's currentAgent against an allow-list.
  router.post('/tools/:toolName', async (req: Request, res: Response) => {
    try {
      const toolName = param(req, 'toolName');
      const args = (req.body ?? {}) as Record<string, unknown>;
      const result = await executeChatTool(toolName, args, db, readToolContext(req));
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/delegate — Execute delegation tools via API (used by Allen MCP server)
  router.post('/delegate', async (req: Request, res: Response) => {
    try {
      const { tool, agent_name, task, context, conversation_id, answer } = req.body;
      const ctx = readToolContext(req);

      // Route to the right tool
      if (tool === 'answer_delegator' || tool === 'answer_question') {
        if (!conversation_id || !answer) return res.status(400).json({ error: 'conversation_id and answer are required' });
        const result = await executeChatTool('answer_delegator', { conversation_id, answer }, db, ctx);
        return res.json(result);
      }

      // Default: delegate_to_agent
      if (!agent_name || !task) return res.status(400).json({ error: 'agent_name and task are required' });
      const result = await executeChatTool('delegate_to_agent', { agent_name, task, context, conversation_id }, db, ctx);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/delegations/:conversationId/activity — Persisted thread-event log
  // for a delegation, used by useChat.ts on refresh so running delegations
  // don't lose their visible progress when the client reloads. Returns
  // oldest-first so the UI can append in natural order. `since` filters to
  // events after that ISO timestamp; `limit` caps at 2000 (default 500).
  router.get('/delegations/:conversationId/activity', async (req: Request, res: Response) => {
    try {
      const conversationId = param(req, 'conversationId');
      const sinceRaw = req.query.since as string | undefined;
      const limitRaw = req.query.limit as string | undefined;
      const since = sinceRaw ? new Date(sinceRaw) : undefined;
      const limit = limitRaw ? Math.max(1, Math.min(parseInt(limitRaw, 10) || 500, 2000)) : 500;
      const { AgentActivityService } = await import('../services/agent-activity.service.js');
      const service = new AgentActivityService(db);
      const events = await service.listForRef(conversationId, { since, limit });
      console.log('[chat/activity] conv', conversationId, 'since', sinceRaw ?? '-', '→', events.length, 'rows');
      res.json({ events });
    } catch (err: unknown) {
      console.error('[chat/activity] failed:', (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/delegation/:id/status — Quick status check (non-blocking)
  router.get('/delegation/:id/status', async (req: Request, res: Response) => {
    try {
      const { AgentConversationService } = await import('../services/agent-conversation.service.js');
      const service = new AgentConversationService(db);
      const conv = await service.get(param(req, 'id'));
      if (!conv) return res.status(404).json({ error: 'Not found' });
      if (conv.status === 'active') {
        return res.json({ conversation_id: conv._id?.toString(), status: 'active', agent: conv.toAgent, turn_count: conv.turnCount });
      }
      if (conv.status === 'waiting_for_answer' && conv.pendingQuestion?.status === 'pending') {
        return res.json({
          conversation_id: conv._id?.toString(),
          status: 'waiting_for_answer',
          agent: conv.toAgent,
          question: conv.pendingQuestion.question,
          from_agent: conv.pendingQuestion.fromAgent,
        });
      }
      res.json({
        conversation_id: conv._id?.toString(),
        status: conv.status,
        agent: conv.toAgent,
        response: conv.response ?? conv.summary ?? '',
        summary: conv.summary,
        cost_usd: conv.costUsd,
        duration_ms: conv.durationMs,
        turn_count: conv.turnCount,
        hint: conv.status === 'completed' ? `To continue, call delegate_to_agent with conversation_id` : undefined,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions — List all sessions. Optional ?ownerUserId=<id>
  // to filter by owner, or ?ownerUserId=none for unowned/legacy sessions.
  router.get('/sessions', async (req: Request, res: Response) => {
    try {
      const raw = req.query.ownerUserId;
      const ownerParam = typeof raw === 'string' ? raw : undefined;
      const filter = ownerParam === undefined
        ? undefined
        : { ownerUserId: ownerParam === 'none' ? null : ownerParam };
      const sessions = await chatService.listSessions(filter);
      res.json(sessions);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/providers — List available LLM providers
  router.get('/providers', (_req: Request, res: Response) => {
    res.json(chatService.getProviders());
  });

  router.get('/slash-commands', async (req: Request, res: Response) => {
    try {
      const provider = String(req.query.provider ?? 'codex') === 'claude-cli' ? 'claude-cli' : 'codex';
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      let cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
      if (!cwd && sessionId) {
        const session = await db.collection('chat_sessions').findOne({ _id: new ObjectId(sessionId) });
        cwd = typeof session?.repoPath === 'string' ? session.repoPath : undefined;
      }
      res.json(listSlashCommands(provider as SlashCommandProvider, cwd));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/sessions — Create new session
  router.post('/sessions', async (req: AuthedRequest, res: Response) => {
    try {
      const { provider, model, agentOverrides } = req.body ?? {};
      const repoId = typeof req.body?.repoId === 'string' ? req.body.repoId : undefined;
      const sender = await readSender(req);
      const owner = sender
        ? { userId: sender.userId, name: sender.name, email: sender.email }
        : undefined;
      const session = await chatService.createSession(provider, model, 'ui', undefined, agentOverrides, repoId, owner);
      res.status(201).json(session);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions/:id — Get session with messages
  router.get('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const session = await chatService.getSession(id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions/:id/messages — Paginated messages
  router.get('/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const before = req.query.before as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const result = await chatService.getMessages(sessionId, before, limit);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/sessions/:id/code-diffs', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const messageId = typeof req.query.messageId === 'string' ? req.query.messageId : '';
      const filter: Record<string, unknown> = { chatSessionId: sessionId };
      if (messageId) filter.parentMessageId = messageId;
      const snapshots = await db.collection('chat_code_diff_snapshots')
        .find(filter)
        .sort({ createdAt: 1 })
        .toArray();
      const responseSnapshots: Record<string, unknown>[] = snapshots.map(snapshot => ({ ...snapshot }));
      if (!messageId && ObjectId.isValid(sessionId)) {
        const session = await db.collection('chat_sessions').findOne(
          { _id: new ObjectId(sessionId) },
          { projection: { archivedWorkspace: 1 } },
        );
        let archivedWorkspace = (session?.archivedWorkspace && typeof session.archivedWorkspace === 'object'
          ? session.archivedWorkspace
          : null) as Record<string, unknown> | null;
        if (!archivedWorkspace) {
          const execution = await db.collection('executions').findOne(
            { 'meta.chatSessionId': sessionId, 'meta.workspaceId': { $type: 'string' } },
            { sort: { updatedAt: -1, completedAt: -1, startedAt: -1 }, projection: { meta: 1 } },
          );
          const workspaceId = typeof execution?.meta?.workspaceId === 'string' ? execution.meta.workspaceId : '';
          const workspace = ObjectId.isValid(workspaceId)
            ? await db.collection('workspaces').findOne({ _id: new ObjectId(workspaceId) })
            : null;
          if (workspace) {
            archivedWorkspace = {
              id: String(workspace._id),
              name: workspace.name,
              repoId: workspace.repoId,
              repoName: workspace.repoName,
              repoPath: workspace.repoPath,
              branch: workspace.branch,
              baseBranch: workspace.baseBranch,
              prNumber: workspace.prNumber,
              prUrl: workspace.prUrl,
              archivedAt: workspace.updatedAt,
            };
          }
        }
        const prClauses: Record<string, unknown>[] = [];
        if (typeof archivedWorkspace?.prUrl === 'string') prClauses.push({ url: archivedWorkspace.prUrl });
        if (typeof archivedWorkspace?.id === 'string') prClauses.push({ workspaceId: archivedWorkspace.id });
        if (typeof archivedWorkspace?.repoId === 'string' && typeof archivedWorkspace?.prNumber === 'number') {
          prClauses.push({ repoId: archivedWorkspace.repoId, number: archivedWorkspace.prNumber });
        }
        const pr = prClauses.length > 0
          ? await db.collection('pull_requests').findOne({ $or: prClauses }, { sort: { updatedAt: -1 } })
          : null;
        const diffRepoPath = pr?.repoPath ?? archivedWorkspace?.repoPath;
        const diffBranch = pr?.branch ?? archivedWorkspace?.branch;
        const diffBaseBranch = pr?.baseBranch ?? archivedWorkspace?.baseBranch;
        if (diffRepoPath && diffBranch && diffBaseBranch) {
          const prDiff = await new PullRequestService(db).getDiff(String(diffRepoPath), String(diffBranch), String(diffBaseBranch));
          const files = (prDiff.files ?? [])
            .filter(file => file.diff?.trim() || file.modifiedContent?.trim())
            .map(file => {
              const counts = file.diff.split('\n').reduce((acc, line) => {
                if (line.startsWith('+++') || line.startsWith('---')) return acc;
                if (line.startsWith('+')) acc.additions += 1;
                else if (line.startsWith('-')) acc.deletions += 1;
                return acc;
              }, { additions: 0, deletions: 0 });
              return {
                ...file,
                status: file.diff.includes('new file mode') ? 'added' : file.diff.includes('deleted file mode') ? 'deleted' : 'modified',
                additions: counts.additions,
                deletions: counts.deletions,
              };
            });
          if (files.length > 0) {
            responseSnapshots.push({
              chatSessionId: sessionId,
              parentMessageId: null,
              workspaceId: String(pr?.workspaceId ?? archivedWorkspace?.id ?? pr?._id ?? 'archived-workspace'),
              workspaceName: archivedWorkspace?.name ?? pr?.title ?? (pr?.number ? `PR #${pr.number}` : 'archived workspace'),
              baseBranch: diffBaseBranch,
              mode: 'branch',
              source: 'pull_request_archive_fallback',
              files,
              createdAt: pr?.updatedAt ?? new Date(),
              updatedAt: new Date(),
            });
          }
        }
      }
      res.json({ snapshots: responseSnapshots });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/sessions/:id/code-diffs', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const parentMessageId = typeof req.body.messageId === 'string' ? req.body.messageId : '';
      const executionIds = Array.isArray(req.body.executionIds) ? req.body.executionIds.map(String).filter(Boolean) : [];
      const requestedMode = req.body.mode === 'branch' || req.body.mode === 'working' || req.body.mode === 'auto' || req.body.mode === 'workspace'
        ? req.body.mode as WorkspaceDiffMode
        : 'workspace';
      const workspaceRefs = Array.isArray(req.body.workspaces)
        ? req.body.workspaces
          .map((item: Record<string, unknown>) => ({
            id: typeof item?.id === 'string' ? item.id : '',
            name: typeof item?.name === 'string' ? item.name : null,
          }))
          .filter((item: { id: string }) => item.id)
        : [];
      if (!parentMessageId) return res.status(400).json({ error: 'messageId is required' });
      if (workspaceRefs.length === 0) return res.status(400).json({ error: 'workspaces are required' });

      const collection = db.collection('chat_code_diff_snapshots');
      const snapshots: Record<string, unknown>[] = [];
      for (const ref of workspaceRefs) {
        const existing = await collection.findOne({ chatSessionId: sessionId, parentMessageId, workspaceId: ref.id });
        if (existing) {
          snapshots.push(existing);
          continue;
        }
        const diff = await workspaceManager.getDiff(ref.id, { mode: requestedMode });
        const files = diff.files.filter(file => file.diff?.trim() || file.modifiedContent?.trim());
        if (files.length === 0) continue;
        const now = new Date();
        const snapshot = {
          chatSessionId: sessionId,
          parentMessageId,
          executionIds,
          workspaceId: ref.id,
          workspaceName: ref.name,
          baseBranch: diff.baseBranch,
          mode: diff.mode,
          files,
          createdAt: now,
          updatedAt: now,
        };
        const result = await collection.insertOne(snapshot);
        snapshots.push({ ...snapshot, _id: result.insertedId });
      }
      res.json({ snapshots });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/sessions/:id/messages — Send message (SSE response)
  // Body: { content: string, agent?: string }
  // When `agent` is provided, the message is routed through that team agent's system prompt.
  router.post('/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const { content, agent } = req.body;
      const cwd = typeof req.body.cwd === 'string' ? req.body.cwd : undefined;
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content is required' });
      }
      // sendMessage handles SSE headers and streaming
      const sender = await readSender(req as AuthedRequest);
      await chatService.sendMessage(sessionId, content, res, agent, cwd, sender);
    } catch (err: unknown) {
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  // GET /api/chat/sessions/:id/queue — Server-side queued chat messages
  router.get('/sessions/:id/queue', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      res.json(await chatService.listQueuedMessages(sessionId));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/sessions/:id/queue — Queue a message after the current turn
  router.post('/sessions/:id/queue', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const { content, agent } = req.body;
      const cwd = typeof req.body.cwd === 'string' ? req.body.cwd : undefined;
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content is required' });
      }
      const sender = await readSender(req as AuthedRequest);
      const item = await chatService.enqueueQueuedMessage(sessionId, {
        content,
        agent: typeof agent === 'string' ? agent : undefined,
        cwd,
      }, sender);
      res.status(201).json(item);
    } catch (err: unknown) {
      const message = (err as Error).message;
      res.status(message.includes('Queue limit') ? 409 : 500).json({ error: message });
    }
  });

  // PATCH /api/chat/sessions/:id/queue/:queueId — Edit/pause/resume a queued message
  router.patch('/sessions/:id/queue/:queueId', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const queueId = param(req, 'queueId');
      const body: { content?: string; status?: 'queued' | 'editing' } = {};
      if (typeof req.body.content === 'string') body.content = req.body.content;
      if (req.body.status === 'queued' || req.body.status === 'editing') body.status = req.body.status;
      if (!body.content && !body.status) {
        return res.status(400).json({ error: 'content or status is required' });
      }
      res.json(await chatService.updateQueuedMessage(sessionId, queueId, body));
    } catch (err: unknown) {
      const message = (err as Error).message;
      res.status(message.includes('not found') ? 404 : 500).json({ error: message });
    }
  });

  // DELETE /api/chat/sessions/:id/queue/:queueId — Remove a queued message
  router.delete('/sessions/:id/queue/:queueId', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const queueId = param(req, 'queueId');
      await chatService.deleteQueuedMessage(sessionId, queueId);
      res.status(204).end();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions/:id/stream — Subscribe to active stream (reconnection)
  router.get('/sessions/:id/stream', (req: Request, res: Response) => {
    const sessionId = param(req, 'id');
    console.log('[chat/stream] subscribe session', sessionId);
    chatService.subscribeToStream(sessionId, res);
  });

  // GET /api/chat/sessions/:id/streaming — Check if session is streaming
  router.get('/sessions/:id/streaming', (req: Request, res: Response) => {
    const sessionId = param(req, 'id');
    const streaming = chatService.isStreaming(sessionId);
    console.log('[chat/isStreaming]', sessionId, '→', streaming);
    res.json({ streaming });
  });

  // POST /api/chat/sessions/:id/generate-title — (Re)generate a title for an
  // existing session using the LLM. Useful for manual backfill of sessions
  // that were created before auto-title was implemented.
  router.post('/sessions/:id/generate-title', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const title = await chatService.generateTitleForSession(sessionId);
      if (!title) return res.status(404).json({ error: 'No messages found for session' });
      res.json({ title });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PATCH /api/chat/sessions/:id — Update session
  // Accepts: title, status, provider, model, agentOverrides
  router.patch('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const { title, status, provider, model, agentOverrides } = req.body ?? {};
      const session = await chatService.updateSession(id, { title, status, provider, model, agentOverrides });
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/embeddings/backfill — Generate embeddings for learnings that don't have them
  router.post('/embeddings/backfill', async (_req: Request, res: Response) => {
    try {
      const { backfillEmbeddings } = await import('../services/embedding.service.js');
      const count = await backfillEmbeddings(db);
      res.json({ indexed: count });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions/:id/logs — Get execution traces for a session
  router.get('/sessions/:id/logs', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const limit = Math.min(parseInt(req.query.limit as string ?? '50', 10), 200);
      const logs = await db.collection('chat_logs')
        .find({ sessionId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      logs.reverse();
      res.json(logs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/logs — Get all chat logs (cross-session)
  router.get('/logs', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string ?? '50', 10), 200);
      const status = req.query.status as string | undefined;
      const filter: Record<string, unknown> = {};
      if (status) filter.status = status;

      const logs = await db.collection('chat_logs')
        .find(filter)
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      res.json(logs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/logs/:logId — Get single log with full trace
  router.get('/logs/:logId', async (req: Request, res: Response) => {
    try {
      const { ObjectId } = await import('mongodb');
      const log = await db.collection('chat_logs').findOne({ _id: new ObjectId(param(req, 'logId')) });
      if (!log) return res.status(404).json({ error: 'Log not found' });
      res.json(log);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions/:id/threads — Get agent-to-agent conversations for a session
  router.get('/sessions/:id/threads', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const { AgentConversationService } = await import('../services/agent-conversation.service.js');
      const service = new AgentConversationService(db);
      const threads = await service.forSession(sessionId);
      res.json(threads);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/ask-caller — Agent asks its caller a question (blocks until answered)
  router.post('/ask-caller', async (req: Request, res: Response) => {
    try {
      const { question, conversation_id } = req.body;
      if (!question) return res.status(400).json({ error: 'question is required' });
      // conversation_id can come from the request or from the active session context
      const result = await executeChatTool('ask_delegator', { question, _conversation_id: conversation_id }, db, readToolContext(req));
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/ask-user — Store a question for the user (non-blocking)
  router.post('/ask-user', async (req: Request, res: Response) => {
    try {
      const { question } = req.body;
      if (!question) return res.status(400).json({ error: 'question is required' });
      // Just store the question — don't block. The in-process ask_user tool handles blocking.
      // For MCP calls, the MCP handler polls /api/chat/ask-user/status
      const { resolveActiveSession } = await import('../services/chat-tools.js');
      const activeCtx = resolveActiveSession(readToolContext(req));
      if (!activeCtx) return res.status(400).json({ error: 'No active session' });
      const fromAgent = activeCtx.currentAgent ?? 'assistant';
      const sessionId = activeCtx.chatSessionId;
      const { ObjectId } = await import('mongodb');
      await db.collection('chat_sessions').updateOne(
        { _id: new ObjectId(sessionId) },
        { $set: { pendingUserQuestion: { question, fromAgent, status: 'pending', askedAt: new Date() } } },
      );
      activeCtx.broadcastEvent('user_question', { question, fromAgent });
      res.json({ stored: true, message: 'Question sent to user.' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/ask-user/status — Poll for user's answer
  router.get('/ask-user/status', async (req: Request, res: Response) => {
    try {
      const { resolveActiveSession } = await import('../services/chat-tools.js');
      const activeCtx = resolveActiveSession(readToolContext(req));
      if (!activeCtx) return res.json({ status: 'no_session' });
      const sessionId = activeCtx.chatSessionId;
      const { ObjectId } = await import('mongodb');
      const session = await db.collection('chat_sessions').findOne({ _id: new ObjectId(sessionId) });
      const pq = session?.pendingUserQuestion;
      if (!pq) return res.json({ status: 'no_question' });
      if (pq.status === 'answered' && pq.answer) {
        // Clear the question
        await db.collection('chat_sessions').updateOne(
          { _id: new ObjectId(sessionId) },
          { $set: { pendingUserQuestion: null } },
        );
        return res.json({ status: 'answered', answer: pq.answer });
      }
      res.json({ status: 'pending' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/sessions/:id/agent-answer — User answers a question from an agent (ask_user)
  router.post('/sessions/:id/agent-answer', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const { answer } = req.body;
      if (!answer) return res.status(400).json({ error: 'answer is required' });

      const { ObjectId } = await import('mongodb');
      const session = await db.collection('chat_sessions').findOne({ _id: new ObjectId(sessionId) });
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!session.pendingUserQuestion || session.pendingUserQuestion.status !== 'pending') {
        return res.status(400).json({ error: 'No pending question' });
      }

      await db.collection('chat_sessions').updateOne(
        { _id: new ObjectId(sessionId) },
        {
          $set: {
            'pendingUserQuestion.status': 'answered',
            'pendingUserQuestion.answer': answer,
            'pendingUserQuestion.answeredAt': new Date(),
          },
        },
      );

      const authUser = (req as AuthedRequest).user;
      const workflowInput = await submitChatAnswerToPendingWorkflow(
        sessionId,
        answer,
        authUser?.sub ?? 'chat',
      ).catch((err) => {
        console.warn('[chat.agent-answer] workflow input bridge failed:', (err as Error).message);
        return {
          forwarded: false,
          reason: 'bridge_error',
          error: (err as Error).message,
        };
      });

      // Fan out to every other tab subscribed to this session's stream so
      // their ask_user popup clears immediately. The ask_user tool's poll
      // loop will still fire its own `user_answer` when it detects the
      // DB change, but its interval grows to 30s — too slow for a good
      // multi-tab experience.
      chatService.broadcastToSession(sessionId, 'user_answer', { answer, workflowInput });

      res.json({ answered: true, workflowInput });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/sessions/:id/automation-message — Append a message from an
  // automation agent (e.g. a cron-dispatched agent posting its daily briefing).
  // Auth is enforced by the global requireAuth middleware registered at
  // app.use('/api', requireAuth) in app.ts — there is no inline middleware here.
  router.post('/sessions/:id/automation-message', async (req: Request, res: Response) => {
    // Rate-limit: 60 req/min per authenticated caller
    const callerId = (req as AuthedRequest).user?.sub ?? req.ip ?? 'unknown';
    if (!checkAutomationMsgRateLimit(callerId)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const id = param(req, 'id');
    const { role, content } = req.body as { role?: string; content?: string };
    if (!role || !['user', 'assistant'].includes(role)) {
      return res.status(400).json({ error: 'role must be one of: user, assistant' });
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'content is required' });
    }
    if (content.length > 1_000_000) {
      return res.status(400).json({ error: 'content exceeds maximum length' });
    }
    try {
      const result = await chatService.appendAutomationMessage(id, role as 'user' | 'assistant', content);
      return res.json({ inserted: true, messageId: result.messageId });
    } catch (err: unknown) {
      const message = (err as Error).message;
      if (message === 'Session not found') {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (message === 'Not an automation session') {
        return res.status(403).json({ error: 'Not an automation session' });
      }
      // Do not leak internal error details to the client
      logger.error('automation-message: unexpected error', { sessionId: id, error: (err as Error).message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/chat/sessions/:id — Delete session
  router.delete('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      await chatService.deleteSession(id);
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/query-database — Generic read-only MongoDB query.
  // Used by the allen_query_database MCP tool so any collection can be queried
  // without maintaining a hard-coded allowlist. Accepts collection, filter,
  // projection, sort, and limit. Results are capped at 100 documents.
  router.post('/query-database', async (req: Request, res: Response) => {
    try {
      const { collection, filter, projection, sort, limit } = req.body as {
        collection?: string;
        filter?: Record<string, unknown>;
        projection?: Record<string, unknown>;
        sort?: Record<string, unknown>;
        limit?: number;
      };
      if (!collection || typeof collection !== 'string') {
        return res.status(400).json({ error: 'collection is required' });
      }
      const cap = Math.min(Number(limit) || 20, 100);
      const cursor = db
        .collection(collection)
        .find(filter ?? {}, { projection: projection ?? {} })
        .sort((sort ?? {}) as Record<string, 1 | -1>)
        .limit(cap);
      const docs = await cursor.toArray();
      res.json(docs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
