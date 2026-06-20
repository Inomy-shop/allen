import { Router, type Request, type Response } from 'express';
import { param } from '../types.js';
import { logger } from '../logger.js';
import { ChatService, cancelChatSession, type ChatMessageSender, type ChatQueueItem } from '../services/chat.service.js';
import { executeChatTool } from '../services/chat-tools.js';
import { ExecutionService } from '../services/execution.service.js';
import { InterventionService } from '../services/intervention.service.js';
import { PullRequestService } from '../services/pull-request.service.js';
import { WorkspaceManager, type WorkspaceDiffMode } from '../services/workspace.service.js';
import { ObjectId, type Db } from 'mongodb';
import { UserService } from '../services/user.service.js';
import type { AuthedRequest } from '../middleware/requireAuth.js';
import { listSlashCommands, type SlashCommandProvider } from '../services/slash-commands.js';
import { isClaudeFamilyProvider } from '../services/chat-providers.js';
import { buildHumanResumeInput, type HumanInterventionPayload } from '@allen/engine';
import { ChatContextPacketService } from '../services/context/core/chat-context-packet.service.js';

// Simple in-memory rate limiter for the automation-message endpoint.
// Limits each authenticated caller (by sub) to 60 requests per minute.
const _automationMsgRateLimit = new Map<string, { count: number; windowStart: number }>();
const AUTOMATION_MSG_RATE_LIMIT = 60;
const AUTOMATION_MSG_RATE_WINDOW_MS = 60_000;

function diffFileMetadata(file: unknown): unknown {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return file;
  const row = file as Record<string, unknown>;
  return {
    ...row,
    diff: '',
    originalContent: '',
    modifiedContent: '',
  };
}

function diffSnapshotMetadata(snapshot: Record<string, unknown>): Record<string, unknown> {
  return {
    ...snapshot,
    files: Array.isArray(snapshot.files) ? snapshot.files.map(diffFileMetadata) : snapshot.files,
  };
}

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
      const fieldValues = { [fieldName]: answer };
      const payload = {
        human_input: buildHumanResumeInput(toHumanInterventionPayload(intervention), {
          ...fieldValues,
          __human_meta: { actionId: 'answer', decision: 'answer' },
        }),
      };
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
        answer: JSON.stringify(fieldValues),
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

  // POST /api/chat/sessions/:id/steer — Inject a message into the running agent mid-turn.
  // Falls back to the existing queue if no active turn / non-persistent path.
  // Auth is enforced by the global requireAuth middleware registered at
  // app.use('/api', requireAuth) in app.ts — there is no inline middleware here.
  router.post('/sessions/:id/steer', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const { content } = req.body ?? {};
      if (!content || typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'content is required' });
      }
      const sender = await readSender(req as AuthedRequest);
      const result = await chatService.steerRunningAgent(sessionId, content, sender);
      if ('steered' in result) {
        return res.json({ steered: true, messageId: (result as { steered: true; messageId: string }).messageId });
      }
      const queued = result as { queued: true; item: ChatQueueItem };
      return res.json({ queued: true, item: queued.item });
    } catch (err: unknown) {
      const message = (err as Error).message;
      if (message.includes('Session not found')) return res.status(404).json({ error: message });
      if (message.includes('Invalid session id')) return res.status(400).json({ error: message });
      if (message.includes('Queue limit')) return res.status(409).json({ error: message });
      res.status(500).json({ error: message });
    }
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
        agent_name, prompt, context_query, repo_path, session_id,
        // Spawn-tree linkage forwarded from the Allen MCP server's env.
        // The MCP server reads ALLEN_PARENT_EXECUTION_ID / _CALLER /
        // _ROOT_EXECUTION_ID from its subprocess env and puts them here so
        // chat-tools can build the caller-qualified workflowName and set
        // parentExecutionId / rootExecutionId on the spawned row.
        parent_execution_id, parent_caller, root_execution_id,
        artifact_root_type, artifact_root_id,
        repo_knowledge_packet_id, repo_knowledge_repo_id, repo_knowledge_index_id,
        repo_knowledge_repo_name, repo_knowledge_freshness,
      } = req.body;
      if (!agent_name || !prompt) return res.status(400).json({ error: 'agent_name and prompt are required' });
      const result = await executeChatTool('spawn_agent', {
        agent_name, prompt, context_query, repo_path, session_id,
        parent_execution_id, parent_caller, root_execution_id,
        artifact_root_type, artifact_root_id,
        repo_knowledge_packet_id, repo_knowledge_repo_id, repo_knowledge_index_id,
        repo_knowledge_repo_name, repo_knowledge_freshness,
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
  router.get('/providers', async (_req: Request, res: Response) => {
    try {
      res.json(await chatService.getProviders());
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/slash-commands', async (req: Request, res: Response) => {
    try {
      const rawProvider = String(req.query.provider ?? 'codex');
      let family: SlashCommandProvider | null = null;
      if (rawProvider === 'codex') family = 'codex';
      else if (isClaudeFamilyProvider(rawProvider)) family = 'claude';
      if (!family) return res.json([]);

      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      let cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
      if (!cwd && sessionId) {
        const session = await db.collection('chat_sessions').findOne({ _id: new ObjectId(sessionId) });
        cwd = typeof session?.repoPath === 'string' ? session.repoPath : undefined;
      }
      res.json(listSlashCommands(family, cwd));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/sessions — Create new session
  router.post('/sessions', async (req: AuthedRequest, res: Response) => {
    try {
      const { provider, model, agentOverrides } = req.body ?? {};
      const repoId = typeof req.body?.repoId === 'string' ? req.body.repoId : undefined;
      const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId.trim() : undefined;
      // Validate workspaceId BEFORE creating the session to avoid orphaned sessions
      if (workspaceId && !ObjectId.isValid(workspaceId)) {
        return res.status(400).json({ error: 'Invalid workspaceId' });
      }
      const sender = await readSender(req);
      const owner = sender
        ? { userId: sender.userId, name: sender.name, email: sender.email }
        : undefined;
      const session = await chatService.createSession(provider, model, 'ui', undefined, agentOverrides, repoId, owner);
      if (workspaceId) {
        // ObjectId.isValid already checked above
        try {
          const ws = await workspaceManager.get(workspaceId);
          if (!ws) return res.status(404).json({ error: 'Workspace not found' });
          await workspaceManager.linkChat(workspaceId, session._id!.toString());
          // Re-fetch session to include snapshot fields
          const linked = await chatService.getSession(session._id!.toString());
          return res.status(201).json(linked);
        } catch (linkErr) {
          // Log but don't fail — session is created, workspace linking is best-effort
          console.error('Failed to link workspace to session:', linkErr);
        }
      }
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
  // Hidden watcher-trigger messages are excluded by default. Pass
  // ?includeHidden=true to include them for debugging.
  router.get('/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const before = req.query.before as string | undefined;
      const includeHidden = req.query.includeHidden === 'true';
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const result = await chatService.getMessages(sessionId, before, limit, includeHidden);
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
      const responseSnapshots: Record<string, unknown>[] = snapshots.map(snapshot => diffSnapshotMetadata({ ...snapshot }));
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
            .filter(file => file.path && ((file.additions ?? 0) > 0 || (file.deletions ?? 0) > 0 || file.status))
            .map(file => {
              const counts = file.diff.split('\n').reduce((acc, line) => {
                if (line.startsWith('+++') || line.startsWith('---')) return acc;
                if (line.startsWith('+')) acc.additions += 1;
                else if (line.startsWith('-')) acc.deletions += 1;
                return acc;
              }, { additions: 0, deletions: 0 });
              return {
                ...file,
                status: file.status ?? (file.diff.includes('new file mode') ? 'added' : file.diff.includes('deleted file mode') ? 'deleted' : 'modified'),
                additions: file.additions ?? counts.additions,
                deletions: file.deletions ?? counts.deletions,
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
      res.json({ snapshots: responseSnapshots.map(snapshot => diffSnapshotMetadata(snapshot)) });
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
          snapshots.push(diffSnapshotMetadata(existing as Record<string, unknown>));
          continue;
        }
        const diff = await workspaceManager.getDiff(ref.id, { mode: requestedMode, anchorToCreation: requestedMode === 'workspace' });
        const files = diff.files.filter(file => file.path && (file.additions > 0 || file.deletions > 0 || file.status));
        if (files.length === 0) continue;
        const now = new Date();
        const snapshot = {
          chatSessionId: sessionId,
          parentMessageId,
          executionIds,
          workspaceId: ref.id,
          workspaceName: ref.name,
          baseBranch: diff.baseBranch,
          baseCommit: diff.baseCommit,
          mode: diff.mode,
          files,
          createdAt: now,
          updatedAt: now,
        };
        const result = await collection.insertOne(snapshot);
        snapshots.push(diffSnapshotMetadata({ ...snapshot, _id: result.insertedId }));
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

  // GET /api/chat/sessions/:id/context-usage — repo context attempts captured
  // for top-level chat-agent turns, grouped by assistant message id.
  router.get('/sessions/:id/context-usage', async (req: Request, res: Response) => {
    try {
      res.json(await new ChatContextPacketService(db).getChatContextUsageReport(param(req, 'id')));
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

  // POST /api/chat/sessions/:id/watcher-trigger — Internal endpoint called by
  // WatcherService when an execution reaches a terminal/waiting state. Injects
  // a hidden chat message that triggers the Assistant.
  // Auth is enforced by the global requireAuth middleware. The service-to-service
  // caller validates via triggerSentForState on the watcher doc (see TDD §2.3).
  router.post('/sessions/:id/watcher-trigger', async (req: Request, res: Response) => {
    const id = param(req, 'id');
    const { executionId, triggerType, triggerContext, enforceFirstOnly } = req.body as {
      executionId?: string;
      triggerType?: string;
      triggerContext?: Record<string, unknown>;
      enforceFirstOnly?: boolean;
    };

    if (!executionId || !triggerType) {
      return res.status(400).json({ error: 'executionId and triggerType are required' });
    }

    const VALID_TRIGGER_TYPES = ['watcher_completed', 'watcher_failed', 'watcher_cancelled', 'watcher_waiting_for_input'];
    if (!VALID_TRIGGER_TYPES.includes(triggerType as string)) {
      return res.status(400).json({ error: `Invalid triggerType. Must be one of: ${VALID_TRIGGER_TYPES.join(', ')}` });
    }

    try {
      // Optional: enforce that no trigger for this executionId exists yet
      if (enforceFirstOnly) {
        const existingTrigger = await db.collection('chat_messages').findOne({
          sessionId: id,
          triggerType: { $regex: '^watcher_' },
          'triggerContext.executionId': executionId,
        });
        if (existingTrigger) {
          return res.status(409).json({ error: `Trigger already sent for execution ${executionId}` });
        }
      }

      const result = await chatService.appendWatcherTrigger(id, triggerType as string, triggerContext ?? {});
      return res.status(201).json({ inserted: true, messageId: result.messageId });
    } catch (err: unknown) {
      const message = (err as Error).message;
      if (message === 'Session not found') {
        return res.status(404).json({ error: 'Session not found' });
      }
      logger.error('watcher-trigger: unexpected error', { sessionId: id, executionId, error: message });
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
